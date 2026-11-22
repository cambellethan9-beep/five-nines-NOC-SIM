// Interface name parsing, matching IOS abbreviation rules ("g0/1", "gi 0/1", "fa0/24", "vlan10").

interface IfType {
  full: string;
  /** Short form used by `show cdp neighbors` ("Gig 0/1"). */
  cdp: string;
  /** Short form used by `show vlan` and logs ("Gi0/1"). */
  short: string;
}

export const IF_TYPES: IfType[] = [
  { full: 'FastEthernet', cdp: 'Fas', short: 'Fa' },
  { full: 'GigabitEthernet', cdp: 'Gig', short: 'Gi' },
  { full: 'Vlan', cdp: 'Vla', short: 'Vl' },
  { full: 'Loopback', cdp: 'Loo', short: 'Lo' },
  { full: 'Port-channel', cdp: 'Por', short: 'Po' },
];

export interface ParsedIfName {
  type: string; // full type, e.g. "GigabitEthernet"
  number: string; // e.g. "0/1", "0/1.10", "10"
}

/** Splits text like "gi0/1" or "Gi0/1.10" into type prefix and number. */
function split(text: string): { prefix: string; number: string } | null {
  const m = /^([a-zA-Z-]+)\s*([0-9][0-9/.]*)$/.exec(text.trim());
  if (!m) return null;
  return { prefix: m[1], number: m[2] };
}

export function parseIfName(text: string): ParsedIfName | null {
  const parts = split(text);
  if (!parts) return null;
  const prefix = parts.prefix.toLowerCase();
  const matches = IF_TYPES.filter((t) => t.full.toLowerCase().startsWith(prefix));
  if (matches.length !== 1) return null;
  if (!/^\d+(\/\d+)*(\.\d+)?$/.test(parts.number)) return null;
  return { type: matches[0].full, number: parts.number };
}

export function fullIfName(parsed: ParsedIfName): string {
  return parsed.type + parsed.number;
}

function typeOf(name: string): { type: IfType; number: string } | null {
  for (const t of IF_TYPES) {
    if (name.startsWith(t.full)) return { type: t, number: name.slice(t.full.length) };
  }
  return null;
}

export function shortIfName(name: string): string {
  const t = typeOf(name);
  return t ? t.type.short + t.number : name;
}

export function cdpIfName(name: string): string {
  const t = typeOf(name);
  return t ? `${t.type.cdp} ${t.number}` : name;
}

/** "GigabitEthernet0/1.10" -> parent "GigabitEthernet0/1", or null for a physical interface. */
export function parentIfName(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? null : name.slice(0, dot);
}

/** Sort key so Fa0/2 comes before Fa0/10. */
export function compareIfNames(a: string, b: string): number {
  const ta = typeOf(a);
  const tb = typeOf(b);
  const ia = ta ? IF_TYPES.indexOf(ta.type) : 99;
  const ib = tb ? IF_TYPES.indexOf(tb.type) : 99;
  if (ia !== ib) return ia - ib;
  const na = (ta?.number ?? a).split(/[/.]/).map(Number);
  const nb = (tb?.number ?? b).split(/[/.]/).map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? -1) - (nb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}
