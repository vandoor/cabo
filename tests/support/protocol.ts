// Test-only adapter for rule fixtures. Production supports only the scoped v2 protocol.
import { randomBytes, randomUUID } from "node:crypto";
import type { Socket } from "socket.io-client";
export function protocolHarness() {
  let roomId: string | undefined;
  const identities = new Map<string, any>();
  return {
    get roomId() {
      return roomId;
    },
    attach(socket: Socket) {
      let id: any = {
        browserId: randomUUID(),
        secret: randomBytes(32).toString("hex"),
      };
      let scope: any;
      const raw = socket.emitWithAck.bind(socket);
      socket.emitWithAck = (async (event: string, input: any = {}) => {
        if (!id.serverId) {
          if (input.token && identities.has(input.token))
            id = identities.get(input.token);
          const a = await raw("session", {
            browserId: id.browserId,
            secret: id.secret,
            requestId: randomUUID(),
          });
          id = { ...id, serverId: a.serverId, ...a.session };
        }
        let actual = event;
        let data: any = input ?? {};
        if (["join", "watch", "unwatch"].includes(event)) {
          if (event === "join" && input.token) {
            const saved = identities.get(input.token);
            if (saved) {
              id = saved;
              const q = await raw("session", {
                browserId: id.browserId,
                secret: id.secret,
                requestId: randomUUID(),
              });
              id = {
                ...id,
                roomId: undefined,
                token: undefined,
                ...q.session,
                serverId: q.serverId,
              };
            }
            actual = "restore";
            data = {
              ...input,
              roomId: id.roomId ?? roomId,
              token: id.token ?? input.token,
              takeover: true,
            };
          } else if (event === "join") {
            actual = roomId ? "join" : "create";
            data = { ...input, roomId };
          } else if (event === "watch") data = { ...input, roomId };
          else actual = "browse";
          data = {
            browserId: id.browserId,
            secret: id.secret,
            serverId: id.serverId,
            generation: id.generation,
            requestId: randomUUID(),
            ...data,
          };
        } else
          data =
            input === null
              ? null
              : { ...scope, requestId: randomUUID(), ...data };
        const a = await raw(actual, data);
        if (a.ok) {
          if (a.session) {
            id = { ...id, roomId: undefined, token: undefined, ...a.session };
            if (id.token) identities.set(id.token, id);
          }
          if (a.view) {
            scope = {
              serverId: a.view.serverId,
              roomId: a.view.roomId,
              generation: a.view.generation,
            };
            roomId ??= a.view.roomId;
          } else if (a.session)
            scope = { serverId: a.serverId, generation: a.session.generation };
        }
        return { ...a, token: a.session?.token };
      }) as typeof socket.emitWithAck;
      return socket;
    },
    resetRoom() {
      roomId = undefined;
    },
  };
}
