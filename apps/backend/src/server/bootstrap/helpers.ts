import { WS_READY_STATE_OPEN, type WsSocket } from "../utils/network/ws.ts";

export function sendWsErrorEvent(
  socket: WsSocket,
  payload: {
    status?: number;
    error: {
      type: string;
      code: string;
      message: string;
      param?: string;
    };
  },
) {
  if (socket.readyState !== WS_READY_STATE_OPEN) return;
  socket.send(
    JSON.stringify({
      type: "error",
      ...payload,
    }),
  );
}

export function createSelectionCacheMarkers(deps: {
  openAIAccountsHashSelectionCache: { dirty: boolean };
  teamAccountsHashSelectionCache: { dirty: boolean };
}) {
  function markOpenAIAccountsHashSelectionDirty() {
    deps.openAIAccountsHashSelectionCache.dirty = true;
  }

  function markTeamAccountsHashSelectionDirty() {
    deps.teamAccountsHashSelectionCache.dirty = true;
  }

  return {
    markOpenAIAccountsHashSelectionDirty,
    markTeamAccountsHashSelectionDirty,
  };
}
