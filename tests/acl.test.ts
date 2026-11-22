import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { reachService, serviceHealth } from '../src/game/services';
import { CliSession } from '../src/sim/cli/session';
import { HostShell } from '../src/sim/host';
import { run } from './helpers';

const say = (sh: HostShell, cmd: string) => {
  const r = sh.input(cmd);
  return [...r.output, ...(r.delayed?.output ?? [])].join('\n');
};

function office() {
  const o = buildOffice();
  o.net.device('ws03').powered = true;
  o.net.commit({ silent: true });
  return o;
}

describe('ACL configuration', () => {
  it('numbered standard and extended lists render like IOS, normalizing host bits', () => {
    const { net } = office();
    const out = run(net, 'core1', [
      'en', 'conf t',
      'access-list 10 permit 10.10.99.50',
      'access-list 10 permit 10.10.10.77 0.0.0.255',
      'access-list 10 deny any',
      'access-list 110 permit tcp 10.10.10.0 0.0.0.255 host 10.10.20.12 eq 443',
      'access-list 110 permit tcp any any eq www',
      'access-list 110 deny ip any any log',
      'end', 'show run | include access-list',
    ]);
    expect(out).toContain('access-list 10 permit 10.10.99.50\naccess-list 10 permit 10.10.10.0 0.0.0.255\naccess-list 10 deny   any');
    expect(out).toContain('access-list 110 permit tcp 10.10.10.0 0.0.0.255 host 10.10.20.12 eq 443\naccess-list 110 permit tcp any any eq www\naccess-list 110 deny ip any any log');
    const show = run(net, 'core1', ['en', 'show access-lists']);
    expect(show).toContain('Standard IP access list 10\n    10 permit 10.10.99.50\n    20 permit 10.10.10.0, wildcard bits 0.0.0.255\n    30 deny   any');
    expect(show).toContain('Extended IP access list 110\n    10 permit tcp 10.10.10.0 0.0.0.255 host 10.10.20.12 eq 443');
  });

  it('named lists have a sub-mode with sequence numbers, insertion, removal and remarks', () => {
    const { net } = office();
    const s = new CliSession(net, 'core1');
    const out = run(net, 'core1', [
      'en', 'conf t', 'ip access-list extended SERVERS-IN',
      'remark staff to servers',
      'permit tcp 10.10.10.0 0.0.0.255 host 10.10.20.11 eq 445',
      'deny ip any any',
      '15 permit udp any host 10.10.20.10 eq domain',
      'no 20',
      'end', 'show ip access-lists SERVERS-IN', 'show run | section ip access-list',
    ], s);
    expect(out).toContain('CR-CORE1(config-ext-nacl)#');
    expect(out).toContain('Extended IP access list SERVERS-IN\n    10 permit tcp 10.10.10.0 0.0.0.255 host 10.10.20.11 eq 445\n    15 permit udp any host 10.10.20.10 eq domain');
    expect(out).not.toContain('    20 deny');
    expect(out).toContain('ip access-list extended SERVERS-IN\n remark staff to servers\n permit tcp 10.10.10.0 0.0.0.255 host 10.10.20.11 eq 445\n permit udp any host 10.10.20.10 eq domain');
  });

  it('errors: caret under the bad token, incomplete entries, type conflicts, bad numbers', () => {
    const { net } = office();
    const s = new CliSession(net, 'core1');
    run(net, 'core1', ['en', 'conf t'], s);
    const bad = run(net, 'core1', ['access-list 110 permit tcp any hots 10.10.20.12'], s).split('\n');
    expect(bad[1].indexOf('^')).toBe('CR-CORE1(config)#access-list 110 permit tcp any '.length);
    expect(run(net, 'core1', ['access-list 110 permit tcp any'], s)).toContain('% Incomplete command.');
    expect(run(net, 'core1', ['access-list 250 permit any'], s)).toContain("% Invalid input detected at '^' marker.");
    run(net, 'core1', ['ip access-list standard MGMT', 'exit'], s);
    expect(run(net, 'core1', ['ip access-list extended MGMT'], s)).toContain('% Access-list type conflicts with prior definition');
  });
});

