import { Chess } from "chess.js";
import { createGame, applyMove as applyMoveCore, serialize } from "./gameLogic.js";
import { getRaw, setRaw } from "./store.js";

// Free-tier stand-in for the GameRoom Durable Object (removed — see git
// history and docs/CLOUDFLARE.md "Free-tier alternative"). A plain Worker
// has no way for one player's WebSocket handler to reach across to the other,
// so room state moves to Upstash (external, free, HTTP-only) and instant
// in-memory broadcast becomes each open connection polling for changes.
//
// ponytail: polling, not push — revisit if this ever needs sub-100ms relay
// or a game genre where ~POLL_MS latency actually matters. Fine for
// turn-based chess.
const POLL_MS = 400;

const gameKey = (roomId) => `game:${roomId}`;
const analysisKey = (roomId) => `analysis:${roomId}`;

async function loadGame(env, roomId) {
  const saved = await getRaw(env, gameKey(roomId));
  if (!saved) return createGame();
  return {
    chess: new Chess(saved.fen),
    moves: saved.moves,
    players: saved.players,
    result: saved.result,
    vsBot: saved.vsBot,
    botColor: saved.botColor,
    botDifficulty: saved.botDifficulty
  };
}

async function saveGame(env, roomId, game) {
  await setRaw(env, gameKey(roomId), {
    fen: game.chess.fen(),
    moves: game.moves,
    players: game.players,
    result: game.result,
    vsBot: game.vsBot,
    botColor: game.botColor,
    botDifficulty: game.botDifficulty
  });
}

// Fingerprint of everything a poller needs to notice — move count alone
// misses connect/disconnect and resignation, which don't touch moves[].
const fingerprint = (game) => JSON.stringify([game.moves.length, game.result, game.players]);

// Fire-and-forget HTTP call, same contract gameRoom.js used — a Durable
// Object couldn't hold a persistent Redis SUBSCRIBE across hibernation, and
// a plain Worker can't hold one across requests either, so this stays HTTP.
async function publishMove(env, message) {
  if (!env.ANALYSIS_ORIGIN) return;
  try {
    await fetch(`${env.ANALYSIS_ORIGIN}/internal/moves`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": env.ANALYSIS_SHARED_SECRET || ""
      },
      body: message
    });
  } catch (err) {
    console.error("analysis publish failed", err);
  }
}

// Replaces bot.js's in-process Stockfish call — see botServer.js for why.
async function triggerBotMove(env, roomId, game) {
  if (!game.vsBot || game.result || game.chess.isGameOver()) return;
  if (game.chess.turn() !== game.botColor[0]) return;
  if (!env.BOT_ORIGIN) return;
  try {
    const res = await fetch(`${env.BOT_ORIGIN}/move`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": env.BOT_SHARED_SECRET || ""
      },
      body: JSON.stringify({ fen: game.chess.fen(), difficulty: game.botDifficulty })
    });
    const botMove = await res.json();
    if (!botMove || game.result) return;
    applyMoveCore(game, roomId, botMove, { publish: (_channel, m) => publishMove(env, m) });
    await saveGame(env, roomId, game);
  } catch (err) {
    console.error("bot move failed", err);
  }
}

function handleSocket(server, env, { room, color, name }) {
  server.accept();
  let closed = false;
  let lastSeen = null;
  let lastAnalysis = null;

  const sendGameState = (game) => {
    lastSeen = fingerprint(game);
    server.send(JSON.stringify({ type: "game-state", ...serialize(game) }));
  };

  async function poll() {
    if (closed) return;
    const game = await loadGame(env, room);
    if (fingerprint(game) !== lastSeen) sendGameState(game);

    const analysis = await getRaw(env, analysisKey(room));
    const analysisFp = analysis ? JSON.stringify(analysis) : null;
    if (analysisFp && analysisFp !== lastAnalysis) {
      lastAnalysis = analysisFp;
      server.send(JSON.stringify({ type: "analysis-update", ...analysis }));
    }
  }

  const timer = setInterval(() => poll().catch((err) => console.error("poll failed", err)), POLL_MS);

  const stop = async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (color !== "white" && color !== "black") return;
    const game = await loadGame(env, room);
    if (game.players[color] && game.players[color].name === name) {
      game.players[color].connected = false;
      await saveGame(env, room, game);
    }
  };
  server.addEventListener("close", () => stop().catch((err) => console.error("close handler failed", err)));
  server.addEventListener("error", () => stop().catch((err) => console.error("close handler failed", err)));

  server.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return; // ignore malformed frames rather than tearing down the connection
    }

    const game = await loadGame(env, room);

    if (msg.type === "join-room") {
      const { vsBot, difficulty } = msg;
      if (vsBot && !game.vsBot) {
        game.vsBot = true;
        game.botColor = color === "white" ? "black" : "white";
        game.botDifficulty = difficulty || "medium";
      }
      if (color === "white" || color === "black") {
        game.players[color] = { connected: true, name };
      }
      await saveGame(env, room, game);
      sendGameState(game);
      await triggerBotMove(env, room, game);
      return;
    }

    if (msg.type === "move") {
      try {
        applyMoveCore(game, room, { from: msg.from, to: msg.to, promotion: msg.promotion }, {
          publish: (_channel, m) => publishMove(env, m)
        });
        await saveGame(env, room, game);
        sendGameState(game);
        await triggerBotMove(env, room, game);
      } catch (err) {
        server.send(JSON.stringify({ type: "move-rejected", reason: err.message, from: msg.from, to: msg.to }));
      }
      return;
    }

    if (msg.type === "resign") {
      // Identity comes from the connect-time query params, never the
      // message body — same spectator-can't-forge-a-resignation guarantee
      // gameRoom.js/index.js had.
      if (color !== "white" && color !== "black") return;
      if (!game || game.result) return;
      const winner = color === "white" ? "black" : "white";
      game.result = { reason: "resignation", winner, resignedBy: color };
      await saveGame(env, room, game);
      sendGameState(game);
      return;
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "game-service" });
    }

    // /?room=X&color=Y&name=Z — color/name must be known up front since
    // there's no per-message re-tagging mechanism outside a Durable Object.
    if (request.headers.get("Upgrade") === "websocket") {
      const room = url.searchParams.get("room");
      const color = url.searchParams.get("color") || "spectator";
      const name = url.searchParams.get("name") || "";
      if (!room) return new Response("missing room", { status: 400 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      handleSocket(server, env, { room, color, name });
      return new Response(null, { status: 101, webSocket: client });
    }

    // analysis-service pushes its result here after computing it. There's no
    // socket registry to broadcast into directly, so it lands in the store
    // and every open connection's poll loop picks it up on its next tick.
    const callbackMatch = url.pathname.match(/^\/internal\/analysis-callback\/(.+)$/);
    if (request.method === "POST" && callbackMatch) {
      if (request.headers.get("x-internal-secret") !== env.ANALYSIS_SHARED_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const roomId = decodeURIComponent(callbackMatch[1]);
      const payload = await request.json();
      await setRaw(env, analysisKey(roomId), payload);
      return new Response(null, { status: 204 });
    }

    // GET /rooms/:id/moves — same path/shape as the old REST endpoint.
    const movesMatch = url.pathname.match(/^\/rooms\/([^/]+)\/moves$/);
    if (request.method === "GET" && movesMatch) {
      const roomId = decodeURIComponent(movesMatch[1]);
      const game = await loadGame(env, roomId);
      return Response.json({ moves: game.moves, fen: game.chess.fen() });
    }

    return new Response("not found", { status: 404 });
  }
};
