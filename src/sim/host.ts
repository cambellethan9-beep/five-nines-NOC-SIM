// A minimal Windows-style command prompt for PCs and servers.
// Phase 1 replaces this with the full user desktop view.

import type { CliResult } from './cli/session';
import { formatIp, parseIp, prefixToMask } from './ip';
import type { Network } from './network';
import { RemoteClient, type Proto } from './remote';
import { ping, traceroute } from './routing';

export interface ConsoleSession {
  promptText(): string;
  readonly secretInput: boolean;
  input(line: string): CliResult;
  help(line: string): string[];
  complete(line: string): string;
  ctrlZ(): string[];
  checkBoot(): string[];
  /** New lines to print this tick (log messages, dropped connections). */
  pollLogs(): string[];
}

export interface HostOptions {
  /** Logged-in Windows user; also the default SSH username. */
  user?: string;
  /** SSH key identity installed on this PC (`ssh-keygen`), trusted by devices that list it. */
  sshKey?: string;
  /** Shared known_hosts, so it survives saving and reloading. */
  knownHosts?: Map<string, string>;
}

export class HostShell implements ConsoleSession {
  readonly user: string;
  readonly sshKey: string | undefined;
  /** C:\Users\<user>\.ssh\known_hosts */
  readonly knownHosts: Map<string, string>;
  private client: RemoteClient | null = null;

  constructor(
    readonly net: Network,
    readonly deviceId: string,
    options: HostOptions = {},
  ) {
    this.user = options.user ?? 'user';
    this.sshKey = options.sshKey;
    this.knownHosts = options.knownHosts ?? new Map();
  }

  promptText(): string {
    return this.client ? this.client.promptText() : `C:\\Users\\${this.user}>`;
  }

  get secretInput(): boolean {
    return this.client?.secretInput ?? false;
  }

  help(line: string): string[] {
    return this.client?.help(line) ?? [];
  }

  complete(line: string): string {
    return this.client ? this.client.complete(line) : line;
  }

  ctrlZ(): string[] {
    return this.client?.ctrlZ() ?? [];
  }

  checkBoot(): string[] {
    return [];
  }

  /** True while connected to a device, so the terminal enables IOS keys like "?". */
  get remoteActive(): boolean {
    return this.client?.connected ?? false;
  }

  pollLogs(): string[] {
    if (!this.client) return [];
    const lines = this.client.poll();
    if (this.client.done) this.client = null;
    return lines;
  }

  input(line: string): CliResult {
    if (this.client) {
      const r = this.client.input(line);
      if (this.client.done) this.client = null;
      return r;
    }
    const result: CliResult = { output: [] };
    const [cmd, ...args] = line.trim().split(/\s+/);
    const out = result.output;
    switch ((cmd ?? '').toLowerCase()) {
      case '':
        break;
      case 'ipconfig':
        this.ipconfig(out, args[0]?.toLowerCase() === '/all');
        break;
      case 'ping':
        this.ping(args[0], result);
        break;
      case 'tracert':
        this.tracert(args[0], result);
        break;
      case 'ssh':
        this.ssh(args, result);
        break;
      case 'telnet':
        this.telnet(args, result);
        break;
      case 'whoami':
        out.push(`netsmart\\${this.user}`, '');
        break;
      case 'help':
        out.push(
          'Supported commands:',
          '  ipconfig [/all]',
          '  ping <address>',
          '  tracert <address>',
          '  ssh [user@]<address> [-p <port>] [-l <user>]',
          '  telnet <address> [port]',
          '  whoami',
          '',
        );
        break;
      default:
        out.push(`'${cmd}' is not recognized as an internal or external command,`, 'operable program or batch file.', '');
    }
    return result;
  }

