// Employees learn from your docs. They read everything in Docs (your notebook and the inherited docs, with your
// edits) and pick up concrete facts: who sits on which switch port, what IP a device has, which VLAN a port is in.
// When a ticket touches something your docs describe correctly, they work faster and fix it more often. When your
// docs are stale, they believe them anyway: they look in the wrong place, and juniors may change the wrong port.
// Nothing flags a stale doc for you. Keeping documentation current is the whole point.

import { NETWORK_DEVICES, PRINTERS, SERVERS, type Person } from '../content/office';
import type { Block } from '../content/docs';
import { formatIp } from '../sim/ip';
import type { Network } from '../sim/network';
import type { Game } from './game';
import type { Ticket } from './queue';

const NIC = 'FastEthernet0';

export interface DocFact {
  /** Device the fact is about (a PC id, server, printer or network device). */
  subject: string;
  /** Switch and port it says the subject plugs into. */
  sw?: string;
  port?: string;
  ip?: string;
  vlan?: number;
  /** Where it's written, e.g. 'the "Desk and port map" doc' or 'your note "Printers"'. */
  where: string;
  /** What it says, in words. */
  says: string;
  /** When the source was last updated (inherited docs you never edited count as oldest). */
  updated: number;
  mine: boolean;
}

export interface DocAdvice {
  /** Added to an employee's chance to fix (and they're quicker) when your docs are right about this ticket. */
  bonus: number;
  /** The stale fact they went by, if any. */
  stale: { where: string; says: string; port: { sw: string; port: string } | null } | null;
}

const longPort = (kind: string, n: string) => `${/^g/i.test(kind) ? 'GigabitEthernet' : 'FastEthernet'}0/${n}`;
const shortPort = (p: string) => p.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi');

/** Text lines of a doc: table rows become "Head: cell" lines so a row reads as one statement. */
function blockLines(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if ('p' in b) out.push(b.p);
    else if ('note' in b) out.push(b.note);
    else if ('code' in b) out.push(...b.code.split('\n'));
    else if ('ul' in b) out.push(...b.ul);
    else if ('ol' in b) out.push(...b.ol);
    else if ('table' in b) for (const r of b.table.rows) out.push(r.map((c, i) => `${b.table.head[i] ?? ''}: ${c}`).join(' | '));
  }
  return out;
}

/** Every hostname the docs could use for a device: what it's called now and what it was called at hand-off. */
function hostnames(net: Network): { name: string; id: string; kind: 'switch' | 'other' }[] {
  const list: { name: string; id: string; kind: 'switch' | 'other' }[] = [];
  for (const d of NETWORK_DEVICES) list.push({ name: d.hostname, id: d.id, kind: 'switch' });
  for (const s of SERVERS) list.push({ name: s.hostname, id: s.id, kind: 'other' });
  for (const p of PRINTERS) list.push({ name: p.hostname, id: p.id, kind: 'other' });
  for (const d of [...NETWORK_DEVICES, ...SERVERS, ...PRINTERS]) {
    const now = net.device(d.id).running.hostname;
    if (now !== d.hostname) list.push({ name: now, id: d.id, kind: NETWORK_DEVICES.some((x) => x.id === d.id) ? 'switch' : 'other' });
  }
  return list.sort((a, b) => b.name.length - a.name.length);
}

const has = (line: string, word: string) => new RegExp(`(^|[^A-Za-z0-9-])${word.replace(/[-]/g, '\\-')}($|[^A-Za-z0-9-])`, 'i').test(line);

/** Facts in one line of text. */
function factsInLine(line: string, people: Person[], names: ReturnType<typeof hostnames>, src: Omit<DocFact, 'subject' | 'says'>): DocFact[] {
  const ports = [...line.matchAll(/\b(Fa|FastEthernet|Gi|GigabitEthernet)\s?0\/(\d{1,2})\b/gi)].map((m) => longPort(m[1], m[2]));
  const ips = [...line.matchAll(/\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)].map((m) => m[1]);
  const vlan = line.match(/\bVLAN:?\s*(\d{1,4})\b/i);
  const devs = names.filter((n) => has(line, n.name));
  const seen = new Set<string>();
  const uniqDevs = devs.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  const switches = uniqDevs.filter((d) => d.kind === 'switch');
  const person = people.find((p) => has(line, p.name) || has(line, p.pc));
  const out: DocFact[] = [];
  // Two ports on a line is a link between switches (uplinks table): not a seat.
  if (ports.length > 1) return out;
  const subject = person?.pcId ?? uniqDevs.find((d) => d.kind === 'other')?.id;
  if (subject) {
    const label = person?.name ?? uniqDevs.find((d) => d.id === subject)!.name;
    if (ports.length === 1) {
      const sw = switches[0]?.id;
      out.push({ ...src, subject, sw, port: ports[0], vlan: vlan ? Number(vlan[1]) : undefined, says: `${label} is on ${switches[0] ? `${switches[0].name} ` : ''}${shortPort(ports[0])}${vlan ? ` in VLAN ${vlan[1]}` : ''}` });
    }
    if (ips.length === 1) out.push({ ...src, subject, ip: ips[0], says: `${label} is ${ips[0]}` });
    return out;
  }
  // A network device and one IP: its management address.
  if (switches.length === 1 && ips.length === 1 && !ports.length) out.push({ ...src, subject: switches[0].id, ip: ips[0], says: `${switches[0].name} is ${ips[0]}` });
  return out;
}

