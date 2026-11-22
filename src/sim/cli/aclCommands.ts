// ACL commands: `access-list N ...`, `ip access-list standard|extended NAME` (and its sub-mode),
// `ip access-group` on interfaces, `access-class` on vty lines, and the show/clear commands.

import { addEntry, isExtendedNumber, isStandardNumber, parseEntry, rangeActive, reflexiveNames, resequence, showAcl, type Acl, type AclType } from '../acl';
import { aclEnv } from '../routing';
import { macEntryText, timeRangeLines } from './securityCommands';
import { formatIp } from '../ip';
import { caret, commit, type Ctx, type Tree } from './context';
import type { Args } from './parser';

const HA: Record<string, string> = {
  'access-list': 'Add an access list entry',
  num: 'IP access list number (1-99 standard, 100-199 extended, 1300-1999 and 2000-2699 expanded)',
  rest: 'permit | deny | remark',
  ip: 'Global IP configuration subcommands',
  standard: 'Standard Access List',
  extended: 'Extended Access List',
  name: 'Access-list name or number',
  permit: 'Specify packets to forward',
  deny: 'Specify packets to reject',
  remark: 'Access list entry comment',
  text: 'Comment up to 100 characters',
  seq: 'Sequence Number',
  no: 'Negate a command or set its defaults',
  'access-group': 'Specify access control for packets',
  in: 'inbound packets',
  out: 'outbound packets',
  'access-class': 'Filter connections based on an IP access list',
  'access-lists': 'List access lists',
  clear: 'Reset functions',
  counters: 'Clear access list counters',
  show: 'Show running system information',
  interface: 'IP interface status and configuration',
  if: 'Interface name',
};

const acls = (c: Ctx): Record<string, Acl> => (c.dev.running.acls ??= {});

function getOrCreate(c: Ctx, name: string, type: AclType, named: boolean): Acl | null {
  const existing = acls(c)[name];
  if (existing) {
    if (existing.type !== type) {
      c.out.push('% Access-list type conflicts with prior definition');
      return null;
    }
    return existing;
  }
  const acl: Acl = { name, type, named, entries: [] };
  acls(c)[name] = acl;
  return acl;
}

/** Adds "permit ..."/"deny ..."/"remark ..." text to an ACL, with IOS-style errors. `at` is where the text starts. */
function addText(c: Ctx, acl: Acl, text: string, at: number, seq?: number): void {
  const m = /^\s*(\S+)/.exec(text);
  if (m && 'remark'.startsWith(m[1].toLowerCase()) && m[1].length >= 3) {
    const remark = text.slice(text.indexOf(m[1]) + m[1].length).trim().slice(0, 100);
    if (!remark) return void c.out.push('% Incomplete command.', '');
    addEntry(acl, { remark }, seq);
    return commit(c);
  }
  const r = parseEntry(acl.type, text, at, { named: acl.named });
  if (!r.ok) {
    if (r.incomplete) c.out.push('% Incomplete command.', '');
    else caret(c, r.caret);
    return;
  }
  const err = addEntry(acl, r.entry, seq);
  if (err) c.out.push(err);
  commit(c);
}

export function addAclGlobal(t: Tree): void {
  t.add('access-list <number:num:1-2699> <line:rest>', HA, (c, a) => {
    const n = a.num as number;
    const type: AclType | null = isStandardNumber(n) ? 'standard' : isExtendedNumber(n) ? 'extended' : null;
    if (!type) return caret(c, a['@num'] as number);
    const acl = getOrCreate(c, String(n), type, false);
    if (acl) addText(c, acl, a.rest as string, a['@rest'] as number);
  });
  t.add('no access-list <number:num:1-2699>', HA, (c, a) => {
    delete acls(c)[String(a.num)];
    commit(c);
  });
  const enter = (type: AclType) => (c: Ctx, a: Args) => {
    const name = a.name as string;
    if (/^\d+$/.test(name)) {
      const n = Number(name);
      if (!(type === 'standard' ? isStandardNumber(n) : isExtendedNumber(n))) {
        c.out.push('% Invalid access list name.');
        return;
      }
    } else if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      c.out.push('% Invalid access list name.');
      return;
    }
    const acl = getOrCreate(c, name, type, !/^\d+$/.test(name));
    if (acl) c.s.enterAcl(name, type);
  };
  t.add('ip access-list standard <word:name>', HA, enter('standard'));
  t.add('ip access-list extended <word:name>', HA, enter('extended'));
  const remove = (type: AclType) => (c: Ctx, a: Args) => {
    const acl = acls(c)[a.name as string];
    if (acl && acl.type === type) delete acls(c)[acl.name];
    commit(c);
  };
  t.add('ip access-list resequence <word:name> <number:start:1-2147483647> <number:step:1-2147483647>', { ...HA, resequence: 'Resequence Access List', start: 'Starting Sequence Number', step: 'Step to increment the sequence number' }, (c, a) => {
    const acl = acls(c)[a.name as string];
    if (!acl) return void c.out.push(`% Access list ${a.name} does not exist`);
    resequence(acl, a.start as number, a.step as number);
    commit(c);
  });
  t.add('no ip access-list standard <word:name>', HA, remove('standard'));
  t.add('no ip access-list extended <word:name>', HA, remove('extended'));
}

