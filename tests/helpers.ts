import { buildDemoNetwork } from '../src/content/demoNetwork';
import { CliSession } from '../src/sim/cli/session';
import { parseIp } from '../src/sim/ip';
import type { Network } from '../src/sim/network';
import { ping } from '../src/sim/routing';

export function demo(): Network {
  return buildDemoNetwork('test');
}

/** Runs commands on a device console and returns all output (including delayed output). */
export function run(net: Network, deviceId: string, commands: string[], session = new CliSession(net, deviceId)): string {
  const out: string[] = [];
  for (const cmd of commands) {
    const prompt = session.promptText();
    const echo = session.secretInput ? '' : cmd; // passwords are not echoed
    const r = session.input(cmd);
    out.push(prompt + echo, ...r.output, ...(r.delayed?.output ?? []));
  }
  return out.join('\n');
}

export function canPing(net: Network, from: string, to: string): boolean {
  // Ping twice so the first ARP miss doesn't matter.
  ping(net, from, parseIp(to)!);
  return ping(net, from, parseIp(to)!).successes === 5;
}
