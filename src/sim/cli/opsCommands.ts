// Operations commands: hardening (service password-encryption, enable password, security passwords, login block-for,
// exec-timeout), config backup and restore (copy to/from TFTP and flash, archive, configure replace), the MAC
// address table, and interface error counters.

import {
  archiveConfig,
  configDiff,
  configText,
  parseUrl,
  readFile,
  showArchive,
  showFlash,
  transferSecs,
  urlText,
  writeFile,
  type FileUrl,
} from '../backup';
import { cloneConfig } from '../devices';
import { encryptAll, passwordTooShort, showLogin, type7Decode } from '../hardening';
import { shortIfName } from '../ifnames';
import { formatIp, parseIp } from '../ip';
import { showMacCount, showMacTable } from '../mactable';
import { secretFromHash, showCountersErrors } from '../render';
import { canReach, l3Interfaces, ownsAddress, sourceAddressFor } from '../routing';
import { flashFree, md5Of } from '../images';
import type { DeviceConfig, DeviceKind, StoredFile } from '../types';
import { isSwitchKind } from '../types';
import { caret, commit, type Ctx, type Tree } from './context';
import { CliSession } from './session';

const HO: Record<string, string> = {
  service: 'Modify use of network based services',
  'password-encryption': 'Encrypt system passwords',
  enable: 'Modify enable password parameters',
  password: 'Assign the privileged level password (MAX of 25 characters)',
  pw: 'The UNENCRYPTED (cleartext) \'enable\' password',
  hash: 'The ENCRYPTED password string',
  '0': 'Specifies an UNENCRYPTED password will follow',
  '5': 'Specifies a MD5 HASHED secret will follow',
  '7': 'Specifies a HIDDEN password will follow',
  secret: 'Assign the privileged level secret (MAX of 25 characters)',
  security: 'Infra Security CLIs',
  passwords: 'Password Security configuration',
  'min-length': 'Minimum length of passwords',
  len: 'Minimum length of all user/enable passwords',
  login: 'Enable secure login checking',
  'block-for': 'Set quiet-mode active time period',
  secs: 'Quiet-mode active time period',
  attempts: 'Set max number of fail attempts',
  tries: 'Fail attempts',
  within: 'Watch period for fail attempts',
  window: 'Watch period',
  'quiet-mode': 'Set quiet-mode options',
  'access-class': 'Use access-list for quiet-mode',
  acl: 'Standard IP access-list name or number',
  archive: 'Archive the configuration',
  username: 'Establish User Name Authentication',
  user: 'User name',
  privilege: 'Set user privilege level',
  level: 'User privilege level',
};

const HE: Record<string, string> = {
  copy: 'Copy from one file to another',
  'running-config': 'Copy from current system configuration',
  'startup-config': 'Copy from startup configuration',
  src: 'Source URL (flash:, tftp:)',
  dst: 'Destination URL (flash:, tftp:, running-config, startup-config)',
  archive: 'manage archive files',
  config: 'perform rollback confirmation, archive configuration',
  configure: 'Enter configuration mode',
  replace: 'Replace the running-config with a new config file',
  url: 'URL of the configuration file (flash:, tftp://)',
  list: 'List the commands applied by the replace',
  force: 'Do not prompt before replacing',
  clear: 'Reset functions',
  counters: 'Clear counters on one or all interfaces',
  if: 'Interface name',
  'mac': 'MAC forwarding table',
  'address-table': 'MAC forwarding table',
  dynamic: 'dynamic entry type',
  address: 'address keyword',
  addr: '48 bit mac address',
  interface: 'interface keyword',
  vlan: 'vlan keyword',
  id: 'Vlan interface number',
  dir: 'List files on a filesystem',
  'flash:': 'Directory or file name',
};

const HS: Record<string, string> = {
  show: 'Show running system information',
  login: 'Display Secure Login Configurations and State',
  archive: 'Archive functions',
  config: 'Configuration archive',
  differences: 'Show the differences between two configuration files',
  url: 'URL of the configuration file',
  url2: 'URL of the second configuration file (default: running-config)',
  flash: 'display information about flash: file system',
  'flash:': 'display information about flash: file system',
  interfaces: 'Interface status and configuration',
  counters: 'Show interface counters',
  errors: 'Show interface error counters',
  mac: 'MAC configuration',
  'address-table': 'MAC forwarding table',
  dynamic: 'dynamic entry type',
  static: 'static entry type',
  address: 'address keyword',
  addr: '48 bit mac address',
  interface: 'interface keyword',
  if: 'Interface name',
  vlan: 'VLAN keyword',
  id: 'VLAN number',
  count: 'Count entries',
  'aging-time': 'aging-time keyword',
};

