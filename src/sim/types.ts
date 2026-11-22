import type { Acl } from './acl';
import type { Ipv4 } from './ip';

export type DeviceKind = 'router' | 'switch' | 'l3switch' | 'pc' | 'server' | 'printer';

export type SwitchportMode = 'access' | 'trunk' | 'dynamic auto' | 'dynamic desirable';

export interface SwitchportConfig {
  mode: SwitchportMode;
  accessVlan: number;
  nativeVlan: number;
  /** 'all' or an explicit sorted list of VLAN IDs. */
  allowedVlans: 'all' | number[];
  /** Only meaningful on L3 switches, which must be set to dot1q before trunking. */
  trunkEncapsulation: 'auto' | 'dot1q' | 'isl';
}

export interface IpAssignment {
  address: Ipv4;
  prefix: number;
}

export interface InterfaceConfig {
  name: string;
  shutdown: boolean;
  description: string | null;
  ip: IpAssignment | null;
  /** null means the port is routed (router ports, hosts, `no switchport`). */
  switchport: SwitchportConfig | null;
  /** Subinterface encapsulation (router-on-a-stick). `type` is absent on older saves, meaning dot1q. */
  encapsulation: { vlan: number; native: boolean; type?: 'dot1q' | 'isl' } | null;
  speed: 'auto' | 10 | 100 | 1000;
  duplex: 'auto' | 'half' | 'full';
  /** `ip helper-address`: DHCP relay targets (absent on older saves). */
  helpers?: Ipv4[];
  /** `ip access-group NAME in|out`. */
  accessGroup?: { in?: string; out?: string };
}

export interface StaticRoute {
  network: Ipv4;
  prefix: number;
  nextHop: Ipv4 | null;
  exitIf: string | null;
  distance: number;
}

export interface LineConfig {
  password: string | null;
  /** 'line' = `login` (line password), 'local' = `login local` (username database). */
  login: 'none' | 'line' | 'local';
  transport: { ssh: boolean; telnet: boolean };
  loggingSynchronous: boolean;
  /** `rotary N`: lets the line accept SSH on a custom port set with `ip ssh port P rotary N`. */
  rotary: number | null;
  /** `access-class NAME in`: standard ACL on who may connect (vty lines). */
  accessClass?: string | null;
}

export interface LocalUser {
  privilege: number;
  /** `username X secret Y` (hashed in config) or `username X password Y` (plain text). */
  secret: string | null;
  password: string | null;
}

/** Everything that `show running-config` covers. Copied to startup-config by `write memory`. */
export interface DeviceConfig {
  hostname: string;
  interfaces: Record<string, InterfaceConfig>;
  staticRoutes: StaticRoute[];
  ipRouting: boolean;
  defaultGateway: Ipv4 | null;
  domainLookup: boolean;
  domainName: string | null;
  enableSecret: string | null;
  bannerMotd: string | null;
  users: Record<string, LocalUser>;
  lines: { con: LineConfig; vty: LineConfig };
  ssh: { version: 1 | 2 | null; port: number; rotary: number | null };
  /**
   * RSA keys from `crypto key generate rsa`. Not shown in `show run`, but like real IOS they are
   * only kept across a reload if saved. `serial` changes each time keys are regenerated.
   */
  crypto: { bits: number; serial: number } | null;
  /** `ip ssh pubkey-chain`: client keys trusted for passwordless login. */
  authorizedKeys: { user: string; key: string }[];
  /** IPv4 access lists by name or number (absent on older saves). */
  acls?: Record<string, Acl>;
}

export interface PortHardware {
  mac: string;
  maxSpeed: 100 | 1000;
}

export interface ArpEntry {
  mac: string;
  iface: string;
  learnedAt: number;
}

export interface Device {
  id: string;
  kind: DeviceKind;
  /** NetSmart model name, e.g. "NS-R4300". */
  model: string;
  serial: string;
  baseMac: string;
  /** Physical ports that exist on the hardware. */
  hardware: Record<string, PortHardware>;
  running: DeviceConfig;
  /** null after `erase startup-config`. */
  startup: DeviceConfig | null;
  /** VLAN database. Like real switches, stored in vlan.dat, not in the running config. */
  vlans: Record<number, { name: string }>;
  powered: boolean;
  /** False for gear you don't own (the ISP's router): no console, no credentials. */
  managed: boolean;
  /** Sim time (ms) when the current boot finishes, or null if not booting. */
  bootingUntil: number | null;
  /** Sim time (ms) the device last finished booting, for `show version` uptime. */
  bootedAt: number;
  arp: Map<Ipv4, ArpEntry>;
  /** Network adapter on PCs, servers and printers (what Device Manager shows). */
  nic?: NicState;
  /** Windows IP settings on PCs (absent = fully static, as on servers, printers and older saves). */
  hostNet?: HostNet;
  /** DHCP and DNS services (CR-DC01 runs both). */
  dhcpServer?: DhcpServer;
  dnsZone?: Record<string, Ipv4>;
  /** ACL hit counters ("ACL:seq" -> matches). Runtime state, not config; reset by `clear access-list counters`. */
  aclHits?: Record<string, number>;
}

export interface LinkEnd {
  device: string;
  iface: string;
}

export interface Link {
  id: string;
  a: LinkEnd;
  b: LinkEnd;
  /** Hidden physical state: a cut or unplugged cable. */
  /** 'unplugged' = the cable came out of the PC's NIC; 'cut' = damaged cable. */
  cable: 'ok' | 'cut' | 'unplugged';
}

export interface NicState {
  /** 'outdated' = present but won't start (Code 10); 'missing' = no driver installed at all. */
  driver: 'ok' | 'outdated' | 'missing';
  version: string;
  /** Disabled by the user in Windows. */
  disabled: boolean;
}

export const CURRENT_NIC_DRIVER = '4.2.1';

export interface DhcpLease {
  ip: Ipv4;
  prefix: number;
  gateway: Ipv4 | null;
  dns: Ipv4 | null;
  server: Ipv4;
  obtainedAt: number;
}

export interface HostNet {
  /** "Obtain an IP address automatically" vs static. */
  dhcp: boolean;
  lease: DhcpLease | null;
  /** True while on a 169.254.x.x address because DHCP got no answer. */
  apipa: boolean;
  /** DNS server when static (DHCP-assigned DNS comes from the lease). */
  dnsServer: Ipv4 | null;
  /** Windows DNS resolver cache: name -> address and when it expires (sim ms). */
  dnsCache: Record<string, { ip: Ipv4; expires: number }>;
}

export interface DhcpScope {
  network: Ipv4;
  prefix: number;
  start: Ipv4;
  end: Ipv4;
  gateway: Ipv4;
  dns: Ipv4;
  /** MAC -> fixed address. */
  reservations: Record<string, Ipv4>;
  /** MAC -> address currently handed out. */
  leases: Record<string, Ipv4>;
}

export interface DhcpServer {
  scopes: DhcpScope[];
}

export type LinkStatus = 'up' | 'down' | 'admin-down';

export interface InterfaceState {
  link: LinkStatus;
  protocol: 'up' | 'down';
}

export function isSwitchKind(kind: DeviceKind): boolean {
  return kind === 'switch' || kind === 'l3switch';
}

export function isHostKind(kind: DeviceKind): boolean {
  return kind === 'pc' || kind === 'server' || kind === 'printer';
}
