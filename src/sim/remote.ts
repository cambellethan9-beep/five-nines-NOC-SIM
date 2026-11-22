// Remote management: SSH and Telnet from the NOC PC (Windows OpenSSH style) or from a router (IOS style).
// The server side follows IOS rules: RSA keys, `line vty` transport/login settings, local users,
// trusted client keys (`ip ssh pubkey-chain`) and custom SSH ports via rotary groups.

import { evaluate } from './acl';
import { CliSession, type CliResult } from './cli/session';
import { formatIp, type Ipv4 } from './ip';
import type { Network } from './network';
import { loginTime } from './ambient';
import { inQuietMode, quietModeAllows, recordLoginFailure } from './hardening';
import { canReach, ownsAddress, sourceAddressFor } from './routing';
import type { Device } from './types';

export type Proto = 'ssh' | 'telnet';
export type ClientStyle = 'windows' | 'ios';

export function sshEnabled(device: Device): boolean {
  const c = device.running.crypto;
  return c !== null && !(device.running.ssh.version === 2 && c.bits < 768);
}

/** Finds the online device that owns `ip` and is reachable from the client. */
function findTarget(net: Network, clientId: string, ip: Ipv4, port: number): Device | null {
  for (const device of net.devices.values()) {
    if (!net.isOnline(device) || !ownsAddress(net, device, ip)) continue;
    return canReach(net, clientId, ip, { proto: 'tcp', port }, false, false) ? device : null;
  }
  return null;
}

function portOpen(device: Device, proto: Proto, port: number): boolean {
  const cfg = device.running;
  const vty = cfg.lines.vty;
  if (proto === 'telnet') return port === 23 && vty.transport.telnet;
  if (!sshEnabled(device) || !vty.transport.ssh) return false;
  if (port === 22) return true;
  return port === cfg.ssh.port && cfg.ssh.rotary !== null && vty.rotary === cfg.ssh.rotary;
}

/** SSH host key fingerprint; changes whenever the device's RSA keys are regenerated. */
export function hostFingerprint(device: Device): string {
  const seed = `${device.id}:${device.running.crypto?.serial ?? 0}:${device.running.crypto?.bits ?? 0}`;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let out = '';
  for (let i = 0; i < 43; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    out += alphabet[(h >>> 0) % 64];
  }
  return `SHA256:${out}`;
}

type State = 'hostkey' | 'username' | 'password' | 'connected' | 'closed';

export interface ClientOptions {
  style: ClientStyle;
  proto: Proto;
  ip: Ipv4;
  port: number;
  user: string | null;
  /** Windows client's ~/.ssh/known_hosts (host:port -> fingerprint). */
  knownHosts?: Map<string, string>;
  /** The client's SSH key identity, if it has one (the NOC PC does). */
  clientKey?: string;
}

/** One outbound SSH/Telnet connection. While connected, it wraps a CLI session on the remote device. */
export class RemoteClient {
  private state: State = 'closed';
  private session: CliSession | null = null;
  private target: Device | null = null;
  private attempts = 0;
  private user: string | null;
  private readonly ipText: string;

  constructor(
    private readonly net: Network,
    private readonly clientId: string,
    private readonly opts: ClientOptions,
  ) {
    this.user = opts.user;
    this.ipText = formatIp(opts.ip);
  }

