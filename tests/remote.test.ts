import { describe, expect, it } from 'vitest';
import { HOST_OPTIONS } from '../src/content/demoNetwork';
import { CliSession } from '../src/sim/cli/session';
import { createDevice } from '../src/sim/devices';
import type { ConsoleSession } from '../src/sim/host';
import { HostShell } from '../src/sim/host';
import type { Network } from '../src/sim/network';
import { canPing, demo, run } from './helpers';

function nocPc(net: Network): HostShell {
  return new HostShell(net, 'noc', HOST_OPTIONS.noc);
}

/** Types commands into any console (PC or IOS) and returns the transcript. */
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

/** Adds a brand-new, factory-default router R3 hanging off R1 Gi0/2 (10.0.13.0/30). */
function addFactoryRouter(net: Network): void {
  net.addDevice(createDevice('r3', 'NS-R4300'));
  net.connect('r1', 'GigabitEthernet0/2', 'r3', 'GigabitEthernet0/0');
  run(net, 'r1', ['en', 'conf t', 'int g0/2', 'ip address 10.0.13.1 255.255.255.252', 'no shut', 'end']);
  run(net, 'r3', ['en', 'conf t', 'int g0/0', 'ip address 10.0.13.2 255.255.255.252', 'no shut', 'exit', 'ip route 0.0.0.0 0.0.0.0 10.0.13.1', 'end']);
}

describe('SSH from the NOC PC', () => {
  it('logs into an inherited device with the trusted key and fixes the tutorial fault remotely', () => {
    const net = demo();
    const pc = nocPc(net);
    const first = type(pc, ['ssh nocadmin@10.10.10.2 -p 22']);
    expect(first).toContain("The authenticity of host '10.10.10.2 (10.10.10.2)' can't be established.");
    expect(pc.promptText()).toBe('Are you sure you want to continue connecting (yes/no/[fingerprint])? ');
    const session = type(pc, ['yes', 'conf t', 'int fa0/1', 'no shut', 'end', 'exit']);
    expect(session).toContain("Warning: Permanently added '10.10.10.2' (RSA) to the list of known hosts.");
    expect(session).toContain('SW1#conf t');
    expect(session).toContain('Connection to 10.10.10.2 closed.');
    expect(pc.promptText()).toBe('C:\\Users\\nocadmin>');
    expect(canPing(net, 'pc1', '10.20.1.10')).toBe(true);
    expect(net.logs.some((l) => l.message === '%SYS-5-CONFIG_I: Configured from console by nocadmin on vty0')).toBe(true);
  });

  it('remembers the host key and defaults the username to the Windows user', () => {
    const net = demo();
    const pc = nocPc(net);
    type(pc, ['ssh 10.0.12.2', 'yes', 'exit']);
    const second = type(pc, ['ssh 10.0.12.2']);
    expect(second).not.toContain('authenticity');
    expect(pc.promptText()).toBe('R2#');
  });

  it('accepts -l and -p in any position', () => {
    const net = demo();
    const pc = nocPc(net);
    type(pc, ['ssh -p 22 -l nocadmin 10.20.1.2', 'yes']);
    expect(pc.promptText()).toBe('SW2#');
  });

  it('asks for a password when there is no trusted key, and locks out after 3 tries', () => {
    const net = demo();
    const pc = nocPc(net);
    type(pc, ['ssh bob@10.10.10.1', 'yes']);
    expect(pc.promptText()).toBe("bob@10.10.10.1's password: ");
    expect(pc.secretInput).toBe(true);
    const out = type(pc, ['a', 'b', 'c']);
    expect(out).toContain('Permission denied, please try again.');
    expect(out).toContain('bob@10.10.10.1: Permission denied (password).');
    expect(pc.promptText()).toBe('C:\\Users\\nocadmin>');
  });

  it('a regular PC without the key must use the password', () => {
    const net = demo();
    run(net, 'sw1', ['en', 'conf t', 'int fa0/1', 'no shut', 'end']);
    const pc = new HostShell(net, 'pc1', { user: 'nocadmin' });
    type(pc, ['ssh nocadmin@10.10.10.2', 'yes']);
    expect(pc.promptText()).toBe("nocadmin@10.10.10.2's password: ");
    type(pc, ['Pr3decess0r!Left']);
    expect(pc.promptText()).toBe('SW1#');
  });

  it('times out when the device is unreachable and refuses telnet when only SSH is allowed', () => {
    const net = demo();
    const pc = nocPc(net);
    expect(type(pc, ['ssh nocadmin@10.99.99.99'])).toContain('ssh: connect to host 10.99.99.99 port 22: Connection timed out');
    expect(type(pc, ['telnet 10.10.10.1'])).toContain('Could not open connection to the host, on port 23: Connect failed');
  });

  it('custom SSH port needs ip ssh port + matching rotary on the vty lines; port 22 keeps working', () => {
    const net = demo();
    const pc = nocPc(net);
    expect(type(pc, ['ssh nocadmin@10.10.10.1 -p 2222'])).toContain('port 2222: Connection refused');
    run(net, 'r1', ['en', 'conf t', 'ip ssh port 2222 rotary 1', 'end']);
    expect(type(pc, ['ssh nocadmin@10.10.10.1 -p 2222'])).toContain('Connection refused');
    run(net, 'r1', ['en', 'conf t', 'line vty 0 4', 'rotary 1', 'end']);
    type(pc, ['ssh nocadmin@10.10.10.1 -p 2222', 'yes']);
    expect(pc.promptText()).toBe('R1#');
    type(pc, ['exit', 'ssh nocadmin@10.10.10.1 -p 22', 'yes']);
    expect(pc.promptText()).toBe('R1#');
  });

  it('warns when the host key changes', () => {
    const net = demo();
    const pc = nocPc(net);
    type(pc, ['ssh nocadmin@10.10.10.1', 'yes', 'conf t', 'crypto key generate rsa modulus 2048', 'end', 'exit']);
    const out = type(pc, ['ssh nocadmin@10.10.10.1']);
    expect(out).toContain('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!');
    expect(out).toContain('Host key verification failed.');
  });

  it('drops the session when the device reloads', () => {
    const net = demo();
    const pc = nocPc(net);
    type(pc, ['ssh nocadmin@10.10.10.2', 'yes', 'reload', '']);
    expect(pc.pollLogs()).toContain('Connection to 10.10.10.2 closed by remote host.');
    expect(pc.promptText()).toBe('C:\\Users\\nocadmin>');
  });

  it('vty sessions only see log messages after terminal monitor', () => {
    const net = demo();
    const pc = nocPc(net);
    type(pc, ['ssh nocadmin@10.10.10.2', 'yes', 'conf t', 'int fa0/1', 'no shut', 'end']);
    expect(pc.pollLogs()).toEqual([]);
    type(pc, ['terminal monitor', 'conf t', 'int fa0/1', 'shut', 'end']);
    expect(pc.pollLogs().some((l) => l.includes('changed state to administratively down'))).toBe(true);
  });
});

