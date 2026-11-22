// What you can do in person at someone's desk: look behind the PC, reseat or replace the cable,
// and work in Windows (adapter status, Device Manager, drivers).

import { parseIp } from '../sim/ip';
import type { Network } from '../sim/network';
import { canReach } from '../sim/routing';
import { CURRENT_NIC_DRIVER, type Device } from '../sim/types';

const NIC = 'FastEthernet0';
export const ADAPTER_NAME = 'NetSmart NS-1000 Gigabit Ethernet';
export const USB_DRIVER = `NetSmart LAN driver ${CURRENT_NIC_DRIVER} (IT toolkit USB)`;

export type NetStatus = 'connected' | 'no-internet' | 'unplugged' | 'disconnected' | 'no-adapter' | 'asleep';

export function deskStatus(net: Network, pc: Device): NetStatus {
  if (!pc.powered) return 'asleep';
  const nic = pc.nic;
  if (nic && (nic.driver === 'missing' || nic.disabled)) return 'no-adapter';
  const link = net.linkAt(pc.id, NIC);
  if (!link || link.cable === 'unplugged') return 'unplugged';
  if (!net.isUp(pc.id, NIC)) return 'disconnected';
  return canReach(net, pc.id, parseIp('8.8.8.8')!) ? 'connected' : 'no-internet';
}

export interface BackOfPc {
  /** Is a cable seated in the NIC? */
  cableInNic: boolean;
  /** Link light (green) on the NIC. */
  linkLight: boolean;
  /** What you notice about the cable. */
  cableNote: string;
  /** Label on the wall jack, which tells you the switch port it's patched to. */
  jackLabel: string;
}

export function lookBehind(net: Network, pc: Device): BackOfPc {
  const link = net.linkAt(pc.id, NIC);
  const peer = net.peerOf(pc.id, NIC);
  const jackLabel = peer ? `${net.device(peer.device).running.hostname} ${peer.iface.replace('FastEthernet', 'Fa')}` : 'unlabeled';
  if (!link) return { cableInNic: false, linkLight: false, cableNote: 'No cable at all.', jackLabel };
  const linkLight = net.isUp(pc.id, NIC);
  if (link.cable === 'unplugged') {
    return { cableInNic: false, linkLight: false, cableNote: 'The patch cable is lying on the floor. It came out of the PC.', jackLabel };
  }
  if (link.cable === 'cut') {
    return {
      cableInNic: true,
      linkLight: false,
      cableNote: 'Plugged in at both ends, but the cable is crushed flat where the chair rolls over it.',
      jackLabel,
    };
  }
  return { cableInNic: true, linkLight, cableNote: 'Cable is seated at both ends and looks fine.', jackLabel };
}

/** Unplug and replug. Fixes a cable that had worked loose; can't fix a damaged one. */
export function reseatCable(net: Network, pc: Device): string {
  const link = net.linkAt(pc.id, NIC);
  if (!link) return 'There is no cable to reseat.';
  if (link.cable === 'unplugged') {
    link.cable = 'ok';
    net.commit();
    return 'You plugged the cable back into the PC. Click.';
  }
  net.commit();
  if (link.cable === 'cut') return 'Reseated both ends. The link light stays off.';
  return 'Reseated the cable. Nothing changed.';
}

/** Swap in a new patch cable from the closet. */
export function replaceCable(net: Network, pc: Device): string {
  const link = net.linkAt(pc.id, NIC);
  if (!link) return 'There is no cable run here.';
  const was = link.cable;
  link.cable = 'ok';
  net.commit();
  return was === 'cut' ? 'Swapped in a fresh patch cable. The link light comes on.' : 'Swapped in a fresh patch cable.';
}

export function setAdapterEnabled(net: Network, pc: Device, enabled: boolean): string {
  if (!pc.nic || pc.nic.driver === 'missing') return 'There is no network adapter to enable.';
  pc.nic.disabled = !enabled;
  net.commit();
  return enabled ? 'Adapter enabled.' : 'Adapter disabled.';
}

/** "Search automatically" needs the internet, which a PC with a broken adapter doesn't have. */
export function updateDriver(net: Network, pc: Device, source: 'auto' | 'usb'): string {
  const nic = pc.nic;
  if (!nic) return 'Nothing to update.';
  if (source === 'auto') {
    if (!canReach(net, pc.id, parseIp('8.8.8.8')!)) {
      return "Windows couldn't search online for drivers. Check your internet connection and try again.";
    }
    if (nic.driver === 'ok') return 'The best drivers for your device are already installed.';
  }
  if (nic.driver === 'ok') return 'The best drivers for your device are already installed.';
  nic.driver = 'ok';
  nic.version = CURRENT_NIC_DRIVER;
  net.commit();
  return `Windows has successfully updated your drivers: ${ADAPTER_NAME}, version ${CURRENT_NIC_DRIVER}.`;
}

export function wake(net: Network, pc: Device): void {
  pc.powered = true;
  net.commit();
}
