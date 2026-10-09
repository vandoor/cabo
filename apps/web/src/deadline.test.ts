import { describe, expect, it } from "vitest";
import { remainingSeconds, nextSecondDelay } from "./deadline";
describe("server deadlines", () => {
  it("rounds display seconds and schedules only display boundaries", () => {
    expect(remainingSeconds(4501, 1000)).toBe(4);
    expect(nextSecondDelay(4501, 1000)).toBe(501);
    expect(nextSecondDelay(4000, 1000)).toBe(1000);
    expect(remainingSeconds(undefined, 1000)).toBe(0);
    expect(remainingSeconds(1000, 1100)).toBe(0);
  });
});
