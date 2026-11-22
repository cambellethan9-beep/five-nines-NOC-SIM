import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { dhcpRequest } from '../src/sim/dhcp';
import { HostShell } from '../src/sim/host';
import { formatIp, parseIp } from '../src/sim/ip';
import { CliSession } from '../src/sim/cli/session';
import { run } from './helpers';

const say = (sh: HostShell, cmd: string) => {
  const r = sh.input(cmd);
  return [...r.output, ...(r.delayed?.output ?? [])].join('\n');
};

describe('IOS DHCP server', () => {
  it('the guest pool renders like IOS and shows its binding', () => {
    const { net } = buildOffice();
    const cfg = run(net, 'core1', ['en', 'show run']);
    expect(cfg).toContain('ip dhcp excluded-address 10.10.40.1 10.10.40.9\n!\nip dhcp pool GUEST\n network 10.10.40.0 255.255.255.0\n default-router 10.10.40.1 \n dns-server 8.8.8.8 \n lease 0 8\n!');
    const b = run(net, 'core1', ['en', 'show ip dhcp binding']);
    expect(b).toMatch(/10\.10\.40\.10\s+01[0-9a-f]{2}\.[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{2}\s+\w{3} \d{2} \d{4} \d{2}:\d{2} [AP]M\s+Automatic/);
    expect(run(net, 'core1', ['en', 'show ip dhcp pool'])).toContain(' Leased addresses               : 1');
  });

  it('a pool without default-router hands out an address but no gateway', () => {
    const { net } = buildOffice();
    run(net, 'core1', ['en', 'conf t', 'ip dhcp pool GUEST', 'no default-router', 'end']);
    const pc = new HostShell(net, 'conf1');
    const out = say(pc, 'ipconfig /renew');
    expect(out).toContain('IPv4 Address. . . . . . . . . . . : 10.10.40.10');
    expect(out).toMatch(/Default Gateway . . . . . . . . . :\s*\n/);
  });

  it('excluded addresses and conflicts are skipped; a small pool runs out', () => {
    const { net } = buildOffice();
    // Someone parks a static device on .11; the next client gets .12 and .11 shows up as a conflict.
    net.device('noc').running.interfaces['FastEthernet0'].ip = null;
    run(net, 'core1', ['en', 'conf t', 'ip dhcp pool TEST', 'network 10.10.40.0 /29', 'end']);
    const out = run(net, 'core1', ['en', 'show ip dhcp pool TEST']);
    expect(out).toContain(' Total addresses                : 6');
    // The conference PC keeps .10 from GUEST; release it and shrink GUEST to /29 to force exhaustion.
    run(net, 'core1', ['en', 'conf t', 'no ip dhcp pool TEST', 'ip dhcp pool GUEST', 'network 10.10.40.0 255.255.255.248', 'end', 'clear ip dhcp binding *']);
    expect(dhcpRequest(net, 'conf1').ok).toBe(false); // .1-.7 are all excluded
    expect(net.device('conf1').hostNet!.apipa).toBe(true);
  });

  it('errors and help in the pool sub-mode', () => {
    const { net } = buildOffice();
    const s = new CliSession(net, 'core1');
    const out = run(net, 'core1', ['en', 'conf t', 'ip dhcp pool X', 'default-router 10.1.1.1 nope', 'network 10.1.1.0 255.0.255.0'], s);
    expect(out).toContain('CR-CORE1(dhcp-config)#');
    expect(out.match(/% Invalid input detected/g)?.length).toBe(2);
  });
});

describe('IOS DNS', () => {
  it('ping by name uses ip host, then the name server; show hosts lists both', () => {
    const { net } = buildOffice();
    const out = run(net, 'core1', ['en', 'conf t', 'ip host printer2 10.10.30.22', 'ip name-server 10.10.20.10', 'end', 'ping printer2', 'ping cr-fs01']);
    expect(out).toContain('CR-CORE1#ping printer2\nType escape sequence to abort.');
    expect(out).toContain('Translating "cr-fs01"...domain server (10.10.20.10) [OK]');
    expect(out).toContain('Success rate is');
    const hosts = run(net, 'core1', ['en', 'show hosts']);
    expect(hosts).toContain('Name servers are 10.10.20.10');
    expect(hosts).toMatch(/printer2\s+None\s+\(perm, OK\)/);
    expect(hosts).toMatch(/cr-fs01\.cedarridge\.local\s+None\s+\(temp, OK\)/);
    expect(run(net, 'core1', ['en', 'sh run | i ^ip (name-server|host)'])).toContain('ip name-server 10.10.20.10\nip host printer2 10.10.30.22');
  });

  it('a typo at the EXEC asks the configured name server, or nobody when there is none', () => {
    const { net } = buildOffice();
    expect(run(net, 'acc1', ['en', 'shw'])).toContain('domain server (255.255.255.255)');
    run(net, 'acc1', ['en', 'conf t', 'ip name-server 10.10.20.10', 'end']);
    const out = run(net, 'acc1', ['en', 'shw']);
    expect(out).toContain('Translating "shw"...domain server (10.10.20.10)');
    expect(out).toContain('% Unknown command or computer name');
    run(net, 'acc1', ['en', 'conf t', 'no ip domain-lookup', 'end']);
    expect(run(net, 'acc1', ['en', 'ping cr-fs01'])).toContain('% Unrecognized host or address');
  });

  it('a guest PC resolves public names through 8.8.8.8 but not internal ones', () => {
    const { net } = buildOffice();
    const pc = new HostShell(net, 'conf1');
    expect(say(pc, 'nslookup www.example.com')).toContain('Address:  8.8.8.8');
    expect(say(pc, 'nslookup ledgerworks')).toContain('Non-existent domain');
    expect(formatIp(parseIp('8.8.8.8')!)).toBe('8.8.8.8');
  });
});

describe('guest tickets, solved the way a player would', () => {
  const start = async (id: string) => {
    const { Game } = await import('../src/game/game');
    const game = new Game(`g-${id}`);
    game.queue.tickets[0].draft.fix();
    game.queue.startTemplate(id, 0);
    game.tick(5000);
    return { game, t: game.queue.tickets.find((x) => x.draft.templateId === id)!, pc: new HostShell(game.net, 'conf1') };
  };

  it('no gateway: put default-router back, renew', async () => {
    const { game, t, pc } = await start('guest-no-gateway');
    run(game.net, 'core1', ['en', 'conf t', 'ip dhcp pool GUEST', 'default-router 10.10.40.1', 'end']);
    expect(game.queue.resolve(t.id, 'router back').ok).toBe(false); // the PC still has the old lease
    say(pc, 'ipconfig /renew');
    expect(game.queue.resolve(t.id, 'renewed').ok).toBe(true);
  });

  it('pool full: the pool shows every address leased; fix the lease, clear bindings, renew', async () => {
    const { game, t, pc } = await start('guest-pool-full');
    expect(say(pc, 'ipconfig')).toContain('Autoconfiguration IPv4 Address');
    expect(run(game.net, 'core1', ['en', 'sh ip dhcp pool GUEST'])).toContain(' Leased addresses               : 245');
    run(game.net, 'core1', ['en', 'conf t', 'ip dhcp pool GUEST', 'lease 0 8', 'end', 'clear ip dhcp binding *']);
    say(pc, 'ipconfig /renew');
    expect(game.queue.resolve(t.id, 'cleared').ok).toBe(true);
  });

  it('internal DNS: ping by IP works, names fail; dns-server 8.8.8.8 and renew', async () => {
    const { game, t, pc } = await start('guest-dns-internal');
    expect(say(pc, 'ping 8.8.8.8')).toContain('Reply from 8.8.8.8');
    expect(say(pc, 'ping www.example.com')).toContain('could not find host');
    run(game.net, 'core1', ['en', 'conf t', 'ip dhcp pool GUEST', 'dns-server 8.8.8.8', 'end']);
    say(pc, 'ipconfig /renew');
    expect(game.queue.resolve(t.id, 'dns fixed').ok).toBe(true);
  });
});