let cache: { key: string; facts: DocFact[] } | null = null;

/** All facts in your docs right now. */
export function docFacts(game: Game): DocFact[] {
  const key = `${game.notes.map((n) => `${n.id}@${n.updated}:${n.body.length}`).join(',')}|${game.docs.map((d) => `${d.id}@${d.editedAt ?? 0}`).join(',')}|${game.net.version}`;
  if (cache?.key === key) return cache.facts;
  const names = hostnames(game.net);
  const people = game.office.people;
  const facts: DocFact[] = [];
  for (const d of game.docs) {
    const src = { where: `the "${d.title}" doc`, updated: d.editedAt ?? -Infinity, mine: d.editedAt !== undefined };
    for (const line of blockLines(d.blocks)) facts.push(...factsInLine(line, people, names, src));
  }
  for (const n of game.notes) {
    const src = { where: `your note "${n.title}"`, updated: n.updated, mine: true };
    for (const line of n.body.split('\n')) facts.push(...factsInLine(line.replace(/^»\s*/, ''), people, names, src));
  }
  cache = { key, facts };
  return facts;
}

/** Is a fact still true on the network? */
export function factTrue(net: Network, f: DocFact): boolean {
  const dev = net.device(f.subject);
  const nic = dev.kind === 'switch' || dev.kind === 'router' ? null : Object.keys(dev.hardware).includes(NIC) ? NIC : Object.keys(dev.hardware)[0];
  if (f.port) {
    const peer = nic ? net.peerOf(f.subject, nic) : null;
    if (!peer || peer.iface !== f.port || (f.sw && peer.device !== f.sw)) return false;
    if (f.vlan !== undefined) {
      const sp = net.device(peer.device).running.interfaces[peer.iface]?.switchport;
      if (sp && (sp.accessVlan ?? 1) !== f.vlan) return false;
    }
    return true;
  }
  // A DHCP client's address is whatever it was handed (or APIPA while it's broken): that's a symptom, not a doc.
  if (f.ip && dev.hostNet?.dhcp) return true;
  if (f.ip) return Object.values(dev.running.interfaces).some((i) => i.ip && formatIp(i.ip.address) === f.ip);
  return true;
}

/** Devices a ticket is about: the people on it, their switch, and anything its faults point at. */
function ticketSubjects(net: Network, t: Ticket): Set<string> {
  const set = new Set<string>([t.draft.reporter.pcId, ...t.draft.pcs]);
  const peer = net.peerOf(t.draft.reporter.pcId, NIC);
  if (peer) set.add(peer.device);
  const scan = (v: unknown) => {
    if (typeof v === 'string' && net.devices.has(v)) set.add(v);
  };
  for (const v of Object.values(t.draft.params)) scan(v);
  try {
    for (const a of JSON.parse(String(t.draft.params.atoms ?? '[]')) as { site: Record<string, unknown> }[]) Object.values(a.site).forEach(scan);
  } catch {
    // hand-built tickets have no atoms
  }
  return set;
}

/** What your docs do for an employee working this ticket. */
export function adviceFor(game: Game, t: Ticket): DocAdvice {
  const net = game.net;
  const subjects = ticketSubjects(net, t);
  const relevant = docFacts(game).filter((f) => subjects.has(f.subject));
  if (!relevant.length) return { bonus: 0, stale: null };
  // For each thing they need to know, they go by the most recently updated doc that says anything about it.
  const latest = new Map<string, DocFact>();
  for (const f of relevant) {
    const k = `${f.subject}:${f.port ? 'port' : 'ip'}`;
    const cur = latest.get(k);
    if (!cur || f.updated > cur.updated) latest.set(k, f);
  }
  const used = [...latest.values()];
  const wrong = used.find((f) => !factTrue(net, f));
  if (wrong) return { bonus: 0, stale: { where: wrong.where, says: wrong.says, port: wrong.sw && wrong.port ? { sw: wrong.sw, port: wrong.port } : null } };
  return { bonus: used.some((f) => f.mine) ? 0.15 : 0.1, stale: null };
}