/** The `(config-std-nacl)#` / `(config-ext-nacl)#` sub-mode. */
export function addAclMode(t: Tree): void {
  const acl = (c: Ctx) => acls(c)[c.s.aclContext!];
  const withAction = (action: string) => (c: Ctx, a: Args) => {
    const at = (a['@rest'] as number) - action.length - 1;
    addText(c, acl(c), `${action} ${a.rest as string}`, at);
  };
  t.add('permit <line:rest>', HA, withAction('permit'));
  t.add('deny <line:rest>', HA, withAction('deny'));
  t.add('remark <line:text>', HA, (c, a) => addText(c, acl(c), `remark ${a.text as string}`, 0));
  t.add('<number:seq:1-2147483647> <line:rest>', HA, (c, a) => addText(c, acl(c), a.rest as string, a['@rest'] as number, a.seq as number));
  t.add('no <number:seq:1-2147483647>', HA, (c, a) => {
    const l = acl(c);
    l.entries = l.entries.filter((e) => e.seq !== a.seq);
    commit(c);
  });
  const removeMatching = (action: string) => (c: Ctx, a: Args) => {
    const l = acl(c);
    const r = parseEntry(l.type, `${action} ${a.rest as string}`, 0);
    if (!r.ok) return void c.out.push('% Incomplete command.', '');
    const key = JSON.stringify(r.entry);
    l.entries = l.entries.filter((e) => JSON.stringify({ ...e, seq: undefined }) !== key);
    commit(c);
  };
  t.add('evaluate <word:name>', { ...HA, evaluate: 'Evaluate an access list', name: 'IP reflexive access list name' }, (c, a) => {
    const l = acl(c);
    if (l.type !== 'extended' || !l.named) return caret(c, 0);
    addEntry(l, { evaluate: a.name as string });
    commit(c);
  });
  t.add('no evaluate <word:name>', HA, (c, a) => {
    const l = acl(c);
    l.entries = l.entries.filter((e) => e.evaluate !== a.name);
    commit(c);
  });
  t.add('no permit <line:rest>', HA, removeMatching('permit'));
  t.add('no deny <line:rest>', HA, removeMatching('deny'));
}

export function addAclInterface(t: Tree): void {
  const set = (dir: 'in' | 'out') => (c: Ctx, a: Args) => {
    for (const name of c.s.ifContext) {
      const ifc = c.dev.running.interfaces[name];
      if (!ifc) continue;
      // On a switchport this is a port ACL, which filters inbound traffic only.
      if (ifc.switchport && dir === 'out') return void c.out.push('% Out ACLs are not supported on Layer 2 interfaces');
      ifc.accessGroup = { ...ifc.accessGroup, [dir]: String(a.name) };
    }
    commit(c);
  };
  const clear = (dir: 'in' | 'out') => (c: Ctx) => {
    for (const name of c.s.ifContext) {
      const ifc = c.dev.running.interfaces[name];
      if (ifc?.accessGroup) delete ifc.accessGroup[dir];
    }
    commit(c);
  };
  t.add('ip access-group <word:name> in', HA, set('in'));
  t.add('ip access-group <word:name> out', HA, set('out'));
  t.add('no ip access-group in', HA, clear('in'));
  t.add('no ip access-group out', HA, clear('out'));
  t.add('no ip access-group <word:name> in', HA, clear('in'));
  t.add('no ip access-group <word:name> out', HA, clear('out'));
}

export function addAclLine(t: Tree): void {
  const line = (c: Ctx) => c.dev.running.lines[c.s.lineContext!];
  t.add('access-class <word:name> in', HA, (c, a) => void (line(c).accessClass = String(a.name)));
  t.add('no access-class <word:name> in', HA, (c) => void (line(c).accessClass = null));
  t.add('no access-class in', HA, (c) => void (line(c).accessClass = null));
}

