// IPv4 helpers. Addresses are stored as unsigned 32-bit numbers.

export type Ipv4 = number;

export function parseIp(text: string): Ipv4 | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

export function formatIp(ip: Ipv4): string {
  return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');
}

export function prefixToMask(prefix: number): Ipv4 {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** Returns the prefix length, or null if the mask is not contiguous. */
export function maskToPrefix(mask: Ipv4): number | null {
  let prefix = 0;
  let seenZero = false;
  for (let bit = 31; bit >= 0; bit--) {
    const set = (mask >>> bit) & 1;
    if (set && seenZero) return null;
    if (set) prefix++;
    else seenZero = true;
  }
  return prefix;
}

export function networkOf(ip: Ipv4, prefix: number): Ipv4 {
  return (ip & prefixToMask(prefix)) >>> 0;
}

export function broadcastOf(ip: Ipv4, prefix: number): Ipv4 {
  return (networkOf(ip, prefix) | (~prefixToMask(prefix) >>> 0)) >>> 0;
}

export function inSubnet(ip: Ipv4, network: Ipv4, prefix: number): boolean {
  return networkOf(ip, prefix) === networkOf(network, prefix);
}

/** Classful prefix length (A=8, B=16, C=24), used for `show ip route` grouping. */
export function classfulPrefix(ip: Ipv4): number {
  const first = ip >>> 24;
  if (first < 128) return 8;
  if (first < 192) return 16;
  return 24;
}

export function maskHex(mask: Ipv4): string {
  return '0x' + mask.toString(16).toUpperCase().padStart(8, '0');
}
