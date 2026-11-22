import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { Game } from '../src/game/game';
import { reachService } from '../src/game/services';
import { HostShell } from '../src/sim/host';
import { parseIp } from '../src/sim/ip';
import { canReach } from '../src/sim/routing';
import { run } from './helpers';

const say = (sh: HostShell, cmd: string) => {
  const r = sh.input(cmd);
  return [...r.output, ...(r.delayed?.output ?? [])].join('\n');
};

function office() {
  const o = buildOffice();
  for (const id of ['ws03', 'ws12']) o.net.device(id).powered = true;
  o.net.commit({ silent: true });
  return o;
}

describe('NAT on CR-RTR1', () => {
  it('the inherited PAT config renders like IOS', () => {
    const { net } = office();
    const cfg = run(net, 'rtr1', ['en', 'show run']);
    expect(cfg).toContain('interface GigabitEthernet0/0\n description Link to CR-CORE1 Fa0/24\n ip address 10.0.0.1 255.255.255.252\n ip nat inside\n ip virtual-reassembly in');
    expect(cfg).toContain(' ip nat outside');
    expect(cfg).toContain('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
    expect(cfg).toContain('access-list 1 permit 10.10.0.0 0.0.255.255');
  });

  it('PCs browse through PAT; real traffic fills the translation table', () => {
    const { net } = office();
    expect(reachService(net, 'ws03', '8.8.8.8', true)).toBe(true);
    expect(reachService(net, 'ws12', '8.8.8.8', true)).toBe(true);
    const tr = run(net, 'rtr1', ['en', 'show ip nat translations']);
    expect(tr).toContain('Pro Inside global         Inside local          Outside local         Outside global');
    expect(tr).toMatch(/tcp 203\.0\.113\.2:51034\s+10\.10\.10\.103:51034\s+8\.8\.8\.8:443\s+8\.8\.8\.8:443/);
    expect(tr).toMatch(/tcp 203\.0\.113\.2:51035\s+10\.10\.10\.112:51034/); // second PC, next port
    const st = run(net, 'rtr1', ['en', 'show ip nat statistics']);
    expect(st).toContain('Outside interfaces:\n  GigabitEthernet0/1');
    expect(st).toContain('[Id: 1] access-list 1 interface GigabitEthernet0/1 refcount 2');
  });

  it('ping and tracert from a PC work across NAT, hops past the router included', () => {
    const { net } = office();
    const pc = new HostShell(net, 'ws03');
    expect(say(pc, 'ping 8.8.8.8')).toContain('Reply from 8.8.8.8');
    const tr = say(pc, 'tracert 8.8.8.8');
    expect(tr).toContain('203.0.113.1');
    expect(tr).toContain('Trace complete.');
  });

  it('without NAT the replies have nowhere to go', () => {
    const { net } = office();
    run(net, 'rtr1', ['en', 'conf t', 'int g0/0', 'no ip nat inside', 'end']);
    expect(reachService(net, 'ws03', '8.8.8.8')).toBe(false);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
    expect(say(new HostShell(net, 'ws03'), 'ping 8.8.8.8')).toContain('Request timed out.');
  });

  it('a static port forward publishes LedgerWorks to the outside', () => {
    const { net } = office();
    const lw = parseIp('203.0.113.2')!;
    expect(canReach(net, 'internet', lw, { proto: 'tcp', port: 443 })).toBe(false);
    run(net, 'rtr1', ['en', 'conf t', 'ip nat inside source static tcp 10.10.20.12 443 interface g0/1 443', 'end']);
    expect(canReach(net, 'internet', lw, { proto: 'tcp', port: 443 })).toBe(true);
    expect(canReach(net, 'internet', lw, { proto: 'tcp', port: 445 })).toBe(false);
    expect(run(net, 'rtr1', ['en', 'sh run | i static'])).toContain('ip nat inside source static tcp 10.10.20.12 443 interface GigabitEthernet0/1 443');
  });

  it('dynamic pool without overload runs out of addresses', () => {
    const { net } = office();
    run(net, 'rtr1', [
      'en', 'conf t', 'no ip nat inside source list 1 interface g0/1 overload',
      'ip nat pool ONE 203.0.113.2 203.0.113.2 netmask 255.255.255.252',
      'ip nat inside source list 1 pool ONE', 'end',
    ]);
    expect(reachService(net, 'ws03', '8.8.8.8', true)).toBe(true);
    expect(reachService(net, 'ws12', '8.8.8.8', true)).toBe(false);
    expect(run(net, 'rtr1', ['en', 'show ip nat statistics'])).toMatch(/Misses: [1-9]/);
  });

  it('pool errors and the "in use" guard', () => {
    const { net } = office();
    const out = run(net, 'rtr1', ['en', 'conf t', 'ip nat pool P 203.0.113.9 203.0.113.1 netmask 255.255.255.0', 'ip nat pool P 203.0.113.9 203.0.113.10 prefix-length 24', 'ip nat inside source list 1 pool P', 'no ip nat pool P']);
    expect(out).toContain('%End address less than starting address');
    expect(out).toContain('%Pool P in use, cannot destroy');
  });
});

describe('NAT tickets, solved the way a player would', () => {
  const start = (id: string) => {
    const game = new Game(`nat-${id}`);
    game.queue.tickets[0].draft.fix();
    game.queue.startTemplate(id, 0);
    game.tick(5000);
    return { game, t: game.queue.tickets.find((x) => x.draft.templateId === id)! };
  };

  it('narrowed ACL: widen access-list 1', () => {
    const { game, t } = start('nat-acl-narrowed');
    expect(game.queue.resolve(t.id, 'rebooted').ok).toBe(false);
    run(game.net, 'rtr1', ['en', 'conf t', 'access-list 1 permit 10.10.0.0 0.0.255.255', 'end']);
    expect(game.queue.resolve(t.id, 'widened ACL 1').ok).toBe(true);
  });

  it('no overload: put overload back and clear the stuck translation', () => {
    const { game, t } = start('nat-no-overload');
    game.tick(10_000);
    run(game.net, 'rtr1', ['en', 'conf t', 'ip nat inside source list 1 interface g0/1 overload', 'end', 'clear ip nat translation *']);
    expect(game.queue.resolve(t.id, 'PAT restored').ok).toBe(true);
  });

  it('inside missing: ip nat inside on the core link', () => {
    const { game, t } = start('nat-inside-missing');
    expect(run(game.net, 'rtr1', ['en', 'sh ip nat statistics'])).toContain('Inside interfaces: \n  \n');
    run(game.net, 'rtr1', ['en', 'conf t', 'int g0/0', 'ip nat inside', 'end']);
    expect(game.queue.resolve(t.id, 'nat inside').ok).toBe(true);
  });
});
