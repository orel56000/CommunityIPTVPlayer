import { useCallback, useEffect, useState } from "react";
import {
  connectBackend,
  disconnectBackend,
  fetchServerInfo,
  getBackendSnapshot,
  selectThisAppBackend,
  subscribeRelayStatus,
  type BackendServerInfo,
  type BackendSnapshot,
} from "../utils/relayDiscovery";

export interface BackendConnectionState extends BackendSnapshot {
  serverInfo: BackendServerInfo | null;
}

const readConnectionState = (): BackendConnectionState => ({
  ...getBackendSnapshot(),
  serverInfo: null,
});

export const useBackendConnection = () => {
  const [state, setState] = useState<BackendConnectionState>(readConnectionState);

  const refresh = useCallback(() => {
    const snapshot = getBackendSnapshot();
    setState((prev) => ({ ...snapshot, serverInfo: prev.serverInfo }));

    if (snapshot.status !== "available") {
      setState((prev) => ({ ...prev, serverInfo: null }));
      return;
    }

    void fetchServerInfo(snapshot.relayBase).then((serverInfo) => {
      setState((current) => {
        const latest = getBackendSnapshot();
        if (latest.relayBase !== snapshot.relayBase || latest.status !== "available") return current;
        return { ...latest, serverInfo };
      });
    });
  }, []);

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeRelayStatus(refresh);
    window.addEventListener("ctv:backend-change", refresh);
    return () => {
      unsubscribe();
      window.removeEventListener("ctv:backend-change", refresh);
    };
  }, [refresh]);

  const connect = useCallback(
    async (origin: string) => {
      const connectedOrigin = await connectBackend(origin);
      refresh();
      return connectedOrigin;
    },
    [refresh],
  );

  const useSelf = useCallback(() => {
    selectThisAppBackend();
    refresh();
  }, [refresh]);

  const disconnect = useCallback(() => {
    disconnectBackend();
    refresh();
  }, [refresh]);

  return {
    ...state,
    connected: state.status === "available",
    connect,
    useSelf,
    disconnect,
    refresh,
  };
};
