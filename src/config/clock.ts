export const CLOCK = Symbol('CLOCK');

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock & { set(iso: string): void } {
  let current = new Date(iso);
  return {
    now: () => new Date(current.getTime()),
    set: (next: string) => {
      current = new Date(next);
    },
  };
}