// ---- global and line hardening ------------------------------------------------------------------

export function addHardeningGlobal(t: Tree): void {
  const HB = { boot: 'Modify system boot parameters', system: 'System image file', url: 'flash:<image file>' };
  t.add('boot system <word:url>', HB, (c, a) => {
    const u = parseUrl(String(a.url));
    if (!u || u.fs !== 'flash' || !u.name) return caret(c, a['@url'] as number);
    const entry = `flash:${u.name}`;
    const list = (c.dev.running.bootSystem ??= []);
    if (!list.includes(entry)) list.push(entry);
  });
  t.add('boot system flash <word:name>', HB, (c, a) => {
    const list = (c.dev.running.bootSystem ??= []);
    const entry = `flash:${a.name}`;
    if (!list.includes(entry)) list.push(entry);
  });
  t.add('no boot system', HB, (c) => void (c.dev.running.bootSystem = []));
  t.add('no boot system <word:url>', HB, (c, a) => {
    const name = String(a.url).replace(/^flash:\/?/i, '');
    c.dev.running.bootSystem = (c.dev.running.bootSystem ?? []).filter((b) => b !== `flash:${name}`);
  });
  t.add('service password-encryption', HO, (c) => {
    c.dev.running.servicePasswordEncryption = true;
    encryptAll(c.dev.running);
  });
  // Removing it stops encrypting new passwords; the existing ones stay type 7.
  t.add('no service password-encryption', HO, (c) => void (c.dev.running.servicePasswordEncryption = false));
  const setEnablePw = (c: Ctx, pw: string, encrypted: boolean) => {
    if (c.dev.running.enableSecret === pw) {
      c.out.push('The enable password you have chosen is the same as your enable secret.', 'This is not recommended.  Re-enter the enable password.', '');
      return;
    }
    c.dev.running.enablePassword = { pw, encrypted: encrypted || !!c.dev.running.servicePasswordEncryption };
  };
  t.add('enable password <word:pw>', HO, (c, a) => {
    const short = passwordTooShort(c.dev.running, a.pw as string);
    if (short) return void c.out.push(short);
    setEnablePw(c, a.pw as string, false);
  });
  t.add('enable password 0 <word:pw>', HO, (c, a) => setEnablePw(c, a.pw as string, false));
  t.add('enable password 7 <word:hash>', HO, (c, a) => {
    const clear = type7Decode(a.hash as string);
    if (clear === null) return void c.out.push('% Invalid encrypted password');
    setEnablePw(c, clear, true);
  });
  t.add('no enable password', HO, (c) => void (c.dev.running.enablePassword = null));
  t.add('enable secret 5 <word:hash>', HO, (c, a) => void (c.dev.running.enableSecret = secretFromHash(a.hash as string)));
  const userSecret5 = (c: Ctx, user: string, level: number | undefined, hash: string) => {
    const existing = c.dev.running.users[user];
    c.dev.running.users[user] = { privilege: level ?? existing?.privilege ?? 1, secret: secretFromHash(hash), password: null };
  };
  t.add('username <word:user> secret 5 <word:hash>', HO, (c, a) => userSecret5(c, a.user as string, undefined, a.hash as string));
  t.add('username <word:user> privilege <number:level:0-15> secret 5 <word:hash>', HO, (c, a) => userSecret5(c, a.user as string, a.level as number, a.hash as string));
  t.add('security passwords min-length <number:len:0-16>', HO, (c, a) => void (c.dev.running.minPasswordLength = (a.len as number) || undefined));
  t.add('no security passwords min-length', HO, (c) => void delete c.dev.running.minPasswordLength);
  t.add('login block-for <number:secs:1-65535> attempts <number:tries:1-65535> within <number:window:1-65535>', HO, (c, a) => {
    c.dev.running.loginBlock = { blockFor: a.secs as number, attempts: a.tries as number, within: a.window as number, quietAcl: c.dev.running.loginBlock?.quietAcl ?? null };
  });
  t.add('no login block-for', HO, (c) => {
    c.dev.running.loginBlock = null;
    delete c.dev.quietUntil;
  });
  t.add('login quiet-mode access-class <word:acl>', HO, (c, a) => {
    if (!c.dev.running.loginBlock) {
      c.out.push('% Please configure "login block-for" command first');
      return;
    }
    c.dev.running.loginBlock.quietAcl = a.acl as string;
  });
  t.add('no login quiet-mode access-class', HO, (c) => {
    if (c.dev.running.loginBlock) c.dev.running.loginBlock.quietAcl = null;
  });
  t.add('archive', HO, (c) => {
    c.dev.running.archive ??= { path: null, writeMemory: false, timePeriod: null, maximum: null };
    c.s.setMode('archive');
  });
  t.add('no archive', HO, (c) => void (c.dev.running.archive = null));
}

