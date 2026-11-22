// Configuration files: flash:, the TFTP server on the NOC PC, `archive`, `configure replace`, and loading a saved
// config back into the running config. Files keep the exact config object, so a replace or a copy to
// startup-config restores precisely what was saved; a copy into running-config merges line by line like IOS
// (which is why it never un-shuts an interface).

import { cloneConfig } from './devices';
import { formatIp, parseIp, type Ipv4 } from './ip';
import type { Network } from './network';
import { renderConfig } from './render';
import { canReach, ownsAddress } from './routing';
import type { Device, DeviceConfig, StoredFile } from './types';
import { isSwitchKind } from './types';

export type FileUrl =
  | { fs: 'flash'; name: string }
  | { fs: 'tftp'; host: Ipv4 | null; name: string | null }
  | { fs: 'running' }
  | { fs: 'startup' };

/** Parses an IOS file URL (`flash:name`, `tftp://10.10.99.50/name`, `tftp:`, `running-config`, `startup-config`). */
export function parseUrl(text: string): FileUrl | null {
  const t = text.trim();
  const low = t.toLowerCase();
  if (low === 'system:running-config' || (low.length >= 3 && 'running-config'.startsWith(low))) return { fs: 'running' };
  if (low === 'nvram:startup-config' || (low.length >= 3 && 'startup-config'.startsWith(low))) return { fs: 'startup' };
  const flash = /^flash:\/?(.*)$/i.exec(t);
  if (flash) return { fs: 'flash', name: flash[1] };
  if (low === 'tftp:') return { fs: 'tftp', host: null, name: null };
  const tftp = /^tftp:\/\/([^/]+)\/(.+)$/i.exec(t);
  if (tftp) {
    const host = parseIp(tftp[1]);
    return host === null ? null : { fs: 'tftp', host, name: tftp[2] };
  }
  return null;
}

export function urlText(u: FileUrl): string {
  switch (u.fs) {
    case 'flash':
      return `flash:${u.name}`;
    case 'tftp':
      return `tftp://${u.host === null ? '' : formatIp(u.host)}/${u.name ?? ''}`;
    case 'running':
      return 'system:running-config';
    case 'startup':
      return 'nvram:startup-config';
  }
}

export function configText(d: Device, cfg: DeviceConfig): string {
  return renderConfig(d, cfg).join('\n') + '\n';
}

/** The TFTP server at this address, if one answers from this device (udp/69). */
function tftpServer(net: Network, from: Device, host: Ipv4): Device | null {
  const server = [...net.devices.values()].find((d) => d.tftpd && net.isOnline(d) && ownsAddress(net, d, host));
  if (!server) return null;
  return canReach(net, from.id, host, { proto: 'udp', port: 69 }) ? server : null;
}

export type IoResult = { ok: true; file: StoredFile; bytes: number } | { ok: false; error: string };

export function writeFile(net: Network, d: Device, url: Extract<FileUrl, { fs: 'flash' | 'tftp' }>, cfg: DeviceConfig): IoResult {
  const file: StoredFile = { text: configText(d, cfg), config: cloneConfig(cfg), time: net.time, from: d.id };
  if (url.fs === 'flash') {
    (d.files ??= {})[url.name] = file;
    return { ok: true, file, bytes: file.text.length };
  }
  const server = url.host === null ? null : tftpServer(net, d, url.host);
  if (!server || !url.name) return { ok: false, error: `%Error opening ${urlText(url)} (Timed out)` };
  (server.files ??= {})[url.name] = file;
  return { ok: true, file, bytes: file.text.length };
}

export function readFile(net: Network, d: Device, url: Extract<FileUrl, { fs: 'flash' | 'tftp' }>): IoResult {
  if (url.fs === 'flash') {
    const f = d.files?.[url.name];
    return f ? { ok: true, file: f, bytes: f.text.length } : { ok: false, error: `%Error opening ${urlText(url)} (No such file or directory)` };
  }
  const server = url.host === null ? null : tftpServer(net, d, url.host);
  if (!server || !url.name) return { ok: false, error: `%Error opening ${urlText(url)} (Timed out)` };
  const f = server.files?.[url.name];
  return f ? { ok: true, file: f, bytes: f.text.length } : { ok: false, error: `%Error opening ${urlText(url)} (No such file)` };
}

/** Seconds a TFTP transfer of this size takes (about 25 KB/s, as IOS TFTP crawls). */
export function transferSecs(bytes: number): number {
  return Math.max(0.2, bytes / 25000 + 0.3);
}

// ---- archive -----------------------------------------------------------------------------------

function expandPath(net: Network, d: Device, path: string): string {
  const t = net.wallClock();
  const mon = t.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const stamp = `${mon}-${String(t.getUTCDate()).padStart(2, '-')}-${t.getUTCFullYear()}-${[t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join('-')}`;
  return path.replace(/\$h/g, d.running.hostname).replace(/\$t/g, stamp);
}

export function nextArchiveName(net: Network, d: Device): string | null {
  const a = d.running.archive;
  if (!a?.path) return null;
  return `${expandPath(net, d, a.path)}-${d.archiveNext ?? 1}`;
}

