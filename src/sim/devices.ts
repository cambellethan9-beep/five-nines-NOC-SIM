// Factories for NetSmart hardware. Each device starts with a factory-default config.

import type { Device, DeviceConfig, DeviceKind, InterfaceConfig, PortHardware } from './types';

interface ModelSpec {
  model: string;
  kind: DeviceKind;
  defaultHostname: string;
  ports: { name: string; maxSpeed: 100 | 1000 }[];
}

function range(prefix: string, from: number, to: number, maxSpeed: 100 | 1000) {
  const ports = [];
  for (let i = from; i <= to; i++) ports.push({ name: `${prefix}${i}`, maxSpeed });
  return ports;
}

export const MODELS: Record<string, ModelSpec> = {
  'NS-R4300': {
    model: 'NS-R4300',
    kind: 'router',
    defaultHostname: 'Router',
    ports: range('GigabitEthernet0/', 0, 2, 1000),
  },
  'NS-S2900': {
    model: 'NS-S2900',
    kind: 'switch',
    defaultHostname: 'Switch',
    ports: [...range('FastEthernet0/', 1, 24, 100), ...range('GigabitEthernet0/', 1, 2, 1000)],
  },
  'NS-S3600': {
    model: 'NS-S3600',
    kind: 'l3switch',
    defaultHostname: 'Switch',
    ports: [...range('FastEthernet0/', 1, 24, 100), ...range('GigabitEthernet0/', 1, 4, 1000)],
  },
  'NS-PC': { model: 'NS-PC', kind: 'pc', defaultHostname: 'PC', ports: [{ name: 'FastEthernet0', maxSpeed: 100 }] },
  'NS-PRN': { model: 'NS-PRN', kind: 'printer', defaultHostname: 'Printer', ports: [{ name: 'FastEthernet0', maxSpeed: 100 }] },
  'NS-SRV': {
    model: 'NS-SRV',
    kind: 'server',
    defaultHostname: 'Server',
    ports: [{ name: 'GigabitEthernet0', maxSpeed: 1000 }],
  },
};

let macCounter = 0x1a2b00;

function nextMacBase(): number {
  macCounter += 0x40;
  return macCounter;
}

/** Formats as IOS dotted-hex: 0011.22ab.cd01 */
export function formatMac(high: number, low: number): string {
  const hex = (high.toString(16).padStart(4, '0') + low.toString(16).padStart(8, '0')).slice(-12);
  return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
}

export function defaultInterfaceConfig(name: string, kind: DeviceKind, shutdown: boolean): InterfaceConfig {
  const switchKind = kind === 'switch' || kind === 'l3switch';
  const physical = !name.startsWith('Vlan') && !name.startsWith('Loopback') && !name.includes('.');
  return {
    name,
    shutdown,
    description: null,
    ip: null,
    switchport:
      switchKind && physical
        ? { mode: 'dynamic auto', accessVlan: 1, nativeVlan: 1, allowedVlans: 'all', trunkEncapsulation: 'auto' }
        : null,
    encapsulation: null,
    speed: 'auto',
    duplex: 'auto',
  };
}

export function factoryConfig(spec: ModelSpec): DeviceConfig {
  const interfaces: Record<string, InterfaceConfig> = {};
  // Router ports ship shut down; switch and host ports ship enabled.
  const portsShut = spec.kind === 'router';
  for (const port of spec.ports) interfaces[port.name] = defaultInterfaceConfig(port.name, spec.kind, portsShut);
  if (spec.kind === 'switch' || spec.kind === 'l3switch') {
    interfaces['Vlan1'] = defaultInterfaceConfig('Vlan1', spec.kind, true);
  }
  return {
    hostname: spec.defaultHostname,
    interfaces,
    staticRoutes: [],
    ipRouting: spec.kind === 'router',
    defaultGateway: null,
    domainLookup: true,
    domainName: null,
    enableSecret: null,
    bannerMotd: null,
    users: {},
    lines: {
      con: { password: null, login: 'none', transport: { ssh: false, telnet: false }, loggingSynchronous: false, rotary: null },
      vty: { password: null, login: 'line', transport: { ssh: true, telnet: true }, loggingSynchronous: false, rotary: null },
    },
    ssh: { version: null, port: 22, rotary: null },
    crypto: null,
    authorizedKeys: [],
  };
}

/** The default NOC username used on inherited devices and by the NOC PC's SSH client. */
export const DEFAULT_ADMIN_USER = 'nocadmin';

export function defaultVlans(kind: DeviceKind): Record<number, { name: string }> {
  if (kind !== 'switch' && kind !== 'l3switch') return {};
  return {
    1: { name: 'default' },
    1002: { name: 'fddi-default' },
    1003: { name: 'token-ring-default' },
    1004: { name: 'fddinet-default' },
    1005: { name: 'trnet-default' },
  };
}

export function createDevice(id: string, modelName: string, hostname?: string): Device {
  const spec = MODELS[modelName];
  if (!spec) throw new Error(`Unknown model ${modelName}`);
  const base = nextMacBase();
  const hardware: Record<string, PortHardware> = {};
  spec.ports.forEach((port, i) => {
    hardware[port.name] = { mac: formatMac(0x00d0, ((base + i + 1) * 0x101) >>> 0), maxSpeed: port.maxSpeed };
  });
  const running = factoryConfig(spec);
  if (hostname) running.hostname = hostname;
  return {
    id,
    kind: spec.kind,
    model: spec.model,
    serial: 'FTX' + (base * 7919).toString(36).toUpperCase().padStart(8, '0').slice(-8),
    baseMac: formatMac(0x00d0, (base * 0x101) >>> 0),
    hardware,
    running,
    startup: structuredClone(running),
    vlans: defaultVlans(spec.kind),
    powered: true,
    managed: true,
    bootingUntil: null,
    bootedAt: 0,
    arp: new Map(),
    nic: isHostModel(spec.kind) ? { driver: 'ok', version: '4.2.1', disabled: false } : undefined,
  };
}

function isHostModel(kind: DeviceKind): boolean {
  return kind === 'pc' || kind === 'server' || kind === 'printer';
}

export function cloneConfig(config: DeviceConfig): DeviceConfig {
  return structuredClone(config);
}
