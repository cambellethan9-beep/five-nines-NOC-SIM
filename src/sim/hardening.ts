// Device hardening: type 7 password obfuscation (`service password-encryption`), `security passwords min-length`,
// `login block-for` quiet mode, and exec-timeout defaults.

import { evaluate } from './acl';
import { loginTime } from './ambient';
import type { Ipv4 } from './ip';
import type { Network } from './network';
import type { Device, DeviceConfig, LineConfig } from './types';

// The well-known type 7 key. Type 7 is reversible: it only stops shoulder surfing.
const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';

export function type7Encode(pw: string): string {
  let seed = 0;
  for (let i = 0; i < pw.length; i++) seed = (seed * 31 + pw.charCodeAt(i)) % 16;
  let out = String(seed).padStart(2, '0');
  for (let i = 0; i < pw.length; i++) out += (pw.charCodeAt(i) ^ XLAT.charCodeAt((seed + i) % XLAT.length)).toString(16).toUpperCase().padStart(2, '0');
  return out;
}

export function type7Decode(hash: string): string | null {
  if (!/^\d{2}([0-9A-Fa-f]{2})+$/.test(hash)) return null;
  const seed = Number(hash.slice(0, 2));
  if (seed > 15) return null;
  let out = '';
  for (let i = 2, j = 0; i < hash.length; i += 2, j++) out += String.fromCharCode(parseInt(hash.slice(i, i + 2), 16) ^ XLAT.charCodeAt((seed + j) % XLAT.length));
  return out;
}

/** `security passwords min-length`: returns the IOS error when the password is too short. */
export function passwordTooShort(cfg: DeviceConfig, pw: string): string | null {
  const min = cfg.minPasswordLength ?? 0;
  if (pw.length >= min) return null;
  return `% Password too short - must be at least ${min} characters. Password configuration failed`;
}

/** `service password-encryption` turns every clear-text password into type 7 (they stay that way if it's removed). */
export function encryptAll(cfg: DeviceConfig): void {
  for (const line of [cfg.lines.con, cfg.lines.vty]) if (line.password) line.passwordEncrypted = true;
  for (const u of Object.values(cfg.users)) if (u.password !== null) u.passwordEncrypted = true;
  if (cfg.enablePassword) cfg.enablePassword.encrypted = true;
}

/** Clear-text passwords still visible in the configuration. */
export function cleartextPasswords(cfg: DeviceConfig): number {
  let n = 0;
  for (const line of [cfg.lines.con, cfg.lines.vty]) if (line.password && !line.passwordEncrypted) n++;
  for (const u of Object.values(cfg.users)) if (u.password !== null && !u.passwordEncrypted) n++;
  if (cfg.enablePassword && !cfg.enablePassword.encrypted) n++;
  return n;
}

/** Idle minutes before a line logs out; 0 = never. */
export function execTimeoutMs(line: LineConfig): number {
  const [m, s] = line.execTimeout ?? [10, 0];
  return (m * 60 + s) * 1000;
}

// ---- login block-for ---------------------------------------------------------------------------

export function inQuietMode(net: Network, d: Device): boolean {
  return d.quietUntil !== undefined && net.time < d.quietUntil;
}

/** During quiet mode, only sources the quiet-mode access class permits may connect. */
export function quietModeAllows(d: Device, src: Ipv4 | null, port: number): boolean {
  const name = d.running.loginBlock?.quietAcl;
  const acl = name ? d.running.acls?.[name] : undefined;
  if (!acl || src === null) return false;
  return evaluate(acl, { proto: 'tcp', src, dst: 0, srcPort: 51034, dstPort: port }).permit;
}

/** Logs a failed login and, with `login block-for`, starts quiet mode when there are too many. */
export function recordLoginFailure(net: Network, d: Device, user: string, src: string, port: number): void {
  net.log(d.id, `%SEC_LOGIN-4-LOGIN_FAILED: Login failed [user: ${user}] [Source: ${src}] [localport: ${port}] [Reason: Login Authentication Failed] at ${loginTime(net)}`);
  const b = d.running.loginBlock;
  if (!b || inQuietMode(net, d)) return;
  const recent = (d.loginFailures ?? []).filter((t) => net.time - t < b.within * 1000);
  recent.push(net.time);
  d.loginFailures = recent;
  if (recent.length < b.attempts) return;
  d.quietUntil = net.time + b.blockFor * 1000;
  d.loginFailures = [];
  net.log(
    d.id,
    `%SEC_LOGIN-1-QUIET_MODE_ON: Still timeleft for watching failures is ${b.within} secs, [user: ${user}] [Source: ${src}] [localport: ${port}] [Reason: Login Authentication Failed] [ACL: ${b.quietAcl ?? 'sl_def_acl'}] at ${loginTime(net)}`,
  );
}

/** Ends quiet mode when the block period is over. Call each tick. */
export function updateQuietMode(net: Network): void {
  for (const d of net.devices.values()) {
    if (d.quietUntil === undefined || net.time < d.quietUntil) continue;
    delete d.quietUntil;
    net.log(d.id, `%SEC_LOGIN-5-QUIET_MODE_OFF: Quiet Mode is OFF, because block period timed out at ${loginTime(net)}`);
  }
}

export function showLogin(net: Network, d: Device): string[] {
  const b = d.running.loginBlock;
  if (!b) return ['     No login delay has been applied.', '     No Quiet-Mode access list has been configured.', '', '     Router NOT enabled to watch for login Attacks', ''];
  const lines = [
    '     A login delay of 1 seconds is applied.',
    b.quietAcl ? `     Quiet-Mode access list ${b.quietAcl} is applied.` : '     No Quiet-Mode access list has been configured.',
    '',
    '     Router enabled to watch for login Attacks.',
    `     If more than ${b.attempts} login failures occur in ${b.within} seconds or less,`,
    `     logins will be disabled for ${b.blockFor} seconds.`,
    '',
  ];
  if (inQuietMode(net, d)) {
    lines.push('     Router presently in Quiet-Mode.', `     Will remain in Quiet-Mode for ${Math.ceil((d.quietUntil! - net.time) / 1000)} seconds.`, b.quietAcl ? `     Restricted logins filtered by applied ACL ${b.quietAcl}.` : '     Denying logins from all sources.');
  } else {
    const recent = (d.loginFailures ?? []).filter((t) => net.time - t < b.within * 1000);
    const left = recent.length ? Math.max(0, Math.ceil((recent[0] + b.within * 1000 - net.time) / 1000)) : b.within;
    lines.push('     Router presently in Normal-Mode.', '     Current Watch Window', `         Time remaining: ${left} seconds.`, `         Login failures for current window: ${recent.length}.`);
  }
  lines.push('     Total login failures: ' + (d.loginFailures?.length ?? 0) + '.', '');
  return lines;
}
