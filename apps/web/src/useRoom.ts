import { useEffect, useState, useSyncExternalStore } from "react";
import { browserClient } from "./roomClient";
export function useRoom() {
  const [{ client, route }] = useState(browserClient);
  const state = useSyncExternalStore(client.subscribe, client.snapshot);
  useEffect(() => {
    client.start();
    const pop = () => client.pop(route());
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("popstate", pop);
      client.stop();
    };
  }, [client, route]);
  return {
    ...state,
    send: client.send.bind(client),
    create: client.create,
    join: client.join,
    watch: client.watch,
    unwatch: client.browse,
    browse: client.browse,
    resume: client.resume,
    close: client.close,
    reconnect: () => client.reconnect(),
    takeover: () => client.reconnect(true),
  };
}