describe('ACL enforcement', () => {
  it('an inbound ACL on the staff SVI blocks SMB but allows what it permits; counters climb', () => {
    const o = office();
    const { net } = o;
    run(net, 'core1', [
      'en', 'conf t',
      'ip access-list extended STAFF-IN',
      'permit tcp 10.10.10.0 0.0.0.255 host 10.10.20.12 eq 443',
      'permit udp any any eq domain',
      'permit icmp any any',
      'exit', 'int vlan 10', 'ip access-group STAFF-IN in', 'end',
    ]);
    expect(reachService(net, 'ws03', '10.10.20.12')).toBe(true);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(false); // SMB hits the implicit deny
    expect(serviceHealth(net, o).down.files).toBeGreaterThan(0);
    const show = run(net, 'core1', ['en', 'show access-lists STAFF-IN']);
    expect(show).toMatch(/10 permit tcp 10\.10\.10\.0 0\.0\.0\.255 host 10\.10\.20\.12 eq 443 \(\d+ match(es)?\)/);
    expect(run(net, 'core1', ['en', 'sh ip int vlan 10 | i access list'])).toContain('Inbound  access list is STAFF-IN');
  });

  it('wrong direction: the same ACL outbound on the staff SVI does nothing to staff traffic going out', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'access-list 120 deny tcp any any eq 445', 'access-list 120 permit ip any any', 'int vlan 10', 'ip access-group 120 out', 'end']);
    // Requests leave via Vlan20, so only the replies to staff pass Vlan10 outbound (source port 445, not destination).
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
    run(net, 'core1', ['en', 'conf t', 'int vlan 10', 'no ip access-group out', 'ip access-group 120 in', 'end']);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(false);
  });

  it('ping shows U.U.U from IOS, Windows sees an unreachable reply, and traceroute shows !A', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'access-list 130 deny icmp any host 10.10.20.11', 'access-list 130 permit ip any any', 'int vlan 99', 'ip access-group 130 in', 'end']);
    const pc = new HostShell(net, 'noc');
    expect(say(pc, 'ping 10.10.20.11')).toContain('Destination host unreachable');
    expect(say(pc, 'ping 10.10.20.12')).toContain('Reply from 10.10.20.12');
    const tr = run(net, 'acc1', ['en', 'traceroute 10.10.20.11']);
    expect(tr).not.toContain('!A'); // IOS traceroute is UDP, the ACL only denies ICMP
    run(net, 'core1', ['en', 'conf t', 'no access-list 130', 'access-list 130 deny ip any host 10.10.20.11', 'access-list 130 permit ip any any', 'end']);
    expect(run(net, 'acc1', ['en', 'traceroute 10.10.20.11'])).toContain('!A');
  });

  it('established lets replies back in without opening new connections', () => {
    const { net } = office();
    // Servers may only answer; they can't open connections toward staff.
    run(net, 'core1', ['en', 'conf t', 'access-list 140 permit tcp any any established', 'access-list 140 permit udp any eq domain any', 'int vlan 20', 'ip access-group 140 in', 'end']);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
    expect(reachService(net, 'ws03', '10.10.20.10')).toBe(true);
  });

  it('a vty access-class that leaves out the NOC PC locks you out of SSH', () => {
    const { net } = office();
    run(net, 'acc1', ['en', 'conf t', 'access-list 5 permit 10.10.10.0 0.0.0.255', 'line vty 0 15', 'access-class 5 in', 'end']);
    const pc = new HostShell(net, 'noc', { user: 'nocadmin', sshKey: 'x' });
    expect(say(pc, 'ssh nocadmin@10.10.99.11')).toContain('Connection refused');
    const cfg = run(net, 'acc1', ['en', 'sh run | s line vty']);
    expect(cfg).toContain('line vty 0 4\n access-class 5 in');
  });

  it('an ACL that is applied but not defined permits everything, like IOS', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'int vlan 10', 'ip access-group NOPE in', 'end']);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
  });
});

describe('ACL tickets, solved the way a player would', () => {
  it('web filter: ping works, HTTPS does not; adding a permit for 443 fixes it', async () => {
    const { Game } = await import('../src/game/game');
    const game = new Game('aclweb');
    game.queue.tickets[0].draft.fix();
    game.queue.startTemplate('acl-web-filter', 0);
    game.tick(5000);
    const t = game.queue.tickets.find((x) => x.draft.templateId === 'acl-web-filter')!;
    const pc = game.net.device(t.draft.reporter.pcId);
    pc.powered = true;
    game.net.commit({ silent: true });
    const sh = new HostShell(game.net, pc.id);
    expect(say(sh, 'ping 10.10.20.12')).toContain('Reply from 10.10.20.12');
    expect(game.queue.resolve(t.id, 'pinged fine').ok).toBe(false);
    run(game.net, 'core1', ['en', 'conf t', 'ip access-list extended STAFF-WEB', '35 permit tcp any any eq 443', 'end']);
    expect(game.queue.resolve(t.id, 'permitted 443').ok).toBe(true);
  });

  it('printer wildcard: show run reveals the normalized entry; rewriting it fixes printing', async () => {
    const { Game } = await import('../src/game/game');
    const game = new Game('aclprn');
    game.queue.tickets[0].draft.fix();
    game.queue.startTemplate('acl-printer-wildcard', 0);
    game.tick(5000);
    const t = game.queue.tickets.find((x) => x.draft.templateId === 'acl-printer-wildcard')!;
    expect(run(game.net, 'core1', ['en', 'sh run | i access-list'])).toContain('access-list 30 permit 0.0.0.0 255.255.255.0');
    run(game.net, 'core1', ['en', 'conf t', 'no access-list 30', 'access-list 30 permit 10.10.10.0 0.0.0.255', 'end']);
    expect(game.queue.resolve(t.id, 'fixed wildcard').ok).toBe(true);
  });

  it('vty lockout: SSH is refused, so the fix happens from the console', async () => {
    const { Game } = await import('../src/game/game');
    const { nocCanManage } = await import('../src/game/ticketsAcl');
    const game = new Game('aclvty');
    game.queue.tickets[0].draft.fix();
    game.queue.startTemplate('acl-vty-lockout', 0);
    game.tick(5000);
    const t = game.queue.tickets.find((x) => x.draft.templateId === 'acl-vty-lockout')!;
    expect(nocCanManage(game.net, 'acc2', '10.10.99.12')).toBe(false);
    const port = game.net.peerOf(t.draft.reporter.pcId, 'FastEthernet0')!.iface;
    // At the console (no SSH involved): fix the ACL and the port.
    run(game.net, 'acc2', ['en', 'conf t', 'no access-list 5', 'access-list 5 permit 10.10.99.0 0.0.0.255', `int ${port}`, 'no shut', 'end']);
    expect(nocCanManage(game.net, 'acc2', '10.10.99.12')).toBe(true);
    game.tick(5000);
    expect(game.queue.resolve(t.id, 'fixed').ok).toBe(true);
  });
});