  /** OpenSSH syntax: ssh [-p port] [-l user] [user@]host — options may also follow the host. */
  private ssh(args: string[], result: CliResult): void {
    let user: string | null = null;
    let port = 22;
    let host: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-p') port = Number(args[++i]);
      else if (a === '-l') user = args[++i] ?? null;
      else if (a.startsWith('-')) continue;
      else host = a;
    }
    const usage = 'usage: ssh [-l login_name] [-p port] destination';
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      result.output.push(usage, '');
      return;
    }
    const at = host.lastIndexOf('@');
    if (at >= 0) {
      user = host.slice(0, at);
      host = host.slice(at + 1);
    }
    const ip = parseIp(host);
    if (ip === null) {
      result.output.push(`ssh: Could not resolve hostname ${host}: No such host is known.`, '');
      return;
    }
    this.connect('ssh', ip, port, user ?? this.user, result);
  }

  private telnet(args: string[], result: CliResult): void {
    const ip = args[0] ? parseIp(args[0]) : null;
    const port = args[1] ? Number(args[1]) : 23;
    if (ip === null || !Number.isInteger(port)) {
      result.output.push(args[0] ? `Connecting To ${args[0]}...Could not open connection to the host, on port ${port}: Connect failed` : 'Usage: telnet <address> [port]', '');
      return;
    }
    this.connect('telnet', ip, port, null, result);
  }

  private connect(proto: Proto, ip: number, port: number, user: string | null, result: CliResult): void {
    const client = new RemoteClient(this.net, this.deviceId, {
      style: 'windows',
      proto,
      ip,
      port,
      user,
      knownHosts: this.knownHosts,
      clientKey: this.sshKey,
    });
    const r = client.start();
    result.output.push(...r.output);
    result.delayed = r.delayed;
    if (!client.done) this.client = client;
  }

  private ipconfig(out: string[], all: boolean): void {
    const device = this.net.device(this.deviceId);
    out.push('', 'Windows IP Configuration', '');
    // Without a driver Windows doesn't know the adapter exists; disabled adapters are hidden too.
    if (device.nic && (device.nic.driver === 'missing' || device.nic.disabled)) return;
    for (const ifc of Object.values(device.running.interfaces)) {
      const up = this.net.isUp(device.id, ifc.name);
      out.push(`Ethernet adapter Ethernet:`, '');
      if (!up) {
        out.push('   Media State . . . . . . . . . . . : Media disconnected', '');
        continue;
      }
      if (all) out.push(`   Physical Address. . . . . . . . . : ${device.hardware[ifc.name].mac.replace(/\./g, '').replace(/(..)(?!$)/g, '$1-').toUpperCase()}`);
      if (ifc.ip) {
        out.push(`   IPv4 Address. . . . . . . . . . . : ${formatIp(ifc.ip.address)}`);
        out.push(`   Subnet Mask . . . . . . . . . . . : ${formatIp(prefixToMask(ifc.ip.prefix))}`);
      } else {
        out.push('   Autoconfiguration IPv4 Address. . : 169.254.12.34', '   Subnet Mask . . . . . . . . . . . : 255.255.0.0');
      }
      const gw = device.running.defaultGateway;
      out.push(`   Default Gateway . . . . . . . . . : ${gw === null ? '' : formatIp(gw)}`, '');
    }
  }

  private ping(target: string | undefined, result: CliResult): void {
    const dest = target ? parseIp(target) : null;
    if (dest === null) {
      result.output.push(`Ping request could not find host ${target ?? ''}. Please check the name and try again.`, '');
      return;
    }
    const r = ping(this.net, this.deviceId, dest, 4);
    const responder = r.destDevice ? this.net.device(r.destDevice) : null;
    const baseTtl = responder && (responder.kind === 'pc' || responder.kind === 'server') ? 128 : 255;
    const gw = this.net.device(this.deviceId).running.defaultGateway;
    const lines: string[] = [];
    let rtt = 0;
    for (const mark of r.marks) {
      if (mark === '!') lines.push(`Reply from ${target}: bytes=32 time=${r.rttMs[rtt++]}ms TTL=${baseTtl - r.hops}`);
      else if (mark === 'U') lines.push(`Reply from ${gw === null ? target : formatIp(gw)}: Destination host unreachable.`);
      else lines.push('Request timed out.');
    }
    const received = r.successes;
    lines.push('', `Ping statistics for ${target}:`);
    lines.push(`    Packets: Sent = 4, Received = ${received}, Lost = ${4 - received} (${(4 - received) * 25}% loss),`);
    if (received) {
      const min = Math.min(...r.rttMs);
      const max = Math.max(...r.rttMs);
      const avg = Math.round(r.rttMs.reduce((a, b) => a + b, 0) / r.rttMs.length);
      lines.push('Approximate round trip times in milli-seconds:', `    Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg}ms`);
    }
    lines.push('');
    result.output.push('', `Pinging ${target} with 32 bytes of data:`);
    const timeouts = [...r.marks].filter((m) => m !== '!').length;
    result.delayed = { ms: 400 + timeouts * 1000, output: lines };
  }

  private tracert(target: string | undefined, result: CliResult): void {
    const dest = target ? parseIp(target) : null;
    if (dest === null) {
      result.output.push(`Unable to resolve target system name ${target ?? ''}.`, '');
      return;
    }
    const hops = traceroute(this.net, this.deviceId, dest);
    result.output.push('', `Tracing route to ${target} over a maximum of 30 hops:`, '');
    const lines = hops.map((h) => {
      const n = String(h.ttl).padStart(3);
      if (h.address === null) return `${n}     *        *        *     Request timed out.`;
      const times = h.rttMs.map((m) => `${String(m).padStart(4)} ms`).join(' ');
      return `${n} ${times}  ${formatIp(h.address)}${h.unreachable ? '  reports: Destination host unreachable.' : ''}`;
    });
    if (hops.length && hops[hops.length - 1].address === dest) lines.push('', 'Trace complete.');
    lines.push('');
    const silent = hops.filter((h) => h.address === null).length;
    result.delayed = { ms: 400 + Math.min(silent, 6) * 900, output: lines };
  }
}
