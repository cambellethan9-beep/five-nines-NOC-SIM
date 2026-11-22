import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { reachService } from '../src/game/services';
import { type7Decode, type7Encode, updateQuietMode } from '../src/sim/hardening';
import type { ConsoleSession } from '../src/sim/host';
import { HostShell } from '../src/sim/host';
import { parseIp } from '../src/sim/ip';
import { ping } from '../src/sim/routing';
import { run } from './helpers';
import { TEMPLATES } from '../src/game/templates';
import { Rng } from '../src/sim/rng';

const office = () => {
  const o = buildOffice();
  for (const id of ['ws03', 'ws12']) o.net.device(id).powered = true;
  o.net.commit({ silent: true });
  return o;
};

function type(session: ConsoleSession, commands: string[]): string {
  const out: string[] = [];
  for (const cmd of commands) {
    const prompt = session.promptText();
    const echo = session.secretInput ? '' : cmd;
    const r = session.input(cmd);
    out.push(prompt + echo, ...r.output, ...(r.delayed?.output ?? []));
  }
  return out.join('\n');
}

const tick = (net: ReturnType<typeof office>['net'], seconds: number) => {
  for (let i = 0; i < seconds; i += 5) net.advance(5000);
};

describe('duplex mismatch', () => {
  it('hard-coding one end makes the auto end fall back to half: CRC on the full side, late collisions on the half side, lost pings', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'int fa0/2', 'speed 100', 'duplex full', 'end']);
    expect(net.duplexMismatch('core1', 'FastEthernet0/2')).toBe(true);
    expect(net.negotiatedDuplex('fs01', 'GigabitEthernet0')).toBe('half');
    tick(net, 120);
    const core = run(net, 'core1', ['en', 'show interfaces fa0/2']);
    expect(core).toContain('Full-duplex, 100Mb/s');
    expect(core).toMatch(/[1-9]\d* input errors, [1-9]\d* CRC/);
    expect(core).toMatch(/[1-9]\d* runts/);
    const counters = net.device('fs01').ifCounters!['GigabitEthernet0'];
    expect(counters.lateCollisions).toBeGreaterThan(0);
    expect(counters.crc).toBe(0);
    expect(run(net, 'core1', ['en', 'show interfaces counters errors'])).toMatch(/Fa0\/2\s+\d+\s+[1-9]\d*/);
    expect(run(net, 'core1', ['en', 'show interfaces status'])).toMatch(/Fa0\/2.*connected\s+20\s+full\s+100/);
    // Traffic still flows, but it's lossy.
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
    let lost = 0;
    for (let i = 0; i < 20; i++) lost += 5 - ping(net, 'core1', parseIp('10.10.20.11')!).successes;
    expect(lost).toBeGreaterThan(0);
    // Back to auto on both ends: clean link, and clear counters zeroes them.
    run(net, 'core1', ['en', 'conf t', 'int fa0/2', 'speed auto', 'duplex auto', 'end', 'clear counters', '']);
    expect(net.duplexMismatch('core1', 'FastEthernet0/2')).toBe(false);
    tick(net, 30);
    expect(run(net, 'core1', ['en', 'show interfaces fa0/2'])).toContain('0 input errors, 0 CRC');
  });

  it('CDP reports a mismatch between two switches', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'int g0/1', 'speed 100', 'duplex full', 'end']);
    tick(net, 10);
    const logs = net.logs.map((l) => `${l.device}: ${l.message}`).join('\n');
    expect(logs).toMatch(/core1: %CDP-4-DUPLEX_MISMATCH: duplex mismatch discovered on GigabitEthernet0\/1 \(not half duplex\), with CR-ACC1 GigabitEthernet0\/1 \(half duplex\)\./);
  });
});

describe('MAC address table', () => {
  it('shows where each station is, follows trunks, filters, and relearns after a clear', () => {
    const { net } = office();
    const mac = net.device('ws03').hardware['FastEthernet0'].mac;
    const port = net.peerOf('ws03', 'FastEthernet0')!;
    expect(port.device).toBe('acc1');
    const short = port.iface.replace('FastEthernet', 'Fa');
    const acc = run(net, 'acc1', ['show mac address-table address ' + mac]);
    expect(acc).toMatch(new RegExp(`\\s+\\d+\\s+${mac.replace(/\./g, '\\.')}\\s+DYNAMIC\\s+${short.replace('/', '\\/')}`));
    expect(acc).toContain('Total Mac Addresses for this criterion: 1');
    // On the core, the same PC is behind the uplink to CR-ACC1.
    expect(run(net, 'core1', ['show mac address-table address ' + mac])).toMatch(/DYNAMIC\s+Gi0\/1/);
    expect(run(net, 'core1', ['show mac address-table'])).toMatch(/All\s+0100\.0ccc\.cccc\s+STATIC\s+CPU/);
    expect(run(net, 'acc1', ['show mac address-table interface ' + port.iface])).toContain(mac);
    expect(run(net, 'acc1', ['show mac address-table count'])).toContain('Mac Entries for Vlan 10:');
    expect(run(net, 'acc1', ['show mac address-table address 00zz.1234.5678'])).toContain("% Invalid input detected at '^' marker.");
    run(net, 'acc1', ['en', 'clear mac address-table dynamic']);
    expect(run(net, 'acc1', ['show mac address-table address ' + mac])).toContain('Total Mac Addresses for this criterion: 0');
    tick(net, 45);
    expect(run(net, 'acc1', ['show mac address-table address ' + mac])).toContain('Total Mac Addresses for this criterion: 1');
  });
});

