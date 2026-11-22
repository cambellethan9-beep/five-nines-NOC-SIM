import { describe, expect, it } from 'vitest';
import { CliSession } from '../src/sim/cli/session';
import { createDevice } from '../src/sim/devices';
import { demo, run } from './helpers';

describe('IOS command line', () => {
  it('accepts abbreviations', () => {
    const net = demo();
    const out = run(net, 'r1', ['sh ip int br']);
    expect(out).toContain('Interface              IP-Address      OK? Method Status                Protocol');
    expect(out).toMatch(/GigabitEthernet0\/1\s+10\.0\.12\.1\s+YES manual up\s+up/);
    expect(out).toMatch(/GigabitEthernet0\/2\s+unassigned\s+YES unset\s+administratively down down/);
  });

  it('marks invalid input with a caret under the bad character', () => {
    const net = demo();
    const out = run(net, 'r1', ['en', 'show ip intx brief']).split('\n');
    const i = out.indexOf("% Invalid input detected at '^' marker.");
    expect(i).toBeGreaterThan(0);
    // "R1#show ip int" is 14 characters, so the caret sits under the "x".
    expect(out[i - 1]).toBe(' '.repeat(14) + '^');
  });

  it('reports ambiguous and incomplete commands', () => {
    const net = demo();
    expect(run(net, 'r1', ['en', 'co'])).toContain('% Ambiguous command:  "co"');
    expect(run(net, 'r1', ['en', 'show ip'])).toContain('% Incomplete command.');
  });

  it('treats a single unknown word as a hostname lookup unless domain lookup is off', () => {
    const net = demo();
    expect(run(net, 'r1', ['shw'])).toContain('Translating "shw"...domain server (255.255.255.255)');
    const out = run(net, 'r1', ['en', 'conf t', 'no ip domain-lookup', 'end', 'shw']);
    expect(out).not.toContain('Translating');
    expect(out).toContain('% Unknown command or computer name');
  });

  it('privileged commands are not available in user mode', () => {
    const net = demo();
    expect(run(net, 'r1', ['show running-config'])).toContain("% Invalid input detected at '^' marker.");
    expect(run(net, 'r1', ['configure terminal'])).toContain("% Invalid input detected at '^' marker.");
  });

  it('shows prompts for every mode', () => {
    const net = demo();
    const s = new CliSession(net, 'sw1');
    const prompts: string[] = [];
    for (const cmd of ['enable', 'conf t', 'int fa0/3', 'exit', 'vlan 50', 'exit', 'int range fa0/5 - 8', 'end']) {
      s.input(cmd);
      prompts.push(s.promptText());
    }
    expect(prompts).toEqual(['SW1#', 'SW1(config)#', 'SW1(config-if)#', 'SW1(config)#', 'SW1(config-vlan)#', 'SW1(config)#', 'SW1(config-if-range)#', 'SW1#']);
  });

  it('falls back to global config commands from interface mode', () => {
    const net = demo();
    const s = new CliSession(net, 'r1');
    run(net, 'r1', ['en', 'conf t', 'int g0/2', 'hostname EDGE'], s);
    expect(s.promptText()).toBe('EDGE(config)#');
  });

  it('runs exec commands from config mode with do', () => {
    const net = demo();
    const out = run(net, 'r1', ['en', 'conf t', 'do show ip route']);
    expect(out).toContain('Gateway of last resort is not set');
    expect(out).toContain('S        10.20.0.0/16 [1/0] via 10.0.12.2');
  });

  it('validates IP addresses like IOS', () => {
    const net = demo();
    expect(run(net, 'r1', ['en', 'conf t', 'int g0/2', 'ip address 10.0.12.5 255.255.255.0'])).toContain(
      '% 10.0.12.0 overlaps with GigabitEthernet0/1',
    );
    expect(run(net, 'r1', ['en', 'conf t', 'int g0/2', 'ip address 192.168.5.0 255.255.255.0'])).toContain(
      'Bad mask /24 for address 192.168.5.0',
    );
    expect(run(net, 'sw1', ['en', 'conf t', 'int fa0/5', 'ip address 1.1.1.1 255.0.0.0'])).toContain(
      '% IP addresses may not be configured on L2 links.',
    );
  });

  it('requires encapsulation before an IP on a subinterface', () => {
    const net = demo();
    const out = run(net, 'r1', ['en', 'conf t', 'int g0/2.30', 'ip address 10.30.0.1 255.255.255.0']);
    expect(out).toContain('% Configuring IP routing on a LAN subinterface is only allowed');
  });

  it('creates a missing access VLAN like a real switch', () => {
    const net = demo();
    expect(run(net, 'sw1', ['en', 'conf t', 'int fa0/9', 'switchport access vlan 99'])).toContain(
      '% Access VLAN does not exist. Creating vlan 99',
    );
    expect(net.device('sw1').vlans[99]).toBeDefined();
  });

  it('rejects trunk mode on an L3 switch until encapsulation is set', () => {
    const net = demo();
    net.addDevice(createDevice('core', 'NS-S3600', 'CORE'));
    const out = run(net, 'core', ['en', 'conf t', 'int g0/1', 'switchport mode trunk']);
    expect(out).toContain('Command rejected: An interface whose trunk encapsulation is "Auto" can not be configured to "trunk" mode.');
    const ok = run(net, 'core', ['en', 'conf t', 'int g0/1', 'switchport trunk encapsulation dot1q', 'switchport mode trunk']);
    expect(ok).not.toContain('rejected');
  });

  it('context help lists options and partial matches', () => {
    const net = demo();
    const s = new CliSession(net, 'r1');
    s.input('enable');
    expect(s.help('sh')).toEqual(['show']);
    const lines = s.help('show ip ');
    expect(lines.some((l) => l.trim().startsWith('route'))).toBe(true);
    expect(lines.some((l) => l.trim().startsWith('interface'))).toBe(true);
  });

  it('tab completes unique prefixes', () => {
    const net = demo();
    const s = new CliSession(net, 'r1');
    s.input('enable');
    expect(s.complete('conf')).toBe('configure ');
    expect(s.complete('co')).toBe('co');
  });

  it('show running-config reflects changes and enable secret is hashed', () => {
    const net = demo();
    run(net, 'r1', ['en', 'conf t', 'enable secret Cisco123', 'int g0/2', 'description Spare', 'end']);
    const out = run(net, 'r1', ['en', 'Cisco123', 'show run']);
    expect(out).toMatch(/enable secret 5 \$1\$/);
    expect(out).not.toContain('Cisco123');
    expect(out).toContain('interface GigabitEthernet0/2\n description Spare');
  });

  it('enable secret prompts for a password', () => {
    const net = demo();
    run(net, 'r1', ['en', 'conf t', 'enable secret letmein', 'end', 'disable']);
    const s = new CliSession(net, 'r1');
    s.input('enable');
    expect(s.promptText()).toBe('Password: ');
    expect(s.secretInput).toBe(true);
    s.input('wrong');
    s.input('letmein');
    expect(s.promptText()).toBe('R1#');
  });

  it('show vlan brief lists access ports but not trunks', () => {
    const net = demo();
    const out = run(net, 'sw1', ['show vlan brief']);
    expect(out).toMatch(/10\s+SALES\s+active\s+Fa0\/1/);
    expect(out).not.toMatch(/Gi0\/1/);
  });

  it('show interfaces trunk shows the uplink', () => {
    const net = demo();
    const out = run(net, 'sw1', ['en', 'show interfaces trunk']);
    expect(out).toMatch(/Gi0\/1\s+on\s+802\.1q\s+trunking\s+1/);
  });

  it('show cdp neighbors finds directly connected NetSmart devices', () => {
    const net = demo();
    const out = run(net, 'r1', ['show cdp neighbors']);
    expect(out).toMatch(/SW1\s+Gig 0\/0/);
    expect(out).toMatch(/R2\s+Gig 0\/1/);
  });

  it('ping from the router prints IOS output', () => {
    const net = demo();
    const out = run(net, 'r1', ['ping 10.0.12.2', 'ping 10.0.12.2']);
    expect(out).toContain('Sending 5, 100-byte ICMP Echos to 10.0.12.2, timeout is 2 seconds:');
    expect(out).toContain('.!!!!');
    expect(out).toContain('Success rate is 100 percent (5/5)');
  });

  it('interface range applies to every port', () => {
    const net = demo();
    run(net, 'sw1', ['en', 'conf t', 'int range fa0/10 - 12', 'switchport access vlan 20', 'shutdown', 'end']);
    for (const n of [10, 11, 12]) {
      const ifc = net.device('sw1').running.interfaces[`FastEthernet0/${n}`];
      expect(ifc.switchport!.accessVlan).toBe(20);
      expect(ifc.shutdown).toBe(true);
    }
  });
});