export function addHardeningLine(t: Tree): void {
  const H = { 'exec-timeout': 'Set the EXEC timeout', min: '<0-35791>  Timeout in minutes', sec: '<0-2147483>  Timeout in seconds' };
  const line = (c: Ctx) => c.dev.running.lines[c.s.lineContext!];
  t.add('exec-timeout <number:min:0-35791>', H, (c, a) => void (line(c).execTimeout = [a.min as number, 0]));
  t.add('exec-timeout <number:min:0-35791> <number:sec:0-2147483>', H, (c, a) => void (line(c).execTimeout = [a.min as number, a.sec as number]));
  t.add('no exec-timeout', H, (c) => void delete line(c).execTimeout);
}

export function addArchiveMode(t: Tree): void {
  const H = {
    path: 'path for backups',
    url: 'flash:<name> or tftp://<host>/<name> ($h = hostname, $t = time)',
    'write-memory': 'Enable automatic backup generation during write memory',
    'time-period': 'Period of time in minutes to automatically archive the running-config',
    mins: 'Number of minutes to wait between archive creation',
    maximum: 'maximum number of backup copies',
    n: 'maximum number of backup copies',
    no: 'Negate a command or set its defaults',
    exit: 'Exit from archive configuration mode',
  };
  const a = (c: Ctx) => (c.dev.running.archive ??= { path: null, writeMemory: false, timePeriod: null, maximum: null });
  t.add('path <word:url>', H, (c, x) => {
    const u = parseUrl((x.url as string).replace(/\$[ht]/g, 'X'));
    if (!u || (u.fs !== 'flash' && u.fs !== 'tftp') || (u.fs === 'tftp' && (u.host === null || !u.name))) return caret(c, x['@url'] as number);
    a(c).path = x.url as string;
  });
  t.add('no path', H, (c) => void (a(c).path = null));
  t.add('write-memory', H, (c) => void (a(c).writeMemory = true));
  t.add('no write-memory', H, (c) => void (a(c).writeMemory = false));
  t.add('time-period <number:mins:1-525600>', H, (c, x) => void (a(c).timePeriod = x.mins as number));
  t.add('no time-period', H, (c) => void (a(c).timePeriod = null));
  t.add('maximum <number:n:1-14>', H, (c, x) => {
    if (a(c).path?.toLowerCase().startsWith('tftp:')) return void c.out.push('%Maximum not supported for this path: ' + a(c).path);
    a(c).maximum = x.n as number;
  });
  t.add('no maximum', H, (c) => void (a(c).maximum = null));
}

// ---- copy / archive / configure replace --------------------------------------------------------

/** Loads a saved configuration into the running config line by line, like IOS merges a file (never removes). */
export function mergeConfig(c: Ctx, file: StoredFile): void {
  const s = new CliSession(c.net, c.dev.id);
  s.setMode('config');
  const lines = file.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '!' || trimmed === 'end' || trimmed.startsWith('version ') || trimmed.startsWith('Building configuration') || trimmed.startsWith('Current configuration')) continue;
    const banner = /^banner (motd|login|exec) \^C(.*)$/.exec(trimmed);
    if (banner) {
      let text = banner[2];
      while (!text.endsWith('^C') && i + 1 < lines.length) text += '\n' + lines[++i];
      text = text.replace(/\^C$/, '');
      const cfg = c.dev.running;
      if (banner[1] === 'motd') cfg.bannerMotd = text;
      else if (banner[1] === 'login') cfg.bannerLogin = text;
      else cfg.bannerExec = text;
      continue;
    }
    if (!raw.startsWith(' ')) s.setMode('config');
    s.input(trimmed);
  }
  commit(c);
}

function viaInterface(c: Ctx, host: number): string {
  const src = sourceAddressFor(c.net, c.dev, host);
  const ifc = l3Interfaces(c.net, c.dev).find((i) => i.address === src);
  return ifc ? shortIfName(ifc.name).replace(/^Vl/, 'Vlan') : 'unknown';
}

type Dest = Extract<FileUrl, { fs: 'flash' | 'tftp' }>;

