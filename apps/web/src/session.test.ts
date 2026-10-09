import { describe, expect, it } from "vitest";
import { IdentityStore, retryDelay, acceptsScope } from "./session";
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
describe("durable browser session", () => {
  it("persists unguessable credentials and unfinished operation before sending", () => {
    const db = storage();
    const first = new IdentityStore(db);
    const identity = first.ensure();
    expect(identity.secret).toMatch(/^[a-f0-9]{64}$/);
    first.save({
      ...identity,
      pending: { event: "create", data: { requestId: "abc", name: "甲" } },
    });
    const refreshed = new IdentityStore(db);
    expect(refreshed.value).toEqual(first.value);
    expect(refreshed.value?.pending?.data.requestId).toBe("abc");
    expect(new IdentityStore(storage()).ensure().secret).not.toBe(
      identity.secret,
    );
  });
  it("refuses seating if persistence fails and does not silently invent an identity", () => {
    const store = new IdentityStore({
      getItem: () => null,
      setItem: () => {
        throw Error("blocked");
      },
      removeItem: () => {},
    });
    expect(() => store.ensure()).toThrow(/存储/);
    expect(store.value).toBeUndefined();
  });
  it("recognizes legacy identity without adopting it", () => {
    const db = storage();
    db.setItem("cabo-session", "old-token");
    const store = new IdentityStore(db);
    expect(store.legacy).toBe(true);
    expect(store.value).toBeUndefined();
  });
  it("rejects late room, server and generation states and only orders versions in one scope", () => {
    const scope = { roomId: "r", serverId: "s", generation: 2, version: 9 };
    expect(acceptsScope(scope, { ...scope, version: 10 })).toBe(true);
    for (const stale of [
      { roomId: "other" },
      { serverId: "old" },
      { generation: 1 },
      { version: 8 },
    ])
      expect(acceptsScope(scope, { ...scope, ...stale })).toBe(false);
  });
  it("caps retry backoff at eight seconds", () => {
    expect([0, 1, 2, 3, 4, 9].map(retryDelay)).toEqual([
      1000, 2000, 4000, 8000, 8000, 8000,
    ]);
  });
});
