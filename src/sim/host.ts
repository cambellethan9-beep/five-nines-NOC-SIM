// A minimal Windows-style command prompt for PCs and servers.
// Phase 1 replaces this with the full user desktop view.

import type { CliResult } from './cli/session';
import { formatIp, parseIp, prefixToMask } from './ip';
import type { Network } from './network';
import { RemoteClient, type Proto } from './remote';
import { ping, traceroute } from './routing';
import { dhcpRelease, dhcpRequest, nicOf } from './dhcp';
import { DOMAIN, dnsServerOf, flushDns, fqdn, queryServer, resolve } from './dns';

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
        this.ipconfig(args, result);
        break;
      case 'nslookup':
        this.nslookup(args[0], result);
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
          '  ipconfig [/all | /release | /renew | /displaydns | /flushdns]',
          '  nslookup <name>',
          '  ping <address or name>',
          '  tracert <address or name>',
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

  private ipconfig(args: string[], result: CliResult): void {
    const out = result.output;
    const flag = (args[0] ?? '').toLowerCase();
    const device = this.net.device(this.deviceId);
    const hn = device.hostNet;
    const adapterHidden = !!device.nic && (device.nic.driver === 'missing' || device.nic.disabled);
    out.push('', 'Windows IP Configuration', '');
    if (flag === '/flushdns') {
      flushDns(device);
      out.push('Successfully flushed the DNS Resolver Cache.', '');
      return;
    }
    if (flag === '/displaydns') {
      const entries = Object.entries(hn?.dnsCache ?? {}).filter(([, e]) => e.expires > this.net.time);
      if (!entries.length) {
        out.push('    Could not display the DNS Resolver Cache.', '');
        return;
      }
      for (const [name, e] of entries) {
        out.push(
          `    ${name}`,
          '    ----------------------------------------',
          `    Record Name . . . . . : ${name}`,
          '    Record Type . . . . . : 1',
          `    Time To Live  . . . . : ${Math.floor((e.expires - this.net.time) / 1000)}`,
          '    Data Length . . . . . : 4',
          '    Section . . . . . . . : Answer',
          `    A (Host) Record . . . : ${formatIp(e.ip)}`,
          '',
        );
      }
      return;
    }
    if (flag === '/release' || flag === '/renew') {
      if (adapterHidden) {
        out.push('The operation failed as no adapter is in the state permissible for this operation.', '');
        return;
      }
      if (!hn?.dhcp) {
        out.push('The operation failed as no adapter is in the state permissible for this operation.', '');
        return;
      }
      if (!this.net.isUp(device.id, nicOf(device))) {
        out.push('No operation can be performed on Ethernet while it has its media disconnected.', '');
        return;
      }
      if (flag === '/release') {
        dhcpRelease(this.net, device.id);
        out.push('Ethernet adapter Ethernet:', '', '   Connection-specific DNS Suffix  . :', '   Default Gateway . . . . . . . . . :', '');
        return;
      }
      const r = dhcpRequest(this.net, device.id);
      if (!r.ok) {
        result.delayed = { ms: 4000, output: ['An error occurred while renewing interface Ethernet : unable to contact your DHCP server. Request has timed out.', ''] };
        return;
      }
      result.delayed = { ms: 1200, output: this.adapterLines(false) };
      return;
    }
    if (flag && flag !== '/all') {
      out.push(`Error: unrecognized or incomplete command line.`, '', 'USAGE:', '    ipconfig [/all | /release | /renew | /displaydns | /flushdns]', '');
      return;
    }
    if (adapterHidden) return;
    out.push(...this.adapterLines(flag === '/all'));
  }

  /** The "Ethernet adapter Ethernet:" block of ipconfig. */
  private adapterLines(all: boolean): string[] {
    const device = this.net.device(this.deviceId);
    const hn = device.hostNet;
    const name = nicOf(device);
    const ifc = device.running.interfaces[name];
    const out = ['Ethernet adapter Ethernet:', ''];
    if (!this.net.isUp(device.id, name)) {
      out.push('   Media State . . . . . . . . . . . : Media disconnected', `   Connection-specific DNS Suffix  . :${hn?.dhcp ? ' ' + DOMAIN : ''}`, '');
      return out;
    }
    out.push(`   Connection-specific DNS Suffix  . :${hn?.lease ? ' ' + DOMAIN : ''}`);
    if (all) {
      const mac = device.hardware[name].mac.replace(/\./g, '').replace(/(..)(?!$)/g, '$1-').toUpperCase();
      out.push('   Description . . . . . . . . . . . : NetSmart NS-1000 Gigabit Ethernet', `   Physical Address. . . . . . . . . : ${mac}`);
      out.push(`   DHCP Enabled. . . . . . . . . . . : ${hn?.dhcp ? 'Yes' : 'No'}`, '   Autoconfiguration Enabled . . . . : Yes');
    }
    if (ifc.ip) {
      const label = hn?.apipa ? '   Autoconfiguration IPv4 Address. . : ' : '   IPv4 Address. . . . . . . . . . . : ';
      out.push(`${label}${formatIp(ifc.ip.address)}${all ? '(Preferred)' : ''}`);
      out.push(`   Subnet Mask . . . . . . . . . . . : ${formatIp(prefixToMask(ifc.ip.prefix))}`);
    }
    if (all && hn?.lease) {
      const when = (t: number) => this.net.wallClock(t).toUTCString().replace(' GMT', '');
      out.push(`   Lease Obtained. . . . . . . . . . : ${when(hn.lease.obtainedAt)}`);
      out.push(`   Lease Expires . . . . . . . . . . : ${when(hn.lease.obtainedAt + 8 * 24 * 3600_000)}`);
    }
    const gw = device.running.defaultGateway;
    out.push(`   Default Gateway . . . . . . . . . : ${gw === null ? '' : formatIp(gw)}`);
    if (all) {
      if (hn?.lease) out.push(`   DHCP Server . . . . . . . . . . . : ${formatIp(hn.lease.server)}`);
      const dns = dnsServerOf(device);
      out.push(`   DNS Servers . . . . . . . . . . . : ${dns === null ? '' : formatIp(dns)}`);
    }
    out.push('');
    return out;
  }

  /** nslookup asks the DNS server directly, ignoring the local cache. */
  private nslookup(name: string | undefined, result: CliResult): void {
    const out = result.output;
    if (!name) {
      out.push('Usage: nslookup <name>', '');
      return;
    }
    const device = this.net.device(this.deviceId);
    const server = dnsServerOf(device);
    if (server === null) {
      out.push('*** Default servers are not available', '');
      return;
    }
    const serverName = this.serverName(server);
    const answer = queryServer(this.net, this.deviceId, name);
    if (!answer.ok && answer.reason === 'timeout') {
      result.delayed = {
        ms: 2500,
        output: ['DNS request timed out.', '    timeout was 2 seconds.', 'Server:  UnKnown', `Address:  ${formatIp(server)}`, '', `*** Request to UnKnown timed-out`, ''],
      };
      return;
    }
    out.push(`Server:  ${serverName}`, `Address:  ${formatIp(server)}`, '');
    if (!answer.ok) {
      out.push(`*** ${serverName} can't find ${fqdn(name)}: Non-existent domain`, '');
      return;
    }
    out.push(`Name:    ${fqdn(name)}`, `Address:  ${formatIp(answer.ip)}`, '');
  }

  private serverName(server: number): string {
    for (const d of this.net.devices.values()) {
      if (!d.dnsZone) continue;
      const hit = Object.entries(d.dnsZone).find(([n, ip]) => ip === server && n.startsWith('cr-'));
      if (hit) return hit[0];
    }
    return 'UnKnown';
  }

  /** ping/tracert accept names; they go through the resolver cache like any app. */
  private lookup(target: string | undefined): { ip: number; label: string } | { error: string } {
    if (!target) return { error: 'missing' };
    const ip = parseIp(target);
    if (ip !== null) return { ip, label: target };
    const r = resolve(this.net, this.deviceId, target);
    if (!r.ok) return { error: target };
    return { ip: r.ip, label: `${fqdn(target)} [${formatIp(r.ip)}]` };
  }

  private ping(target: string | undefined, result: CliResult): void {
    const found = this.lookup(target);
    if ('error' in found) {
      result.output.push(`Ping request could not find host ${target ?? ''}. Please check the name and try again.`, '');
      return;
    }
    const dest = found.ip;
    const shown = formatIp(dest);
    const r = ping(this.net, this.deviceId, dest, 4);
    const responder = r.destDevice ? this.net.device(r.destDevice) : null;
    const baseTtl = responder && (responder.kind === 'pc' || responder.kind === 'server') ? 128 : 255;
    const gw = this.net.device(this.deviceId).running.defaultGateway;
    const lines: string[] = [];
    let rtt = 0;
    for (const mark of r.marks) {
      if (mark === '!') lines.push(`Reply from ${shown}: bytes=32 time=${r.rttMs[rtt++]}ms TTL=${baseTtl - r.hops}`);
      else if (mark === 'U') lines.push(`Reply from ${gw === null ? shown : formatIp(gw)}: Destination host unreachable.`);
      else lines.push('Request timed out.');
    }
    const received = r.successes;
    lines.push('', `Ping statistics for ${shown}:`);
    lines.push(`    Packets: Sent = 4, Received = ${received}, Lost = ${4 - received} (${(4 - received) * 25}% loss),`);
    if (received) {
      const min = Math.min(...r.rttMs);
      const max = Math.max(...r.rttMs);
      const avg = Math.round(r.rttMs.reduce((a, b) => a + b, 0) / r.rttMs.length);
      lines.push('Approximate round trip times in milli-seconds:', `    Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg}ms`);
    }
    lines.push('');
    result.output.push('', `Pinging ${found.label} with 32 bytes of data:`);
    const timeouts = [...r.marks].filter((m) => m !== '!').length;
    result.delayed = { ms: 400 + timeouts * 1000, output: lines };
  }

  private tracert(target: string | undefined, result: CliResult): void {
    const found = this.lookup(target);
    if ('error' in found) {
      result.output.push(`Unable to resolve target system name ${target ?? ''}.`, '');
      return;
    }
    const dest = found.ip;
    const hops = traceroute(this.net, this.deviceId, dest);
    result.output.push('', `Tracing route to ${found.label} over a maximum of 30 hops:`, '');
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