/** Fills in a TFTP host and file name the way IOS asks for them, then runs `then`. */
function askTftp(c: Ctx, url: Dest, defaultName: string, nameWord: 'Source' | 'Destination', then: (u: Dest, out: string[]) => void, out: string[]): void {
  if (url.fs === 'flash') {
    if (nameWord === 'Source') return then(url, out);
    c.s.ask({
      prompt: `Destination filename [${url.name || defaultName}]? `,
      handle: (ans, o) => then({ fs: 'flash', name: ans.trim() || url.name || defaultName }, o),
    });
    return;
  }
  c.s.ask({
    prompt: `Address or name of remote host [${url.host === null ? '' : formatIp(url.host)}]? `,
    handle: (ans, o) => {
      const host = ans.trim() ? parseIp(ans.trim()) : url.host;
      if (host === null) {
        o.push('%Error parsing filename (Bad IP address or host name)');
        return;
      }
      const def = url.name ?? (nameWord === 'Destination' ? defaultName : '');
      c.s.ask({
        prompt: `${nameWord} filename [${def}]? `,
        handle: (a2, o2) => {
          const name = a2.trim() || def;
          if (!name) return void o2.push('%Error parsing filename (No such file or directory)');
          then({ fs: 'tftp', host, name }, o2);
        },
      });
    },
  });
}

function saveTo(c: Ctx, cfg: DeviceConfig, dst: Dest, out: string[]): void {
  const go = (out: string[]) => {
    const r = writeFile(c.net, c.dev, dst, cfg);
    if (!r.ok) {
      out.push('.....', r.error);
      return;
    }
    const secs = dst.fs === 'tftp' ? transferSecs(r.bytes) : 0.2;
    if (dst.fs === 'tftp') out.push('!!');
    out.push(`${r.bytes} bytes copied in ${secs.toFixed(3)} secs (${Math.round(r.bytes / secs)} bytes/sec)`);
  };
  if (dst.fs === 'flash' && c.dev.files?.[dst.name]) {
    out.push('%Warning:There is a file already existing with this name');
    c.s.ask({ prompt: 'Do you want to over write? [confirm]', handle: (a, o) => void (/^(|y|yes)$/i.test(a.trim()) && go(o)) });
    return;
  }
  go(out);
}

function loadFrom(c: Ctx, src: Dest, dst: 'running' | 'startup', out: string[]): void {
  const r = readFile(c.net, c.dev, src);
  if (src.fs === 'tftp') out.push(`Accessing ${urlText(src)}...`);
  if (!r.ok) {
    out.push(r.error);
    return;
  }
  if (src.fs === 'tftp') out.push(`Loading ${src.name} from ${formatIp(src.host!)} (via ${viaInterface(c, src.host!)}): !`, `[OK - ${r.bytes} bytes]`);
  if (dst === 'startup') {
    c.dev.startup = cloneConfig(r.file.config);
    out.push('[OK]');
  } else {
    mergeConfig(c, r.file);
  }
  const secs = src.fs === 'tftp' ? transferSecs(r.bytes) : 0.1;
  out.push('', `${r.bytes} bytes copied in ${secs.toFixed(3)} secs (${Math.round(r.bytes / secs)} bytes/sec)`);
  if (dst === 'running') c.net.log(c.dev.id, `%SYS-5-CONFIG_I: Configured from ${urlText(src)} by console`);
}

