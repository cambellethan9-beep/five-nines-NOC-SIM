import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { HostShell } from '../src/sim/host';
import type { CliResult } from '../src/sim/cli/session';
import { run } from './helpers';

const MIN = 60_000;

function say(shell: HostShell, cmd: string): string {
  const r: CliResult = shell.input(cmd);
  return [...r.output, ...(r.delayed?.output ?? [])].join('\n');
}

function freshGame(seed = 'dd') {
  const game = new Game(seed);
  game.queue.tickets[0].draft.fix(); // get the tutorial out of the way
  game.tick(5_000);
  const pc = game.net.device('ws03');
  pc.powered = true;
  game.net.commit({ silent: true });
  return { game, pc, shell: new HostShell(game.net, 'ws03') };
}

describe('DHCP', () => {
  it('staff PCs get their reserved address from CR-DC01 through the core relay', () => {
    const { shell } = freshGame();
    const out = say(shell, 'ipconfig /all');
    expect(out).toContain('DHCP Enabled. . . . . . . . . . . : Yes');
    expect(out).toContain('IPv4 Address. . . . . . . . . . . : 10.10.10.103(Preferred)');
    expect(out).toContain('DHCP Server . . . . . . . . . . . : 10.10.20.10');
    expect(out).toContain('DNS Servers . . . . . . . . . . . : 10.10.20.10');
  });

  it('with the helper address gone, /renew times out and the PC falls back to APIPA; putting it back fixes it', () => {
    const { game, shell } = freshGame();
    run(game.net, 'core1', ['en', 'conf t', 'int vlan 10', 'no ip helper-address', 'end']);
    expect(say(shell, 'ipconfig /renew')).toContain('unable to contact your DHCP server');
    const after = say(shell, 'ipconfig');
    expect(after).toMatch(/Autoconfiguration IPv4 Address\. \. : 169\.254\.\d+\.\d+/);
    expect(after).toContain('Subnet Mask . . . . . . . . . . . : 255.255.0.0');
    run(game.net, 'core1', ['en', 'conf t', 'int vlan 10', 'ip helper-address 10.10.20.10', 'end']);
    expect(run(game.net, 'core1', ['en', 'show run'])).toContain('interface Vlan10\n description STAFF gateway\n ip address 10.10.10.1 255.255.255.0\n ip helper-address 10.10.20.10');
    expect(say(shell, 'ipconfig /renew')).toContain('IPv4 Address. . . . . . . . . . . : 10.10.10.103');
  });

  it('bouncing the switch port makes the PC ask again (Windows renews on link-up)', () => {
    const { game, pc } = freshGame();
    run(game.net, 'core1', ['en', 'conf t', 'int vlan 10', 'no ip helper-address', 'end']);
    run(game.net, 'acc1', ['en', 'conf t', 'int fa0/3', 'shut', 'end']);
    game.tick(5_000);
    run(game.net, 'acc1', ['en', 'conf t', 'int fa0/3', 'no shut', 'end']);
    game.tick(5_000);
    expect(pc.hostNet!.apipa).toBe(true);
    run(game.net, 'core1', ['en', 'conf t', 'int vlan 10', 'ip helper-address 10.10.20.10', 'end']);
    run(game.net, 'acc1', ['en', 'conf t', 'int fa0/3', 'shut', 'end']);
    game.tick(5_000);
    run(game.net, 'acc1', ['en', 'conf t', 'int fa0/3', 'no shut', 'end']);
    game.tick(5_000);
    expect(pc.hostNet!.apipa).toBe(false);
  });

  it('release and renew; renew with no cable says the media is disconnected', () => {
    const { game, shell } = freshGame();
    expect(say(shell, 'ipconfig /release')).not.toContain('IPv4 Address');
    expect(say(shell, 'ipconfig /renew')).toContain('10.10.10.103');
    game.net.linkAt('ws03', 'FastEthernet0')!.cable = 'unplugged';
    game.net.commit();
    expect(say(shell, 'ipconfig /renew')).toContain('media disconnected');
  });

  it('the moved-desk ticket now also needs a renew (or a port bounce) after the VLAN fix', () => {
    const game = new Game('moved');
    game.queue.tickets[0].draft.fix();
    game.queue.startTemplate('moved-desk', 0);
    game.tick(5_000);
    const t = game.queue.tickets.find((x) => x.draft.templateId === 'moved-desk')!;
    const pcId = t.draft.reporter.pcId;
    const sw = String(t.draft.params.to);
    const port = String(t.draft.params.port).replace('FastEthernet', 'fa');
    expect(game.net.device(pcId).hostNet!.apipa).toBe(true);
    run(game.net, sw, ['en', 'conf t', `int ${port}`, 'switchport mode access', 'switchport access vlan 10', 'end']);
    expect(game.queue.resolve(t.id, 'vlan fixed').ok).toBe(false);
    say(new HostShell(game.net, pcId), 'ipconfig /renew');
    expect(game.queue.resolve(t.id, 'renewed').ok).toBe(true);
  });
});

