import { GameRoom } from "./gameRoom.js";

export { GameRoom };

function stubFor(env, roomId) {
  const id = env.GAME_ROOM.idFromName(roomId);
  return env.GAME_ROOM.get(id);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "game-service" });
    }

    // Game connection: /?room=X&color=Y&name=Z (color/name must be known
    // before the DO is selected, since a DO's WebSocket tags can only be set
    // at accept time — see gameRoom.js).
    if (request.headers.get("Upgrade") === "websocket") {
      const roomId = url.searchParams.get("room");
      if (!roomId) return new Response("missing room", { status: 400 });
      return stubFor(env, roomId).fetch(request);
    }

    // analysis-service POSTs its result here after computing it.
    const callbackMatch = url.pathname.match(/^\/internal\/analysis-callback\/(.+)$/);
    if (request.method === "POST" && callbackMatch) {
      if (request.headers.get("x-internal-secret") !== env.ANALYSIS_SHARED_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const roomId = decodeURIComponent(callbackMatch[1]);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = "/analysis-callback";
      forwardUrl.search = "";
      return stubFor(env, roomId).fetch(new Request(forwardUrl, request));
    }

    // GET /rooms/:id/moves — same path/shape as the old REST endpoint.
    const movesMatch = url.pathname.match(/^\/rooms\/([^/]+)\/moves$/);
    if (request.method === "GET" && movesMatch) {
      const roomId = decodeURIComponent(movesMatch[1]);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = "/moves";
      forwardUrl.search = "";
      return stubFor(env, roomId).fetch(new Request(forwardUrl, request));
    }

    return new Response("not found", { status: 404 });
  }
};