function copy(c: Ctx, srcText: string, dstText: string, srcCol: number, dstCol: number): void {
  const src = parseUrl(srcText);
  if (!src) return caret(c, srcCol);
  const dst = parseUrl(dstText);
  if (!dst) return caret(c, dstCol);
  const host = c.dev.running.hostname.toLowerCase();
  if ((src.fs === 'running' || src.fs === 'startup') && (dst.fs === 'flash' || dst.fs === 'tftp')) {
    const cfg = src.fs === 'running' ? c.dev.running : c.dev.startup;
    if (!cfg) return void c.out.push('%Error opening nvram:startup-config (No such file or directory)');
    const def = dst.fs === 'flash' ? (src.fs === 'running' ? 'running-config' : 'startup-config') : `${host}-confg`;
    askTftp(c, dst, def, 'Destination', (u, out) => saveTo(c, cfg, u, out), c.out);
    return;
  }
  if ((src.fs === 'flash' || src.fs === 'tftp') && (dst.fs === 'running' || dst.fs === 'startup')) {
    askTftp(
      c,
      src,
      '',
      'Source',
      (u) =>
        c.s.ask({
          prompt: `Destination filename [${dst.fs === 'running' ? 'running-config' : 'startup-config'}]? `,
          handle: (_a, o) => loadFrom(c, u, dst.fs as 'running' | 'startup', o),
        }),
      c.out,
    );
    return;
  }
  if (src.fs === 'tftp' && dst.fs === 'flash') {
    askTftp(
      c,
      src,
      '',
      'Source',
      (u, out) => {
        const name = (u as Extract<FileUrl, { fs: 'tftp' }>).name!;
        c.s.ask({ prompt: `Destination filename [${dst.name || name}]? `, handle: (ans, o) => copyImage(c, u as Extract<FileUrl, { fs: 'tftp' }>, ans.trim() || dst.name || name, o) });
        void out;
      },
      c.out,
    );
    return;
  }
  if (src.fs === 'startup' && dst.fs === 'running') {
    if (!c.dev.startup) return void c.out.push('%Error opening nvram:startup-config (No such file or directory)');
    c.s.ask({
      prompt: 'Destination filename [running-config]? ',
      handle: (_a, o) => {
        const file: StoredFile = { text: '', config: c.dev.startup!, time: c.net.time, from: c.dev.id };
        file.text = configText(c.dev, c.dev.startup!);
        mergeConfig(c, file);
        o.push(`${file.text.length} bytes copied in 0.204 secs`);
      },
    });
    return;
  }
  if (src.fs === 'running' && dst.fs === 'startup') {
    c.s.ask({
      prompt: 'Destination filename [startup-config]? ',
      handle: (_a, o) => {
        c.dev.startup = cloneConfig(c.dev.running);
        o.push('Building configuration...', '[OK]');
      },
    });
    return;
  }
  c.out.push('%Error: Invalid copy operation');
}

/** `copy tftp: flash:` of an NSOS image: checks the server has it and that flash has room. */
function copyImage(c: Ctx, src: Extract<FileUrl, { fs: 'tftp' }>, dest: string, out: string[]): void {
  const server = [...c.net.devices.values()].find((d) => d.tftpd && c.net.isOnline(d) && src.host !== null && ownsAddress(c.net, d, src.host));
  out.push(`Accessing ${urlText(src)}...`);
  const reachable = !!server && canReach(c.net, c.dev.id, src.host!, { proto: 'udp', port: 69 });
  if (!reachable) return void out.push(`%Error opening ${urlText(src)} (Timed out)`);
  const img = server!.images?.[src.name!];
  if (!img) {
    // A config file can be copied to flash too.
    const f = server!.files?.[src.name!];
    if (!f) return void out.push(`%Error opening ${urlText(src)} (No such file)`);
    (c.dev.files ??= {})[dest] = { ...f };
    out.push(`Loading ${src.name} from ${formatIp(src.host!)} (via ${viaInterface(c, src.host!)}): !`, `[OK - ${f.text.length} bytes]`, '', `${f.text.length} bytes copied in 0.512 secs`);
    return;
  }
  const existing = c.dev.images?.[dest]?.size ?? 0;
  if (img.size > flashFree(c.dev) + existing) {
    out.push(`Loading ${src.name} from ${formatIp(src.host!)} (via ${viaInterface(c, src.host!)}): !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`, `%Error copying ${urlText(src)} (Not enough space on device)`);
    return;
  }
  (c.dev.images ??= {})[dest] = { ...img };
  (c.dev.imageTimes ??= {})[dest] = c.net.time;
  const secs = img.size / 94000;
  out.push(
    `Loading ${src.name} from ${formatIp(src.host!)} (via ${viaInterface(c, src.host!)}): ${'!'.repeat(70)}`,
    '!'.repeat(70),
    `[OK - ${img.size} bytes]`,
    '',
    `${img.size} bytes copied in ${secs.toFixed(3)} secs (${Math.round(img.size / secs)} bytes/sec)`,
  );
}

