/**
 * Which address should join links / QR codes use so phones on the same Wi-Fi can reach us?
 *
 * Taking "the first non-internal IPv4" goes wrong on machines with virtual adapters
 * (Hyper-V/WSL "vEthernet", Docker, VirtualBox, VPNs): those come first on Windows and
 * phones cannot reach them. Instead ask the OS which local address it would use to reach
 * the outside world (a UDP "connect" sends no packets), and fall back to scoring adapters.
 */
import { createSocket } from 'node:dgram';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

const VIRTUAL = /vethernet|wsl|hyper-?v|virtualbox|vmware|vbox|docker|br-|veth|loopback|bluetooth|tailscale|zerotier|utun|tun\d|tap\d|hamachi|npcap/i;

export interface Candidate {
  name: string;
  address: string;
  score: number;
}

/** Every IPv4 address a phone might use, best first. Link-local (169.254.x) and internal ones are left out. */
export function rankAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): Candidate[] {
  const out: Candidate[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal || iface.address.startsWith('169.254.')) continue;
      const a = iface.address;
      let score = a.startsWith('192.168.') ? 30 : a.startsWith('10.') ? 20 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 10 : 5;
      if (/wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d/i.test(name)) score += 5;
      if (VIRTUAL.test(name)) score -= 100;
      out.push({ name, address: a, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** The local address the OS routes outside traffic through, or null (offline, no default route). */
export function defaultRouteAddress(timeoutMs = 500): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.once('error', () => done(null));
    // Connecting a UDP socket only picks a route; nothing is sent.
    socket.connect(53, '8.8.8.8', () => {
      try {
        const { address } = socket.address();
        done(address && address !== '0.0.0.0' ? address : null);
      } catch {
        done(null);
      }
    });
  });
}

/** Best guess for the LAN address phones can reach. */
export async function lanAddress(): Promise<string> {
  const ranked = rankAddresses();
  const routed = await defaultRouteAddress();
  // Trust the route unless it goes through an adapter that is clearly virtual (e.g. a VPN).
  if (routed && !ranked.some((c) => c.address === routed && c.score < 0)) return routed;
  return ranked[0]?.address ?? 'localhost';
}
