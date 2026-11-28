import type { Acl, TimeRange } from './acl';
import type { InterfaceOspf, RoutingConfig } from './control/config';
import type { IosDhcpPool } from './iosDhcp';
import type { LoggingConfig, NtpConfig, SnmpConfig, Timestamps } from './mgmt';
import type { NatConfig, NatEntry, NatStats } from './nat';
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
  /** `mac access-group NAME in` (L2 ports; filters non-IP frames). */
  macAccessGroup?: string;
  /** DHCP snooping / DAI per-port settings, `ip verify source`, `ip dhcp relay information trusted`. */
  snoopTrust?: boolean;
  snoopRate?: number;
  daiTrust?: boolean;
  /** `ip arp inspection limit rate N` (absent = 15 pps on untrusted ports; null = `none`). */
  daiRate?: number | null;
  verifySource?: boolean;
  relayInfoTrusted?: boolean;
  /** `ip nat inside` / `ip nat outside`. */
  nat?: 'inside' | 'outside';
  /** `bandwidth` (kbps), `delay` (tens of microseconds), `mtu` and `ip mtu`. */
  bandwidth?: number;
  delay?: number;
  mtu?: number;
  ipMtu?: number;
  /** `ip ospf ...` settings. */
  ospf?: InterfaceOspf;
  /** `spanning-tree ...` on the port. */
  stp?: PortStp;
  /** `switchport port-security ...`. */
  portSecurity?: PortSecurity;
  /** `channel-group N mode ...`. */
  channelGroup?: { id: number; mode: ChannelMode };
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
  /** `exec-timeout M S` (absent = IOS default 10 0; [0, 0] = never). */
  execTimeout?: [number, number];
  /** Stored as type 7 (set by `service password-encryption` or `password 7 ...`). */
  passwordEncrypted?: boolean;
}

export interface LocalUser {
  privilege: number;
  /** `username X secret Y` (hashed in config) or `username X password Y` (plain text). */
  secret: string | null;
  password: string | null;
  /** The password is stored as type 7. */
  passwordEncrypted?: boolean;
}

/** `archive`: where `archive config` (and write-memory / time-period) put copies of the running config. */
export interface ArchiveConfig {
  path: string | null;
  writeMemory: boolean;
  /** Minutes between automatic archives. */
  timePeriod: number | null;
  maximum: number | null;
}

export interface MacAclEntry {
  action: 'permit' | 'deny';
  /** null = any. */
  src: { mac: string; mask: string } | null;
  dst: { mac: string; mask: string } | null;
}

export interface MacAcl {
  name: string;
  entries: MacAclEntry[];
}

export interface VlanMapEntry {
  seq: number;
  action: 'forward' | 'drop';
  matchIp: string[];
  matchMac: string[];
}

export interface SnoopingConfig {
  enabled: boolean;
  vlans: number[];
  /** Insert option 82 (on by default). */
  option82: boolean;
}

export interface DaiConfig {
  vlans: number[];
  /** `ip arp inspection filter ACL vlan N [static]`. */
  filters: { acl: string; vlans: number[]; static: boolean }[];
  validate: ('src-mac' | 'dst-mac' | 'ip')[];
}

export interface SourceBinding {
  mac: string;
  vlan: number;
  ip: Ipv4;
  iface: string;
}

export interface ArpAclEntry {
  action: 'permit' | 'deny';
  /** null = any. */
  ip: Ipv4 | null;
  mac: string | null;
}

/** A NetSmart OS image file. */
export interface OsImage {
  family: string;
  version: string;
  size: number;
  md5: string;
  /** A download that didn't finish or got mangled: its MD5 won't match and it won't boot. */
  corrupt?: boolean;
}

export interface SnoopBinding {
  mac: string;
  ip: Ipv4;
  vlan: number;
  iface: string;
  expires: number;
}

/** A saved configuration file (flash:, or on a TFTP server). Keeps the exact config so restores are faithful. */
export interface StoredFile {
  text: string;
  config: DeviceConfig;
  time: number;
  /** Device ID the configuration came from. */
  from: string;
}