function scheduleText(c: Ctx, at: number): string {
  const w = c.net.wallClock(at);
  const hms = [w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${hms} UTC ${w.toUTCString().slice(0, 3)} ${w.toUTCString().slice(8, 11)} ${w.getUTCDate()} ${w.getUTCFullYear()}`;
}

export function addOpsExec(t: Tree): void {
  // ---- NSOS images: verify, delete, scheduled reloads ----
  t.add('verify /md5 <word:url>', { ...HE, verify: 'Verify a file', '/md5': 'Compute an MD5 signature for a file' }, (c, a) => verify(c, String(a.url), a['@url'] as number));
  t.add('verify /md5 <word:url> <word:hash>', { ...HE, verify: 'Verify a file' }, (c, a) => verify(c, String(a.url), a['@url'] as number, String(a.hash)));
  const del = (c: Ctx, a: Record<string, unknown>, force: boolean) => {
    const u = parseUrl(String(a.url));
    if (!u || u.fs !== 'flash') return caret(c, a['@url'] as number);
    const name = u.name;
    const exists = !!c.dev.images?.[name] || !!c.dev.files?.[name];
    const go = (o: string[]) => {
      if (!exists) return void o.push(`%Error deleting flash:/${name} (No such file or directory)`);
      if (c.dev.images) delete c.dev.images[name];
      if (c.dev.files) delete c.dev.files[name];
    };
    if (force) return go(c.out);
    c.s.ask({
      prompt: `Delete filename [${name}]? `,
      handle: () =>
        c.s.ask({
          prompt: `Delete flash:/${name}? [confirm]`,
          handle: (y, o2) => (/^(|y|yes)$/i.test(y.trim()) ? go(o2) : undefined),
        }),
    });
  };
  t.add('delete <word:url>', { ...HE, delete: 'Delete a file' }, (c, a) => del(c, a, false));
  t.add('delete /force <word:url>', { ...HE, delete: 'Delete a file', '/force': 'Force delete' }, (c, a) => del(c, a, true));
  const schedule = (c: Ctx, at: number, text: string) => {
    c.out.push(`Reload scheduled ${text} by ${c.s.isRemote ? 'vty0' : 'console'}`, 'Reload reason: Reload Command');
    c.s.ask({
      prompt: 'Proceed with reload? [confirm]',
      handle: (x) => {
        if (!/^(|y|yes|confirm)$/i.test(x.trim())) return;
        c.dev.reloadAt = at;
        c.net.log(c.dev.id, `%SYS-5-SCHEDULED_RELOAD: Reload requested for ${scheduleText(c, at)} at ${scheduleText(c, c.net.time)} by ${c.s.isRemote ? 'vty0' : 'console'}. Reload Reason: Reload Command.`);
      },
    });
  };
  t.add('reload in <word:when>', { ...HE, reload: 'Halt and perform a cold restart', in: 'Reload after a time interval', when: 'Delay before reload (mmm or hhh:mm)' }, (c, a) => {
    const m = /^(?:(\d{1,3}):)?(\d{1,3})$/.exec(String(a.when));
    if (!m) return caret(c, a['@when'] as number);
    const mins = Number(m[1] ?? 0) * 60 + Number(m[2]);
    if (mins < 1 || mins > 24 * 60 * 24) return caret(c, a['@when'] as number);
    const at = c.net.time + mins * 60000;
    schedule(c, at, `for ${scheduleText(c, at)} (in ${Math.floor(mins / 60)} hours ${mins % 60} minutes)`);
  });
  t.add('reload at <word:when>', { ...HE, reload: 'Halt and perform a cold restart', at: 'Reload at a specific time/date', when: 'Time to reload (hh:mm)' }, (c, a) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(a.when));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return caret(c, a['@when'] as number);
    const now = c.net.wallClock();
    const target = new Date(now);
    target.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
    if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
    const at = c.net.time + (target.getTime() - now.getTime());
    const mins = Math.round((at - c.net.time) / 60000);
    schedule(c, at, `for ${scheduleText(c, at)} (in ${Math.floor(mins / 60)} hours ${mins % 60} minutes)`);
  });
  t.add('reload cancel', { ...HE, reload: 'Halt and perform a cold restart', cancel: 'Cancel pending reload' }, (c) => {
    if (c.dev.reloadAt === undefined) return void c.out.push('%No reload is scheduled.');
    delete c.dev.reloadAt;
    c.out.push('', '', '***', '*** --- SHUTDOWN ABORTED ---', '***', '');
  });

  t.add('copy running-config <word:dst>', HE, (c, a) => copy(c, 'running-config', a.dst as string, 5, a['@dst'] as number));
  t.add('copy startup-config <word:dst>', HE, (c, a) => copy(c, 'startup-config', a.dst as string, 5, a['@dst'] as number));
  t.add('copy <word:src> <word:dst>', HE, (c, a) => copy(c, a.src as string, a.dst as string, a['@src'] as number, a['@dst'] as number));
  t.add('archive config', HE, (c) => {
    const r = archiveConfig(c.net, c.dev);
    if (!r.ok) c.out.push(r.error);
    else c.out.push('!!', `${r.bytes} bytes copied`);
  });
  const replace = (list: boolean, force: boolean) => (c: Ctx, a: Record<string, unknown>) => {
    const u = parseUrl(a.url as string);
    if (!u || (u.fs !== 'flash' && u.fs !== 'tftp')) return caret(c, a['@url'] as number);
    const r = readFile(c.net, c.dev, u);
    if (!r.ok) return void c.out.push(r.error);
    const run = (out: string[]) => {
      if (list) {
        out.push('!Pass 1', '!List of Rollback Commands:');
        for (const l of configDiff(c.dev, c.dev.running, r.file.config)) {
          if (l.startsWith('!')) continue;
          const m = /^(\s*)([+-])(.*)$/.exec(l);
          out.push(m ? `${m[1]}${m[2] === '-' ? 'no ' : ''}${m[3]}` : l);
        }
        out.push('end', '');
      }
      c.dev.running = cloneConfig(r.file.config);
      commit(c);
      out.push('Total number of passes: 1', 'Rollback Done', '');
      c.net.log(c.dev.id, '%SYS-5-CONFIG_R: Config Replace is Done');
    };
    if (force) return run(c.out);
    c.s.ask({
      prompt:
        'This will apply all necessary additions and deletions\nto replace the current running configuration with the\ncontents of the specified configuration file, which is\nassumed to be a complete configuration, not a partial\nconfiguration. Enter Y if you are sure you want to proceed. ? [no]: ',
      handle: (ans, o) => {
        if (/^y(es)?$/i.test(ans.trim())) run(o);
      },
    });
  };
  t.add('configure replace <word:url>', HE, replace(false, false));
  t.add('configure replace <word:url> list', HE, replace(true, false));
  t.add('configure replace <word:url> force', HE, replace(false, true));
  t.add('configure replace <word:url> list force', HE, replace(true, true));
  t.add('clear counters', HE, (c) =>
    c.s.ask({
      prompt: 'Clear "show interface" counters on all interfaces [confirm]',
      handle: (a) => {
        if (!/^(|y|yes)$/i.test(a.trim())) return;
        c.net.clearCounters(c.dev.id);
        c.net.log(c.dev.id, `%CLEAR-5-COUNTERS: Clear counter on all interfaces by ${c.s.isRemote ? 'vty0' : 'console'}`);
      },
    }),
  );
  t.add('clear counters <iface:if>', HE, (c, a) => {
    const name = a.if as string;
    if (!c.dev.running.interfaces[name]) return caret(c, a['@if'] as number);
    c.s.ask({
      prompt: 'Clear "show interface" counters on this interface [confirm]',
      handle: (x) => {
        if (!/^(|y|yes)$/i.test(x.trim())) return;
        c.net.clearCounters(c.dev.id, name);
        c.net.log(c.dev.id, `%CLEAR-5-COUNTERS: Clear counter on interface ${name} by ${c.s.isRemote ? 'vty0' : 'console'}`);
      },
    });
  });
}

function verify(c: Ctx, url: string, col: number, expected?: string): void {
  const u = parseUrl(url);
  if (!u || u.fs !== 'flash') return caret(c, col);
  const img = c.dev.images?.[u.name];
  const f = c.dev.files?.[u.name];
  if (!img && !f) return void c.out.push(`%Error opening flash:/${u.name} (No such file or directory)`);
  const md5 = img ? (img.corrupt ? md5Of(u.name, true) : img.md5) : md5Of(f!.text);
  c.out.push('.'.repeat(img ? 60 : 4) + 'Done!');
  if (expected === undefined) return void c.out.push(`verify /md5 (flash:${u.name}) = ${md5}`, '');
  if (expected.toLowerCase() === md5) c.out.push(`Verified (flash:${u.name}) = ${md5}`, '');
  else c.out.push(`%Error verifying flash:${u.name}`, `Computed signature  = ${md5}`, `Submitted signature = ${expected.toLowerCase()}`, '');
}

const MAC_RE = /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i;

export function addOpsShows(t: Tree, kind: DeviceKind, privileged: boolean): void {
  t.add('show login', HS, (c) => c.out.push(...showLogin(c.net, c.dev)));
  t.add('show reload', { ...HS, reload: 'Scheduled reload information' }, (c) => {
    if (c.dev.reloadAt === undefined) return void c.out.push('No reload is scheduled.');
    const mins = Math.max(0, Math.round((c.dev.reloadAt - c.net.time) / 60000));
    c.out.push(`Reload scheduled for ${scheduleText(c, c.dev.reloadAt)} (in ${Math.floor(mins / 60)} hours ${mins % 60} minutes) by console`, 'Reload reason: Reload Command');
  });
  if (isSwitchKind(kind)) {
    t.add('show boot', { ...HS, boot: 'show boot attributes' }, (c) => {
      const b = c.dev.running.bootSystem ?? [];
      c.out.push(`BOOT path-list      : ${b.join(';')}`, 'Config file         : flash:/config.text', 'Private Config file : flash:/private-config.text', 'Enable Break        : no', 'Manual Boot         : no', 'HELPER path-list    : ', 'Auto upgrade        : yes');
    });
  }
  if (privileged) {
    t.add('show archive', HS, (c) => c.out.push(...showArchive(c.net, c.dev)));
    const diff = (c: Ctx, a: Record<string, unknown>, second: boolean) => {
      const u1 = parseUrl(a.url as string);
      if (!u1) return caret(c, a['@url'] as number);
      const load = (u: FileUrl): DeviceConfig | string => {
        if (u.fs === 'running') return c.dev.running;
        if (u.fs === 'startup') return c.dev.startup ?? '%Error opening nvram:startup-config (No such file or directory)';
        const r = readFile(c.net, c.dev, u);
        return r.ok ? r.file.config : r.error;
      };
      const u2 = second ? parseUrl(a.url2 as string) : ({ fs: 'running' } as FileUrl);
      if (!u2) return caret(c, a['@url2'] as number);
      const from = load(u1);
      const to = load(u2);
      if (typeof from === 'string') return void c.out.push(from);
      if (typeof to === 'string') return void c.out.push(to);
      c.out.push(...configDiff(c.dev, from, to));
    };
    t.add('show archive config differences <word:url>', HS, (c, a) => diff(c, a, false));
    t.add('show archive config differences <word:url> <word:url2>', HS, (c, a) => diff(c, a, true));
    t.add('show flash', HS, (c) => c.out.push(...showFlash(c.net, c.dev)));
    t.add('show flash:', HS, (c) => c.out.push(...showFlash(c.net, c.dev)));
    t.add('dir', HE, (c) => c.out.push(...showFlash(c.net, c.dev)));
    t.add('dir flash:', HE, (c) => c.out.push(...showFlash(c.net, c.dev)));
  }
  if (!isSwitchKind(kind)) return;
  t.add('show interfaces counters errors', HS, (c) => c.out.push(...showCountersErrors(c.dev)));
  t.add('show mac address-table', HS, (c) => c.out.push(...showMacTable(c.net, c.dev)));
  t.add('show mac address-table dynamic', HS, (c) => c.out.push(...showMacTable(c.net, c.dev, { dynamic: true })));
  t.add('show mac address-table static', HS, (c) => c.out.push(...showMacTable(c.net, c.dev, { static: true })));
  t.add('show mac address-table count', HS, (c) => c.out.push(...showMacCount(c.net, c.dev)));
  t.add('show mac address-table aging-time', HS, (c) => {
    c.out.push('Global Aging Time:  300', 'Vlan    Aging Time', '----    ----------');
  });
  const byAddr = (dynamic: boolean) => (c: Ctx, a: Record<string, unknown>) => {
    const mac = String(a.addr).toLowerCase();
    if (!MAC_RE.test(mac)) return caret(c, a['@addr'] as number);
    c.out.push(...showMacTable(c.net, c.dev, { address: mac, dynamic }));
  };
  t.add('show mac address-table address <word:addr>', HS, byAddr(false));
  t.add('show mac address-table dynamic address <word:addr>', HS, byAddr(true));
  const byIf = (dynamic: boolean) => (c: Ctx, a: Record<string, unknown>) => {
    if (!c.dev.running.interfaces[a.if as string]) return caret(c, a['@if'] as number);
    c.out.push(...showMacTable(c.net, c.dev, { iface: a.if as string, dynamic }));
  };
  t.add('show mac address-table interface <iface:if>', HS, byIf(false));
  t.add('show mac address-table dynamic interface <iface:if>', HS, byIf(true));
  t.add('show mac address-table vlan <number:id:1-4094>', HS, (c, a) => c.out.push(...showMacTable(c.net, c.dev, { vlan: a.id as number })));
  t.add('show mac address-table dynamic vlan <number:id:1-4094>', HS, (c, a) => c.out.push(...showMacTable(c.net, c.dev, { vlan: a.id as number, dynamic: true })));
  if (privileged) {
    t.add('clear mac address-table dynamic', HE, (c) => void (c.dev.macClearedAt = c.net.time));
    t.add('clear mac address-table dynamic address <word:addr>', HE, (c, a) => {
      if (!MAC_RE.test(String(a.addr))) return caret(c, a['@addr'] as number);
      c.dev.macClearedAt = c.net.time;
    });
    t.add('clear mac address-table dynamic interface <iface:if>', HE, (c) => void (c.dev.macClearedAt = c.net.time));
    t.add('clear mac address-table dynamic vlan <number:id:1-4094>', HE, (c) => void (c.dev.macClearedAt = c.net.time));
  }
}
