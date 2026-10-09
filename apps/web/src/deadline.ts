export const remainingSeconds = (deadline: number | undefined, now: number) =>
  Math.max(0, Math.ceil(((deadline ?? now) - now) / 1000));
export const nextSecondDelay = (deadline: number, now: number) =>
  Math.max(1, (deadline - now) % 1000 || 1000);