describe('hardening', () => {
  it('type 7 is reversible and service password-encryption hides clear-text passwords', () => {
    expect(type7Decode(type7Encode('Cedar2019!'))).toBe('Cedar2019!');
    expect(type7Decode('0822455D0A16')).toBe('cisco');
    const { net } = office();
    run(net, 'rtr1', ['en', 'conf t', 'username backup password 0 Cedar2019!', 'line con 0', 'password console1', 'end']);
    expect(run(net, 'rtr1', ['en', 'show run'])).toContain('username backup privilege 15 password 0 Cedar2019!');
    run(net, 'rtr1', ['en', 'conf t', 'service password-encryption', 'end']);
    const cfg = run(net, 'rtr1', ['en', 'show run']);
    expect(cfg).toContain('service password-encryption');
    expect(cfg).toContain(`username backup privilege 15 password 7 ${type7Encode('Cedar2019!')}`);
    expect(cfg).toContain(` password 7 ${type7Encode('console1')}`);
    expect(cfg).not.toContain('Cedar2019!');
  });

  it('security passwords min-length refuses short passwords', () => {
    const { net } = office();
    const out = run(net, 'core1', ['en', 'conf t', 'security passwords min-length 10', 'enable secret short', 'username x secret alsoshort']);
    expect(out.match(/% Password too short - must be at least 10 characters\. Password configuration failed/g)?.length).toBe(2);
    expect(net.device('core1').running.users.x).toBeUndefined();
    expect(run(net, 'core1', ['en', 'show run'])).toContain('security passwords min-length 10');
  });

  it('login block-for: too many failures puts the router in quiet mode, and the quiet-mode ACL lets the NOC in', () => {
    const o = office();
    const { net } = o;
    run(net, 'rtr1', ['en', 'conf t', 'line vty 0 4', 'transport input ssh telnet', 'end']);
    run(net, 'rtr1', ['en', 'conf t', 'login block-for 120 attempts 3 within 60', 'end']);
    const pc = new HostShell(net, 'noc', o.hostOptions.noc);
    // A different username gets no key login, so it's asked for a password.
    type(pc, ['ssh hacker@10.0.0.1', 'yes', 'a', 'b', 'c']);
    expect(net.logs.some((l) => l.message.startsWith('%SEC_LOGIN-1-QUIET_MODE_ON'))).toBe(true);
    expect(run(net, 'rtr1', ['show login'])).toContain('Router presently in Quiet-Mode.');
    expect(type(pc, ['ssh nocadmin@10.0.0.1'])).toContain('Connection refused');
    run(net, 'rtr1', ['en', 'conf t', 'access-list 5 permit 10.10.99.50', 'login quiet-mode access-class 5', 'end']);
    expect(pc.promptText()).toBe('C:\\Users\\nocadmin>');
    type(pc, ['ssh nocadmin@10.0.0.1']);
    expect(pc.promptText()).toBe('CR-RTR1#');
    type(pc, ['exit']);
    net.advance(121000);
    updateQuietMode(net);
    expect(run(net, 'rtr1', ['show login'])).toContain('Router presently in Normal-Mode.');
  });

  it('exec-timeout logs an idle SSH session out; banners show at login', () => {
    const o = office();
    const { net } = o;
    run(net, 'acc1', ['en', 'conf t', 'banner login ^Authorized access only^', 'banner exec ^CR-ACC1: change window is Tue 22:00^', 'line vty 0 15', 'exec-timeout 2 0', 'end']);
    const pc = new HostShell(net, 'noc', o.hostOptions.noc);
    const login = type(pc, ['ssh nocadmin@10.10.99.11', 'yes']);
    expect(login).toContain('Authorized access only');
    expect(login).toContain('CR-ACC1: change window is Tue 22:00');
    expect(pc.promptText()).toBe('CR-ACC1#');
    net.advance(60000);
    expect(pc.pollLogs().join('\n')).not.toContain('closed');
    net.advance(61000);
    expect(pc.pollLogs().join('\n')).toContain('Connection to 10.10.99.11 closed by remote host.');
    expect(pc.promptText()).toBe('C:\\Users\\nocadmin>');
    expect(run(net, 'acc1', ['en', 'show run | include exec-timeout|banner'])).toMatch(/banner exec \^C.*\^C[\s\S]*banner login \^CAuthorized access only\^C[\s\S]* exec-timeout 2 0/);
  });
});