describe('setting up SSH on factory-default hardware', () => {
  it('refuses until keys, a user and vty login are configured; then asks for the password', () => {
    const net = demo();
    addFactoryRouter(net);
    const pc = nocPc(net);
    expect(type(pc, ['ssh nocadmin@10.0.13.2'])).toContain('Connection refused');

    const setup = run(net, 'r3', [
      'en',
      'conf t',
      'crypto key generate rsa modulus 1024',
      'hostname R3',
      'crypto key generate rsa modulus 1024',
      'ip domain-name netsmart.local',
      'crypto key generate rsa',
      '1024',
      'username nocadmin privilege 15 secret S3cure!',
      'line vty 0 4',
      'login local',
      'transport input ssh',
      'end',
    ]);
    expect(setup).toContain('% Please define a hostname other than Router.');
    expect(setup).toContain('% Please define a domain-name first.');
    expect(setup).toContain('The name for the keys will be: R3.netsmart.local');
    expect(setup).toContain('% Generating 1024 bit RSA keys, keys will be non-exportable...');
    expect(net.logs.some((l) => l.device === 'r3' && l.message.startsWith('%SSH-5-ENABLED'))).toBe(true);

    type(pc, ['ssh nocadmin@10.0.13.2', 'yes']);
    expect(pc.promptText()).toBe("nocadmin@10.0.13.2's password: ");
    type(pc, ['S3cure!']);
    expect(pc.promptText()).toBe('R3#');
  });

  it('RSA keys are lost on reload unless the config was saved', () => {
    const net = demo();
    addFactoryRouter(net);
    run(net, 'r3', ['en', 'write mem']); // save IP settings only
    run(net, 'r3', [
      'en',
      'conf t',
      'hostname R3',
      'ip domain-name lab',
      'crypto key generate rsa modulus 1024',
      'username nocadmin privilege 15 secret x',
      'line vty 0 4',
      'login local',
      'end',
      'reload',
      'no',
      '',
    ]);
    net.advance(60_000);
    expect(type(nocPc(net), ['ssh nocadmin@10.0.13.2'])).toContain('Connection refused');
  });

  it('telnet with a vty line password, and enable over vty needs an enable secret', () => {
    const net = demo();
    addFactoryRouter(net);
    const pc = nocPc(net);
    const noPw = type(pc, ['telnet 10.0.13.2']);
    expect(noPw).toContain('Password required, but none set');
    run(net, 'r3', ['en', 'conf t', 'line vty 0 4', 'password cisco', 'login', 'end']);
    type(pc, ['telnet 10.0.13.2', 'cisco']);
    expect(pc.promptText()).toBe('Router>');
    expect(type(pc, ['enable'])).toContain('% No password set');
  });
});

describe('SSH from a router (IOS client)', () => {
  it('ssh -l from R1 to R2 uses the password and returns on exit', () => {
    const net = demo();
    const r1 = new CliSession(net, 'r1');
    expect(type(r1, ['ssh -l nocadmin 10.0.12.2'])).not.toContain('%');
    expect(r1.promptText()).toBe('Password: ');
    type(r1, ['Pr3decess0r!Left']);
    expect(r1.promptText()).toBe('R2#');
    const out = type(r1, ['exit']);
    expect(out).toContain('[Connection to 10.0.12.2 closed by foreign host]');
    expect(r1.promptText()).toBe('R1>');
  });

  it('show run lists the trusted key and ssh settings', () => {
    const net = demo();
    const out = run(net, 'r1', ['en', 'show run']);
    expect(out).toContain('username nocadmin privilege 15 secret 5 $1$');
    expect(out).toContain('ip domain-name netsmart.local');
    expect(out).toContain('ip ssh version 2');
    expect(out).toMatch(/ip ssh pubkey-chain\n {2}username nocadmin\n {3}key-hash ssh-rsa [0-9A-F]{32} nocadmin@NOC-PC/);
    expect(out).toContain('line vty 0 4\n login local\n transport input ssh');
    expect(run(net, 'r1', ['show ip ssh'])).toContain('SSH Enabled - version 2.0');
  });
});