function showAll(c: Ctx, name?: string, ipOnly = false): void {
  const all = Object.values(c.dev.running.acls ?? {}).filter((a) => name === undefined || a.name === name);
  const hits = c.dev.aclHits ?? {};
  const env = aclEnv(c.net, c.dev);
  const sorted = all.sort((a, b) => {
    const na = /^\d+$/.test(a.name) ? Number(a.name) : Infinity;
    const nb = /^\d+$/.test(b.name) ? Number(b.name) : Infinity;
    return na - nb || a.name.localeCompare(b.name);
  });
  for (const acl of sorted) c.out.push(...showAcl(acl, hits, env));
  for (const r of reflexiveNames(c.dev.running.acls ?? {})) if (name === undefined || name === r) c.out.push(`Reflexive IP access list ${r}`);
  if (ipOnly) return;
  for (const m of Object.values(c.dev.running.macAcls ?? {})) {
    if (name !== undefined && m.name !== name) continue;
    c.out.push(`Extended MAC access list ${m.name}`, ...m.entries.map((e) => `    ${macEntryText(e)}`));
  }
}

export function addAclShows(t: Tree, privileged: boolean): void {
  t.add('show access-lists', HA, (c) => showAll(c));
  t.add('show access-lists <word:name>', HA, (c, a) => showAll(c, String(a.name)));
  t.add('show ip access-lists', HA, (c) => showAll(c, undefined, true));
  t.add('show ip access-lists <word:name>', HA, (c, a) => showAll(c, String(a.name), true));
  t.add('show time-range', { ...HA, 'time-range': 'Time range' }, (c) => c.out.push(...showTimeRanges(c)));
  t.add('show time-range <word:name>', { ...HA, 'time-range': 'Time range' }, (c, a) => c.out.push(...showTimeRanges(c, String(a.name))));
  t.add('show ip interface <iface:if>', HA, (c, a) => {
    const ifc = c.dev.running.interfaces[a.if as string];
    if (!ifc) return caret(c, a['@if'] as number);
    const st = c.net.state(c.dev.id, ifc.name);
    const status = st.link === 'admin-down' ? 'administratively down' : st.link;
    c.out.push(`${ifc.name} is ${status}, line protocol is ${st.protocol}`);
    if (!ifc.ip || ifc.switchport) {
      c.out.push('  Internet protocol processing disabled');
      return;
    }
    const helpers = ifc.helpers ?? [];
    c.out.push(
      `  Internet address is ${formatIp(ifc.ip.address)}/${ifc.ip.prefix}`,
      '  Broadcast address is 255.255.255.255',
      '  Address determined by setup command',
      '  MTU is 1500 bytes',
      helpers.length ? `  Helper addresses are ${helpers.map(formatIp).join('\n                       ')}` : '  Helper address is not set',
      '  Directed broadcast forwarding is disabled',
      '  Outgoing Common access list is not set ',
      `  Outgoing access list is ${ifc.accessGroup?.out ?? 'not set'}`,
      '  Inbound Common access list is not set ',
      `  Inbound  access list is ${ifc.accessGroup?.in ?? 'not set'}`,
      '  Proxy ARP is enabled',
      '  Local Proxy ARP is disabled',
      '  Security level is default',
      '  Split horizon is enabled',
      '  ICMP redirects are always sent',
      '  ICMP unreachables are always sent',
      '  ICMP mask replies are never sent',
      '  IP fast switching is enabled',
    );
  });
  if (privileged) {
    t.add('clear access-list counters', HA, (c) => void (c.dev.aclHits = {}));
    t.add('clear access-list counters <word:name>', HA, (c, a) => {
      const hits = c.dev.aclHits ?? {};
      for (const k of Object.keys(hits)) if (k.startsWith(`${a.name}:`)) delete hits[k];
    });
  }
}

function showTimeRanges(c: Ctx, only?: string): string[] {
  const out: string[] = [];
  const now = aclEnv(c.net, c.dev).now!;
  const used = new Set(Object.values(c.dev.running.acls ?? {}).flatMap((a) => a.entries.map((e) => e.timeRange).filter(Boolean)));
  for (const [name, r] of Object.entries(c.dev.running.timeRanges ?? {})) {
    if (only !== undefined && name !== only) continue;
    out.push(`time-range entry: ${name} (${rangeActive(r, now) ? 'active' : 'inactive'})`, ...timeRangeLines(r).map((l) => `  ${l.trim()}`));
    if (used.has(name)) out.push('   used in: IP ACL entry');
  }
  return out;
}