/** `archive config` (and write-memory / time-period): saves the running config to the archive path. */
export function archiveConfig(net: Network, d: Device): IoResult | { ok: false; error: string } {
  const name = nextArchiveName(net, d);
  if (!name) return { ok: false, error: '%Archive path is not specified' };
  const url = parseUrl(name);
  if (!url || (url.fs !== 'flash' && url.fs !== 'tftp')) return { ok: false, error: `%Error opening ${name} (Invalid path)` };
  const r = writeFile(net, d, url, d.running);
  if (!r.ok) return r;
  d.archiveNext = (d.archiveNext ?? 1) + 1;
  d.archiveAt = net.time;
  const list = (d.archiveFiles ??= []);
  list.push(name);
  const max = d.running.archive?.maximum ?? 10;
  while (list.length > max) {
    const old = list.shift()!;
    const u = parseUrl(old);
    if (u?.fs === 'flash' && d.files) delete d.files[u.name];
  }
  return r;
}

/** `time-period`: archive automatically. Call each tick. */
export function updateArchives(net: Network): void {
  for (const d of net.devices.values()) {
    const a = d.running.archive;
    if (!a?.path || !a.timePeriod || !net.isOnline(d)) continue;
    if (net.time - (d.archiveAt ?? d.bootedAt) < a.timePeriod * 60000) continue;
    archiveConfig(net, d);
    d.archiveAt = net.time;
  }
}

export function showArchive(net: Network, d: Device): string[] {
  const max = d.running.archive?.maximum ?? 10;
  const files = d.archiveFiles ?? [];
  const next = nextArchiveName(net, d);
  const lines = [`The maximum archive configurations allowed is ${max}.`];
  if (!next) return [...lines, 'Archive feature not enabled', 'Use \'archive\' command and \'path\' subcommand to specify archive location'];
  lines.push(`There are currently ${files.length} archive configurations saved.`, `The next archive file will be named ${next}`, ' Archive #  Name');
  for (let i = 0; i < max; i++) {
    const f = files[i];
    lines.push(`   ${String(i + 1).padEnd(8)} ${f ?? ''}${f && i === files.length - 1 ? ' <- Most Recent' : ''}`.trimEnd());
  }
  return lines;
}

/** `show archive config differences`: lines added (+) and removed (-), with their parent section. */
export function configDiff(d: Device, from: DeviceConfig, to: DeviceConfig): string[] {
  const keyed = (cfg: DeviceConfig) => {
    const out: string[] = [];
    let section = '';
    for (const l of renderConfig(d, cfg)) {
      if (l === '!' || l === 'end' || l.startsWith('version ')) continue;
      if (!l.startsWith(' ')) section = l;
      out.push(l.startsWith(' ') ? `${section}\u0001${l}` : l);
    }
    return out;
  };
  const a = keyed(from);
  const b = keyed(to);
  const sa = new Set(a);
  const sb = new Set(b);
  const lines = ['!Contextual Config Diffs:'];
  const printed = new Set<string>();
  const emit = (k: string, sign: string) => {
    const i = k.indexOf('\u0001');
    if (i < 0) return void lines.push(`${sign}${k}`);
    const section = k.slice(0, i);
    if (!printed.has(section + sign)) {
      lines.push(section);
      printed.add(section + sign);
    }
    lines.push(` ${sign}${k.slice(i + 2)}`);
  };
  for (const k of b) if (!sa.has(k)) emit(k, '+');
  for (const k of a) if (!sb.has(k)) emit(k, '-');
  if (lines.length === 1) return ['!No changes were found'];
  return lines;
}

// ---- flash: listing -------------------------------------------------------------------------------

export function showFlash(net: Network, d: Device): string[] {
  const family = d.model.replace('NS-', '').toLowerCase();
  const image = { name: `ns${family}-universalk9-mz.SPA.bin`, size: d.kind === 'router' ? 104223308 : 15998208 };
  const date = (t: number) => {
    const w = net.wallClock(t);
    const mon = w.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    return `${mon} ${String(w.getUTCDate()).padStart(2)} ${w.getUTCFullYear()} ${[w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':')}`;
  };
  const rows: { name: string; size: number; time: number }[] = [{ name: image.name, size: image.size, time: -86400000 * 400 }];
  if (isSwitchKind(d.kind)) rows.push({ name: 'vlan.dat', size: 1636, time: -86400000 * 30 });
  for (const [name, f] of Object.entries(d.files ?? {})) rows.push({ name, size: f.text.length, time: f.time });
  const total = d.kind === 'router' ? 256487424 : 64016384;
  const used = rows.reduce((s, r) => s + r.size, 0);
  const lines = ['Directory of flash:/', ''];
  rows.forEach((r, i) => lines.push(`${String(i + 2).padStart(5)}  -rw-  ${String(r.size).padStart(12)}  ${date(r.time)} +00:00  ${r.name}`));
  lines.push('', `${total} bytes total (${total - used} bytes free)`);
  return lines;
}
