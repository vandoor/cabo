import { useEffect, useState } from "react";
import { remainingSeconds, nextSecondDelay } from "./deadline";

// Parent tables update once at expiry; only the tiny countdown updates each second.
export function useDeadline(deadline: number | undefined, offset: number) {
  const [, refresh] = useState(0);
  useEffect(() => {
    if (deadline === undefined) return;
    const delay = deadline - Date.now() - offset;
    if (delay <= 0) return;
    const timer = setTimeout(() => refresh((n) => n + 1), delay + 1);
    return () => clearTimeout(timer);
  }, [deadline, offset]);
  return deadline !== undefined && deadline > Date.now() + offset;
}
export function Countdown({
  deadline,
  offset,
  clock = false,
}: {
  deadline?: number;
  offset: number;
  clock?: boolean;
}) {
  const [, refresh] = useState(0);
  const now = Date.now() + offset;
  const seconds = remainingSeconds(deadline, now);
  useEffect(() => {
    if (deadline === undefined || seconds === 0) return;
    const timer = setTimeout(
      () => refresh((n) => n + 1),
      nextSecondDelay(deadline, Date.now() + offset) + 1,
    );
    return () => clearTimeout(timer);
  });
  return clock ? (
    <div className={`clock ${seconds <= 10 ? "urgent" : ""}`}>
      <img className="icon" src="/icons/timer.svg" alt="" />
      <b>{seconds}</b>
      <span>秒</span>
    </div>
  ) : (
    <span className="countdown">{seconds}</span>
  );
}
