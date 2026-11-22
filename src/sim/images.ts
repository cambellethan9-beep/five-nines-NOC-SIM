// NetSmart OS (NSOS) images: what's on flash, what's running, booting (boot system, fallback to the first image on
// flash, ROMMON when nothing boots), and the releases available for each platform.

import type { Network } from './network';
import type { Device, OsImage } from './types';

export interface Release {
  file: string;
  version: string;
  size: number;
}

/** Releases per platform, oldest first. The office runs the first; the last is the current recommended release. */
export const RELEASES: Record<string, Release[]> = {
  'NS-R4300': [
    { file: 'nsr4300-universalk9-mz.SPA.152-4.M3.bin', version: '15.2(4)M3', size: 89431200 },
    { file: 'nsr4300-universalk9-mz.SPA.157-3.M8.bin', version: '15.7(3)M8', size: 104223308 },
  ],
  'NS-S3600': [
    { file: 'nss3600-ipservicesk9-mz.150-2.SE4.bin', version: '15.0(2)SE4', size: 17826304 },
    { file: 'nss3600-ipservicesk9-mz.152-4.E10.bin', version: '15.2(4)E10', size: 22511104 },
  ],
  'NS-S2900': [
    { file: 'nss2900-lanbasek9-mz.150-2.SE4.bin', version: '15.0(2)SE4', size: 12153856 },
    { file: 'nss2900-lanbasek9-mz.152-7.E8.bin', version: '15.2(7)E8', size: 19841024 },
    { file: 'nss2900-lanbasek9-mz.152-7.E9.bin', version: '15.2(7)E9', size: 19906560 },
  ],
};

/** Total flash per platform. The access switches' 30 MB can't hold two images: the old one has to go first. */
export const FLASH_BYTES: Record<string, number> = { 'NS-R4300': 256487424, 'NS-S3600': 64016384, 'NS-S2900': 30998528 };

export function md5Of(file: string, corrupt = false): string {
  let h1 = 0x67452301;
  let h2 = 0xefcdab89;
  const s = file + (corrupt ? '#partial' : '');
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822507);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2) + hex(h1 ^ h2) + hex(Math.imul(h1, h2) ^ 0x5bd1e995);
}

export function imageFor(model: string, file: string): OsImage | null {
  const r = RELEASES[model]?.find((x) => x.file === file);
  return r ? { family: model, version: r.version, size: r.size, md5: md5Of(file) } : null;
}

/** Any known image by file name (for a TFTP server holding several platforms' images). */
export function anyImage(file: string): OsImage | null {
  for (const model of Object.keys(RELEASES)) {
    const i = imageFor(model, file);
    if (i) return i;
  }
  return null;
}

const DEFAULT_VERSION: Record<string, string> = { router: '15.2(4)M3', switch: '15.0(2)SE4', l3switch: '15.0(2)SE4' };

/** The NSOS version the device is running. */
export function osVersion(d: Device): string {
  const img = d.image ? d.images?.[d.image] : undefined;
  return img?.version ?? DEFAULT_VERSION[d.kind] ?? '15.2';
}

export function runningImageName(d: Device): string {
  return d.image ?? `ns${d.model.replace('NS-', '').toLowerCase()}-universalk9-mz.SPA.bin`;
}

/** Puts the platform's oldest release on flash and runs it (how the office was installed). */
export function installImage(d: Device, file?: string): void {
  const r = RELEASES[d.model];
  if (!r) return;
  const name = file ?? r[0].file;
  d.images = { ...(d.images ?? {}), [name]: imageFor(d.model, name)! };
  d.image = name;
}

export function bootable(d: Device, name: string): boolean {
  const img = d.images?.[name];
  return !!img && img.family === d.model && !img.corrupt;
}

/**
 * Which image a (re)booting device loads: `boot system` entries in order, then the first bootable image on flash.
 * null = nothing boots (ROMMON).
 */
export function chooseBootImage(net: Network, d: Device): { image: string | null; messages: string[] } {
  const messages: string[] = [];
  const entries = d.startup?.bootSystem ?? d.running.bootSystem ?? [];
  for (const e of entries) {
    const name = e.replace(/^flash:\/?/, '');
    if (bootable(d, name)) return { image: name, messages };
    const img = d.images?.[name];
    messages.push(img ? (img.family !== d.model ? `%Image ${e} is not for this platform` : `%Error: ${e} failed checksum verification`) : `%Error opening ${e} (No such file or directory)`);
  }
  const first = Object.keys(d.images ?? {}).find((n) => bootable(d, n));
  if (first && entries.length) messages.push(`Booting the first loadable image on flash: flash:${first}`);
  void net;
  return { image: first ?? null, messages };
}

export function flashUsed(d: Device): number {
  const images = Object.values(d.images ?? {}).reduce((s, i) => s + i.size, 0);
  const files = Object.values(d.files ?? {}).reduce((s, f) => s + f.text.length, 0);
  return images + files + (d.kind === 'switch' || d.kind === 'l3switch' ? 1636 : 0);
}

export function flashFree(d: Device): number {
  return (FLASH_BYTES[d.model] ?? 64016384) - flashUsed(d);
}