  get done(): boolean {
    return this.state === 'closed';
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  private get win(): boolean {
    return this.opts.style === 'windows';
  }

  /** Opens the connection. Returns the first output (possibly delayed, for timeouts). */
  start(): CliResult {
    const result: CliResult = { output: [] };
    const out = result.output;
    const { proto, port } = this.opts;
    if (proto === 'telnet') out.push(this.win ? `Connecting To ${this.ipText}...` : `Trying ${this.ipText} ... `);
    const target = findTarget(this.net, this.clientId, this.opts.ip, port);
    if (!target) {
      // Nothing answers: the client waits for its timeout.
      const msg = this.win
        ? proto === 'ssh'
          ? `ssh: connect to host ${this.ipText} port ${port}: Connection timed out`
          : `Could not open connection to the host, on port ${port}: Connect failed`
        : '% Connection timed out; remote host not responding';
      result.delayed = { ms: 5000, output: [msg, ''] };
      return result;
    }
    const quiet = inQuietMode(this.net, target) && !quietModeAllows(target, sourceAddressFor(this.net, this.net.device(this.clientId), this.opts.ip), port);
    if (!portOpen(target, proto, port) || !this.accessClassPermits(target) || quiet) {
      out.push(
        this.win
          ? proto === 'ssh'
            ? `ssh: connect to host ${this.ipText} port ${port}: Connection refused`
            : `Could not open connection to the host, on port ${port}: Connect failed`
          : '% Connection refused by remote host',
        '',
      );
      return result;
    }
    this.target = target;
    if (proto === 'telnet') {
      if (!this.win) out[out.length - 1] += 'Open';
      this.beginTelnet(out);
      return result;
    }
    if (this.win) {
      const known = this.opts.knownHosts?.get(this.hostKeyId());
      const fp = hostFingerprint(target);
      if (known && known !== fp) {
        out.push(
          '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
          '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
          '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
          'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
          'Someone could be eavesdropping on you right now (man-in-the-middle attack)!',
          'It is also possible that a host key has just been changed.',
          `The fingerprint for the RSA key sent by the remote host is\n${fp}.`,
          'Please contact your system administrator.',
          `Offending RSA key in C:\\\\Users\\\\nocadmin/.ssh/known_hosts`,
          'Host key verification failed.',
          '',
        );
        return result;
      }
      if (!known) {
        out.push(
          `The authenticity of host '${this.ipText} (${this.ipText})' can't be established.`,
          `RSA key fingerprint is ${fp}.`,
        );
        this.state = 'hostkey';
        return result;
      }
    }
    this.authenticateSsh(out);
    return result;
  }

  private hostKeyId(): string {
    return this.opts.port === 22 ? this.ipText : `[${this.ipText}]:${this.opts.port}`;
  }

  private authenticateSsh(out: string[]): void {
    const target = this.target!;
    const cfg = target.running;
    // The SSH server sends the login banner before authentication.
    if (cfg.bannerLogin) out.push(cfg.bannerLogin);
    if (this.user === null) this.user = '';
    // Public key first: a trusted client key logs straight in.
    const key = this.opts.clientKey;
    if (key && cfg.authorizedKeys.some((k) => k.user === this.user && k.key === key) && cfg.users[this.user]) {
      this.connect(cfg.users[this.user].privilege, out);
      return;
    }
    if (cfg.lines.vty.login === 'none') {
      this.connect(1, out);
      return;
    }
    this.state = 'password';
  }

  private beginTelnet(out: string[]): void {
    const cfg = this.target!.running;
    const vty = cfg.lines.vty;
    if (cfg.bannerMotd) out.push('', cfg.bannerMotd);
    if (cfg.bannerLogin && vty.login !== 'none') out.push('', cfg.bannerLogin);
    if (vty.login === 'none') {
      this.connect(1, out);
      return;
    }
    if (vty.login === 'line' && !vty.password) {
      out.push('', 'Password required, but none set', '');
      this.close(out);
      return;
    }
    out.push('', 'User Access Verification', '');
    this.state = vty.login === 'local' ? 'username' : 'password';
  }

  private checkPassword(password: string): number | null {
    const cfg = this.target!.running;
    const vty = cfg.lines.vty;
    if (vty.login === 'local' || this.opts.proto === 'ssh') {
      const u = cfg.users[this.user ?? ''];
      if (vty.login === 'local' && u && (u.secret ?? u.password) === password) return u.privilege;
      // SSH with plain `login` accepts the line password for any user.
      if (vty.login === 'line' && vty.password && vty.password === password) return 1;
      return null;
    }
    return vty.password === password ? 1 : null;
  }

  /** `access-class NAME in` on the vty lines: a denied source gets a TCP reset (connection refused). */
  private accessClassPermits(target: Device): boolean {
    const name = target.running.lines.vty.accessClass;
    const acl = name ? target.running.acls?.[name] : undefined;
    if (!acl || !acl.entries.some((e) => e.remark === undefined)) return true;
    const src = sourceAddressFor(this.net, this.net.device(this.clientId), this.opts.ip);
    if (src === null) return false;
    const r = evaluate(acl, { proto: 'tcp', src, dst: this.opts.ip, srcPort: 51034, dstPort: this.opts.port });
    if (r.seq !== null) {
      const hits = (target.aclHits ??= {});
      hits[`${acl.name}:${r.seq}`] = (hits[`${acl.name}:${r.seq}`] ?? 0) + 1;
    }
    return r.permit;
  }

  private loginLog(success: boolean): void {
    const target = this.target!;
    const src = sourceAddressFor(this.net, this.net.device(this.clientId), this.opts.ip);
    const who = `[user: ${this.user ?? ''}] [Source: ${src === null ? 'unknown' : formatIp(src)}] [localport: ${this.opts.port}]`;
    if (success) this.net.log(target.id, `%SEC_LOGIN-5-LOGIN_SUCCESS: Login Success ${who} at ${loginTime(this.net)}`);
    else recordLoginFailure(this.net, target, this.user ?? '', src === null ? 'unknown' : formatIp(src), this.opts.port);
  }

  private connect(privilege: number, out: string[]): void {
    const target = this.target!;
    this.loginLog(true);
    if (this.opts.proto === 'ssh' && target.running.bannerMotd) out.push('', target.running.bannerMotd, '');
    else out.push('');
    if (target.running.bannerExec) out.push(target.running.bannerExec, '');
    this.session = new CliSession(this.net, target.id, { remote: { user: this.user ?? '', privilege } });
    this.state = 'connected';
  }

  private close(out: string[], byRemote = false): void {
    if (this.state === 'connected' || byRemote) {
      if (this.win && this.opts.proto === 'ssh') {
        out.push(`Connection to ${this.ipText} closed${byRemote ? ' by remote host' : ''}.`);
      } else if (this.win) {
        out.push('', 'Connection to host lost.');
      } else {
        out.push(`[Connection to ${this.ipText} closed by foreign host]`);
      }
    }
    this.state = 'closed';
    this.session = null;
  }

  promptText(): string {
    switch (this.state) {
      case 'hostkey':
        return 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ';
      case 'username':
        return 'Username: ';
      case 'password':
        return this.win && this.opts.proto === 'ssh' ? `${this.user}@${this.ipText}'s password: ` : 'Password: ';
      case 'connected':
        return this.session!.promptText();
      default:
        return '';
    }
  }

  get secretInput(): boolean {
    return this.state === 'password' || (this.state === 'connected' && this.session!.secretInput);
  }

  input(line: string): CliResult {
    const result: CliResult = { output: [] };
    const out = result.output;
    switch (this.state) {
      case 'hostkey': {
        const a = line.trim().toLowerCase();
        const fp = hostFingerprint(this.target!);
        if (a === 'yes' || line.trim() === fp) {
          this.opts.knownHosts?.set(this.hostKeyId(), fp);
          out.push(`Warning: Permanently added '${this.ipText}' (RSA) to the list of known hosts.`);
          this.authenticateSsh(out);
        } else if (a === 'no') {
          out.push('Host key verification failed.', '');
          this.state = 'closed';
        } else {
          out.push("Please type 'yes', 'no' or the fingerprint: ");
        }
        return result;
      }
      case 'username':
        this.user = line.trim();
        this.state = 'password';
        return result;
      case 'password': {
        const privilege = this.checkPassword(line);
        if (privilege !== null) {
          this.connect(privilege, out);
          return result;
        }
        this.attempts++;
        this.loginLog(false);
        if (inQuietMode(this.net, this.target!)) {
          // Quiet mode drops the session that tripped it.
          out.push(this.win && this.opts.proto === 'ssh' ? `Connection to ${this.ipText} closed by remote host.` : '% Connection closed by remote host', '');
          this.state = 'closed';
          return result;
        }
        const ssh = this.opts.proto === 'ssh';
        if (this.attempts >= 3) {
          if (this.win && ssh) out.push(`${this.user}@${this.ipText}: Permission denied (password).`, '');
          else out.push(ssh ? '% Authentication failed.' : '% Bad passwords', '');
          this.state = 'closed';
          return result;
        }
        if (this.win && ssh) out.push('Permission denied, please try again.');
        else if (this.target!.running.lines.vty.login === 'local') {
          out.push('% Login invalid', '');
          this.state = 'username';
        }
        return result;
      }
      case 'connected': {
        const r = this.session!.input(line);
        if (this.session!.closed) this.close(r.output);
        return r;
      }
      default:
        return result;
    }
  }

  help(line: string): string[] {
    return this.state === 'connected' ? this.session!.help(line) : [];
  }

  complete(line: string): string {
    return this.state === 'connected' ? this.session!.complete(line) : line;
  }

  ctrlZ(): string[] {
    return this.state === 'connected' ? this.session!.ctrlZ() : [];
  }

  /** Called every tick: remote log messages (with `terminal monitor`) and dropped connections. */
  poll(): string[] {
    if (this.state !== 'connected') return [];
    const target = this.target!;
    if (!this.net.isOnline(target) || !canReach(this.net, this.clientId, this.opts.ip, { proto: 'tcp', port: this.opts.port }, false, false)) {
      const out: string[] = [''];
      this.close(out, true);
      return out;
    }
    const lines = this.session!.pollLogs();
    if (this.session!.closed) this.close(lines, true);
    return lines;
  }
}
