import { useEffect, useState } from 'react';
import { api } from './api';

let internet: Promise<boolean> | null = null;

/**
 * Is the party on the internet (Docker + tunnel, public and admin servers)? Asked once per page
 * load; null until known. Only then does "share the big screen online" matter.
 */
export function useInternetMode(): boolean | null {
  const [value, setValue] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    internet ??= api.internetMode().catch(() => false);
    void internet.then((v) => live && setValue(v));
    return () => {
      live = false;
    };
  }, []);
  return value;
}

/** The big screen's address for guests, next to the join link (same server and port). */
export function displayUrlOf(joinUrl: string, code: string): string {
  return joinUrl.replace(/\/join\/[^/]*$/, `/display/${code}`);
}
