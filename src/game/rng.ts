export function mulberry32(seed: number): number {
  let a = seed >>> 0;
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function nextRng(state: number): { value: number; state: number } {
  const value = mulberry32(state);
  return { value, state: (state + 1) >>> 0 };
}

export function randInt(state: number, min: number, max: number): { value: number; state: number } {
  const r = nextRng(state);
  const value = min + Math.floor(r.value * (max - min + 1));
  return { value, state: r.state };
}

export function pick<T>(state: number, list: readonly T[]): { value: T; state: number } {
  const r = randInt(state, 0, list.length - 1);
  return { value: list[r.value]!, state: r.state };
}
