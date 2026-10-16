/** Deterministic clock + timer scheduler for tests. */
export function createFakeTime(start = 1_700_000_000_000) {
  let now = start;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    clock: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        now = next.at;
        next.fn();
      }
      now = target;
    },
    pending: () => timers.length,
  };
}