describe('config backup and restore', () => {
  it('copy running-config tftp: puts the config on the NOC PC; copy tftp: running-config merges it back', () => {
    const { net } = office();
    const out = run(net, 'core1', ['en', 'copy running-config tftp:', '10.10.99.50', '']);
    expect(out).toContain('Address or name of remote host []? 10.10.99.50');
    expect(out).toContain('Destination filename [cr-core1-confg]? ');
    expect(out).toMatch(/!!\n\d+ bytes copied in [\d.]+ secs/);
    expect(net.device('noc').files!['cr-core1-confg'].from).toBe('core1');
    // Lose a description, shut a port, then merge the backup back in.
    run(net, 'core1', ['en', 'conf t', 'int fa0/2', 'no description', 'int fa0/23', 'no shutdown', 'end']);
    const back = run(net, 'core1', ['en', 'copy tftp://10.10.99.50/cr-core1-confg running-config', '', '', '']);
    expect(back).toContain('Loading cr-core1-confg from 10.10.99.50 (via Vlan99): !');
    expect(net.device('core1').running.interfaces['FastEthernet0/2'].description).toBeTruthy();
    // A merge only adds: the spare port stays up because the file never says "no shutdown".
    expect(net.device('core1').running.interfaces['FastEthernet0/23'].shutdown).toBe(false);
  });

  it('a TFTP server it cannot reach times out', () => {
    const { net } = office();
    expect(run(net, 'core1', ['en', 'copy run tftp://10.10.99.77/x', '', ''])).toContain('%Error opening tftp://10.10.99.77/x (Timed out)');
  });

  it('archive with write-memory, show archive, differences, and configure replace rolls a bad change back', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'archive', 'path flash:archive', 'write-memory', 'end', 'write memory']);
    expect(run(net, 'core1', ['en', 'show archive'])).toMatch(/1\s+flash:archive-1 <- Most Recent/);
    expect(run(net, 'core1', ['en', 'dir flash:'])).toContain('archive-1');
    // A bad change takes the servers' port down.
    run(net, 'core1', ['en', 'conf t', 'int fa0/2', 'shutdown', 'end']);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(false);
    expect(run(net, 'core1', ['en', 'show archive config differences flash:archive-1'])).toMatch(/interface FastEthernet0\/2\n \+shutdown/);
    const r = run(net, 'core1', ['en', 'configure replace flash:archive-1 list', 'y']);
    expect(r).toContain('Rollback Done');
    expect(r).toContain(' no shutdown');
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
  });
});

describe('pack 9 tickets, solved the way a player would', () => {
  const start = (id: string) => {
    const o = buildOffice('ops');
    const t = TEMPLATES.find((x) => x.id === id)!;
    const ctx = { net: o.net, office: o, rng: new Rng(id), busyPcs: new Set([o.tutorial.pcId]), activeTemplates: new Set<string>(), usedTemplates: new Set<string>() };
    const draft = t.build(ctx, JSON.parse(JSON.stringify(t.plan(ctx))));
    draft.inject();
    return { o, draft };
  };

  it('rogue device: follow the MAC from the core to the access port and shut it', () => {
    const { o, draft } = start('rogue-device');
    const mac = /MAC (\S+)\./.exec(draft.description)![1];
    const core = run(o.net, 'core1', ['show mac address-table address ' + mac]);
    const uplink = /DYNAMIC\s+(Gi0\/\d)/.exec(core)![1];
    const sw = uplink === 'Gi0/1' ? 'acc1' : 'acc2';
    const port = /DYNAMIC\s+(Fa0\/\d+)/.exec(run(o.net, sw, ['show mac address-table address ' + mac]))![1];
    expect(draft.check()).toBe(false);
    run(o.net, sw, ['en', 'conf t', `int ${port}`, 'shutdown', 'end']);
    expect(draft.check()).toBe(true);
  });

  it('hardening audit: four commands on CR-RTR1, and the motd alone does not count', () => {
    const { o, draft } = start('hardening-audit');
    expect(run(o.net, 'rtr1', ['en', 'show run | include username backup'])).toContain('password 0 Cedar2019!');
    run(o.net, 'rtr1', ['en', 'conf t', 'service password-encryption', 'line vty 0 15', 'exec-timeout 10 0', 'exit', 'login block-for 120 attempts 5 within 60', 'end']);
    expect(draft.check()).toBe(false);
    run(o.net, 'rtr1', ['en', 'conf t', 'banner login #Authorized access only#', 'end']);
    expect(draft.check()).toBe(true);
  });

  it('config backups: copy each device to the TFTP server', () => {
    const { o, draft } = start('config-backups');
    for (const id of ['rtr1', 'core1', 'acc1']) run(o.net, id, ['en', 'copy run tftp://10.10.99.50/x-' + id, '', '']);
    expect(draft.check()).toBe(false);
    run(o.net, 'acc2', ['en', 'conf t', 'archive', 'path tftp://10.10.99.50/$h', 'end', 'archive config']);
    expect(draft.check()).toBe(true);
  });
});
