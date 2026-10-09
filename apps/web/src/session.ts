export interface SavedIdentity {
  browserId: string;
  secret: string;
  serverId?: string;
  generation?: number;
  roomId?: string;
  playerId?: string;
  token?: string;
  pending?: { event: string; data: Record<string, unknown> };
}
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const identityKey = "cabo-identity-v2";
export function secret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export class IdentityStore {
  value?: SavedIdentity;
  legacy = false;
  constructor(private storage: StorageLike) {
    try {
      this.legacy = !!storage.getItem("cabo-session");
      const raw = storage.getItem(identityKey);
      if (raw) {
        const v = JSON.parse(raw);
        if (typeof v.browserId === "string" && /^[a-f0-9]{64}$/.test(v.secret))
          this.value = v;
      }
    } catch {
      /* Reading disabled storage must not prevent public spectating. */
    }
  }
  save(value: SavedIdentity) {
    try {
      const raw = JSON.stringify(value);
      this.storage.setItem(identityKey, raw);
      if (this.storage.getItem(identityKey) !== raw)
        throw Error("not persisted");
    } catch {
      throw Error(
        "浏览器存储不可用，无法安全保留席位。请允许本站存储后再入座；仍可观战。",
      );
    }
    this.value = value;
  }
  ensure() {
    const value = this.value ?? { browserId: secret(), secret: secret() };
    this.save(value);
    return value;
  }
}
export const retryDelay = (attempt: number) =>
  Math.min(8000, 1000 * 2 ** attempt);
export function acceptsScope(
  current: {
    roomId: string;
    serverId: string;
    generation: number;
    version: number;
  },
  next: typeof current,
) {
  return (
    next.roomId === current.roomId &&
    next.serverId === current.serverId &&
    next.generation === current.generation &&
    next.version >= current.version
  );
}