/** Interface error counters (runtime; cleared by `clear counters`). */
export interface IfCounters {
  crc: number;
  runts: number;
  lateCollisions: number;
  collisions: number;
  deferred: number;
  /** Sim time the counters were last cleared. */
  since: number;
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
  /** `ip nat pool` and `ip nat inside source ...` rules. */
  nat?: NatConfig;
  /** IOS DHCP server: pools, excluded ranges, and `no service dhcp` (false). */
  dhcpPools?: Record<string, IosDhcpPool>;
  dhcpExcluded?: [Ipv4, Ipv4][];
  serviceDhcp?: boolean;
  /** Spanning tree, errdisable recovery and VTP (absent = IOS defaults). */
  stp?: SwitchStp;
  errdisable?: { causes: string[]; interval: number };
  vtp?: VtpConfig;
  /** Dynamic routing: OSPF, EIGRP, RIP and BGP. */
  routing?: RoutingConfig;
  /** Syslog, timestamps, SNMP and NTP (absent = IOS defaults). */
  logging?: LoggingConfig;
  timestamps?: Timestamps;
  snmp?: SnmpConfig;
  ntp?: NtpConfig;
  /** `ip name-server` and `ip host`. */
  nameServers?: Ipv4[];
  hosts?: Record<string, Ipv4>;
  /** Hardening: `service password-encryption`, `enable password`, `security passwords min-length`, `login block-for`. */
  servicePasswordEncryption?: boolean;
  enablePassword?: { pw: string; encrypted: boolean } | null;
  minPasswordLength?: number;
  loginBlock?: { blockFor: number; attempts: number; within: number; quietAcl: string | null } | null;
  bannerLogin?: string | null;
  /** Time ranges, MAC ACLs, VLAN access maps and `vlan filter`. */
  timeRanges?: Record<string, TimeRange>;
  macAcls?: Record<string, MacAcl>;
  vlanMaps?: Record<string, VlanMapEntry[]>;
  vlanFilters?: { map: string; vlans: number[] }[];
  /** DHCP snooping, dynamic ARP inspection and static IP source bindings. */
  snooping?: SnoopingConfig;
  dai?: DaiConfig;
  sourceBindings?: SourceBinding[];
  arpAcls?: Record<string, ArpAclEntry[]>;
  /** `ip dhcp relay information trust-all`. */
  relayTrustAll?: boolean;
  /** `boot system flash:<image>` entries, in order. */
  bootSystem?: string[];
  bannerExec?: string | null;
  archive?: ArchiveConfig | null;
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
  /** NAT translation table and counters (runtime state, cleared by `clear ip nat translation *`). */
  natTable?: NatEntry[];
  natStats?: NatStats;
  /** IOS DHCP bindings per pool (MAC -> address) and detected conflicts. */
  dhcpBindings?: Record<string, Record<string, Ipv4>>;
  dhcpConflicts?: { ip: Ipv4; at: number }[];
  /** Err-disabled ports and why (cleared by shutdown/no shutdown or errdisable recovery). */
  errDisabled?: Record<string, { cause: string; at: number }>;
  /** Port security: dynamically learned MACs and violation counters. */
  psecLearned?: Record<string, string[]>;
  psecViolations?: Record<string, { count: number; lastMac: string }>;
  /** VTP configuration revision of the VLAN database. */
  vtpRevision?: number;
  /** `clock set`: offset from true time, and when it was set (cleared by a reload). */
  clockOffset?: number;
  clockSetAt?: number;
  /** IOS resolver cache (`show hosts`, temp entries). */
  hostCache?: Record<string, { ip: Ipv4; at: number }>;
  /** Interface error counters (duplex mismatch). */
  ifCounters?: Record<string, IfCounters>;
  /** Runs a TFTP server (the NOC PC). */
  tftpd?: boolean;
  /** Files on flash: (network gear) or in the TFTP root (the NOC PC). */
  files?: Record<string, StoredFile>;
  /** `archive`: files written so far, oldest first, the next number and when the last automatic one ran. */
  archiveFiles?: string[];
  archiveNext?: number;
  archiveAt?: number;
  /** `login block-for`: recent failed logins and the end of quiet mode. */
  loginFailures?: number[];
  quietUntil?: number;
  /** `clear mac address-table dynamic`: when the table was last flushed. */
  macClearedAt?: number;
  /** DHCP snooping bindings (learned from DHCP through this switch), keyed by MAC. */
  snoopBindings?: Record<string, SnoopBinding>;
  /** Switch ports whose hardware has died: no link, whatever is plugged in. */
  deadPorts?: string[];
  /** Labels stuck above switch ports (physical: the config doesn't change them). */
  portLabels?: Record<string, string>;
  /** Printer firmware version. */
  firmware?: string;
  /** A PC's driver for the office printers (a broken one means that PC can't print). */
  printDriver?: { version: string; ok: boolean };
  /** Packets dropped by dynamic ARP inspection. */
  daiDrops?: number;
  /** OS images on flash: (or in a TFTP root), and the image the device is running. */
  images?: Record<string, OsImage>;
  image?: string;
  /** When each image arrived on flash (for `dir`). */
  imageTimes?: Record<string, number>;
  /** What the console printed while choosing an image at the last boot. */
  bootNotes?: string[];
  /** ROMMON variables (IP_ADDRESS, TFTP_SERVER, ...). */
  rommonVars?: Record<string, string>;
  /** Stuck in ROMMON: no bootable image was found. */
  rommon?: boolean;
  /** `reload in` / `reload at`: when the scheduled reload happens. */
  reloadAt?: number;
  /** Last `%CDP-4-DUPLEX_MISMATCH` message, per interface. */
  duplexLogAt?: Record<string, number>;
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
  /** The card itself has died (hardware): only replacing it helps. */
  failed?: boolean;
}

