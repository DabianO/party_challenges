import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { rankAddresses } from '../src/network.ts';

const v4 = (address: string, internal = false) => ({ family: 'IPv4', address, internal }) as NetworkInterfaceInfo;

describe('rankAddresses', () => {
  it('prefers the real Wi-Fi/Ethernet LAN address over virtual and link-local adapters', () => {
    const ranked = rankAddresses({
      'vEthernet (Default Switch)': [v4('172.30.64.1')],
      'Bluetooth Network Connection 3': [v4('169.254.207.73')],
      'Wi-Fi': [v4('192.168.2.15')],
      Loopback: [v4('127.0.0.1', true)],
      docker0: [v4('172.17.0.1')],
      Ethernet: [v4('10.0.0.12')],
    });
    expect(ranked.map((c) => c.address)).toEqual(['192.168.2.15', '10.0.0.12', '172.30.64.1', '172.17.0.1']);
    expect(ranked.filter((c) => c.score < 0).map((c) => c.name)).toEqual(['vEthernet (Default Switch)', 'docker0']);
  });
});