describe('DNS', () => {
  it('ping and nslookup by name', () => {
    const { shell } = freshGame();
    expect(say(shell, 'ping cr-fs01')).toContain('Pinging cr-fs01.cedarridge.local [10.10.20.11] with 32 bytes of data:');
    expect(say(shell, 'nslookup ledgerworks')).toContain('Name:    ledgerworks.cedarridge.local\nAddress:  10.10.20.12');
    expect(say(shell, 'nslookup nope')).toContain("can't find nope.cedarridge.local: Non-existent domain");
    expect(say(shell, 'ping nope')).toContain('Ping request could not find host nope');
  });

  it('a stale cache entry: nslookup is right, ping is wrong, displaydns shows why, flushdns fixes it', () => {
    const game = new Game('dns');
    game.queue.tickets[0].draft.fix();
    game.queue.startTemplate('stale-dns', 0);
    game.tick(5_000);
    const t = game.queue.tickets.find((x) => x.draft.templateId === 'stale-dns')!;
    const pc = game.net.device(t.draft.reporter.pcId);
    pc.powered = true;
    game.net.commit({ silent: true });
    game.tick(5_000);
    expect(game.health.perUser[pc.id]).toContain('ledger');
    const shell = new HostShell(game.net, pc.id);
    expect(say(shell, 'nslookup ledgerworks')).toContain('Address:  10.10.20.12');
    expect(say(shell, 'ping ledgerworks')).toContain('[10.10.20.99]');
    expect(say(shell, 'ipconfig /displaydns')).toContain('A (Host) Record . . . : 10.10.20.99');
    expect(game.queue.resolve(t.id, 'tried').ok).toBe(false);
    expect(say(shell, 'ipconfig /flushdns')).toContain('Successfully flushed the DNS Resolver Cache.');
    expect(say(shell, 'ping ledgerworks')).toContain('[10.10.20.12]');
  });

  it('with the DNS server unreachable, names stop working but IPs still do', () => {
    const { game, shell } = freshGame();
    run(game.net, 'core1', ['en', 'conf t', 'int fa0/1', 'shut', 'end']); // CR-DC01's port
    expect(say(shell, 'nslookup cr-fs01')).toContain('DNS request timed out.');
    expect(say(shell, 'ping 10.10.20.11')).toContain('Reply from 10.10.20.11');
  });
});

describe('saving', () => {
  it('leases, APIPA state and DNS caches survive a save', () => {
    const { game, pc } = freshGame('save-dd');
    run(game.net, 'core1', ['en', 'conf t', 'int vlan 10', 'no ip helper-address', 'end']);
    say(new HostShell(game.net, 'ws03'), 'ipconfig /renew');
    say(new HostShell(game.net, 'ws05'), 'ping cr-fs01');
    const restored = new Game(game.seed, JSON.parse(JSON.stringify(game.toSave())));
    expect(restored.net.device('ws03').hostNet!.apipa).toBe(true);
    expect(pc.hostNet!.apipa).toBe(true);
    expect(Object.keys(restored.net.device('ws05').hostNet!.dnsCache)).toContain('cr-fs01.cedarridge.local');
    restored.tick(MIN);
  });
});
