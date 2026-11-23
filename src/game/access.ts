// Who can actually log in and change the network. NOC staff (Jordan) have their own access. Everyone else who has
// ever "fixed something" here (the contractor, the MSP, Tom from the front office) gets in with the shared admin
// passwords the predecessor handed around. Change those passwords, or lock the vty lines to the NOC, and they can't
// make changes anymore, so their changes stop breaking things.

import { evaluate } from '../sim/acl';
import { parseIp } from '../sim/ip';
import type { Network } from '../sim/network';

/** Passwords that got around: nocadmin's original secret, and the router's clear-text break-glass account. */
export const LEAKED_PASSWORDS = ['Ledger!Mike2019', 'Cedar2019!'];

export const OUTSIDERS: Record<string, { ip: string; who: string }> = {
  dlindqvist: { ip: '10.10.99.21', who: 'the contractor (dlindqvist)' },
  'msp-secops': { ip: '10.10.99.27', who: "the MSP's security team" },
  tbrennan: { ip: '10.10.99.30', who: 'Tom Brennan, the office manager, who knows the shared admin password' },
};

/** NOC staff with their own accounts: they can always make changes. */
export const NOC_STAFF = ['jreyes'];

/** Can an outsider log in to this device with what they know and from where they are? */
export function outsiderCanChange(net: Network, user: string, deviceId: string): boolean {
  const o = OUTSIDERS[user];
  const d = net.devices.get(deviceId);
  if (!o || !d || !d.managed) return false;
  const cfg = d.running;
  const vty = cfg.lines.vty;
  if (!vty.transport.ssh && !vty.transport.telnet) return false;
  let credentials: boolean;
  if (vty.login === 'none') credentials = true;
  else if (vty.login === 'line') credentials = !!vty.password && LEAKED_PASSWORDS.includes(vty.password);
  else credentials = Object.values(cfg.users).some((u) => u.privilege >= 15 && ((u.secret !== null && LEAKED_PASSWORDS.includes(u.secret)) || (u.password !== null && LEAKED_PASSWORDS.includes(u.password))));
  if (!credentials) return false;
  // `access-class` on the vty lines can keep them out even with a password.
  const aclName = vty.accessClass;
  const acl = aclName ? cfg.acls?.[aclName] : undefined;
  if (acl && acl.entries.some((e) => e.remark === undefined)) {
    if (!evaluate(acl, { proto: 'tcp', src: parseIp(o.ip)!, dst: 0, srcPort: 51034, dstPort: 22 }).permit) return false;
  }
  return true;
}

/** Can this person make a change on this device right now? */
export function canMakeChange(net: Network, user: string, deviceId: string): boolean {
  return NOC_STAFF.includes(user) || outsiderCanChange(net, user, deviceId);
}