export const CURRENT_NIC_DRIVER = '4.2.1';

export interface DhcpLease {
  ip: Ipv4;
  prefix: number;
  gateway: Ipv4 | null;
  dns: Ipv4 | null;
  server: Ipv4;
  obtainedAt: number;
  /** null = infinite; absent = 8 days (Windows server default). */
  leaseMs?: number | null;
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
  /** null when the pool hands out no gateway / DNS (an IOS pool without default-router or dns-server). */
  gateway: Ipv4 | null;
  dns: Ipv4 | null;
  /** MAC -> fixed address. */
  reservations: Record<string, Ipv4>;
  /** MAC -> address currently handed out. */
  leases: Record<string, Ipv4>;
  /** IOS: `ip dhcp excluded-address` ranges (inclusive). */
  excluded?: [Ipv4, Ipv4][];
  /** IOS: addresses found in use when offering (`show ip dhcp conflict`). */
  conflicts?: { ip: Ipv4; at: number }[];
  /** Lease length; null = infinite. Absent = the Windows default of 8 days. */
  leaseMs?: number | null;
  /** IOS pool name. */
  pool?: string;
}

export interface DhcpServer {
  scopes: DhcpScope[];
}

export type LinkStatus = 'up' | 'down' | 'admin-down';

export interface InterfaceState {
  link: LinkStatus;
  protocol: 'up' | 'down';
  /** Why the port is err-disabled, or an EtherChannel member's flag. */
  err?: string;
  /** EtherChannel member that couldn't bundle. */
  suspended?: boolean;
}

export type ChannelMode = 'on' | 'active' | 'passive' | 'desirable' | 'auto';

export interface PortStp {
  portfast?: 'enable' | 'trunk' | 'disable';
  bpduguard?: 'enable' | 'disable';
  bpdufilter?: 'enable' | 'disable';
  guard?: 'root' | 'loop' | 'none';
  cost?: number;
  priority?: number;
}

export interface PortSecurity {
  enabled: boolean;
  max: number;
  violation: 'shutdown' | 'restrict' | 'protect';
  sticky: boolean;
  macs: string[];
  stickyMacs: string[];
}

export interface SwitchStp {
  mode: 'pvst' | 'rapid-pvst';
  /** `spanning-tree vlan <list> priority N` entries, in order. */
  priorities: { vlans: number[]; priority: number }[];
  /** `no spanning-tree vlan <list>`. */
  disabled: number[];
  portfastDefault: boolean;
  bpduguardDefault: boolean;
  bpdufilterDefault: boolean;
  loopguardDefault: boolean;
}

export interface VtpConfig {
  mode: 'server' | 'client' | 'transparent' | 'off';
  domain: string | null;
  password: string | null;
  version: 1 | 2 | 3;
}

export function isSwitchKind(kind: DeviceKind): boolean {
  return kind === 'switch' || kind === 'l3switch';
}

export function isHostKind(kind: DeviceKind): boolean {
  return kind === 'pc' || kind === 'server' || kind === 'printer';
}
