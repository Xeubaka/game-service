import { Chess } from "chess.js";
import { createGame, applyMove as applyMoveCore, serialize } from "./gameLogic.js";

// Durable Object equivalent of index.js's Socket.IO wiring. One instance per
// roomId (env.GAME_ROOM.idFromName(roomId) in worker.js), so there's no
// `games` Map here — this object's own storage IS the room.
//
// Socket.IO's per-connection closure (currentRoomId/currentColor) doesn't
// survive hibernation (the object can be evicted from memory between
// messages while the WebSocket itself stays open), so identity is carried on
// WebSocket tags instead, set once at accept time from the connect URL's
// query params and re-read via state.getTags() on every message/close.
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.game = null;
  }

  async getGame() {
    if (this.game) return this.game;
    const saved = await this.state.storage.get("game");
    this.game = saved
      ? {
          chess: new Chess(saved.fen),
          moves: saved.moves,
          players: saved.players,
          result: saved.result,
          vsBot: saved.vsBot,
          botColor: saved.botColor,
          botDifficulty: saved.botDifficulty
        }
      : createGame();
    return this.game;
  }

  async persist() {
    const g = await this.getGame();
    await this.state.storage.put("game", {
      fen: g.chess.fen(),
      moves: g.moves,
      players: g.players,
      result: g.result,
      vsBot: g.vsBot,
      botColor: g.botColor,
      botDifficulty: g.botDifficulty
    });
  }

  broadcast(event, payload) {
    for (const ws of this.state.getWebSockets()) {
      ws.send(JSON.stringify({ type: event, ...payload }));
    }
  }

  // Tags are set once, at accept() time, from the connect URL — there's no
  // way to re-tag a WebSocket later, so room/color/name all have to be known
  // before the upgrade completes (see worker.js / frontend game.js).
  tagsOf(ws) {
    const out = { room: null, color: null, name: null };
    for (const tag of this.state.getTags(ws)) {
      if (tag.startsWith("room:")) out.room = tag.slice(5);
      else if (tag.startsWith("color:")) out.color = tag.slice(6);
      else if (tag.startsWith("name:")) out.name = decodeURIComponent(tag.slice(5));
    }
    return out;
  }

  async applyMove(roomId, moveArgs) {
    const game = await this.getGame();
    applyMoveCore(game, roomId, moveArgs, {
      emit: (_roomId, event, payload) => this.broadcast(event, payload),
      publish: (_channel, message) => this.publishMove(message)
    });
    await this.persist();
  }

  // Fire-and-forget HTTP call replacing the old Redis PUBLISH moves:{roomId}
  // — a Durable Object can't hold a persistent Redis connection across
  // hibernation, so this and the analysis-callback path below both move to
  // plain HTTP. `message` is already the exact {roomId, fen, moveCount} JSON
  // gameLogic.js built, so analysis-service's payload shape is unchanged.
  async publishMove(message) {
    if (!this.env.ANALYSIS_ORIGIN) return;
    try {
      await fetch(`${this.env.ANALYSIS_ORIGIN}/internal/moves`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": this.env.ANALYSIS_SHARED_SECRET || ""
        },
        body: message
      });
    } catch (err) {
      console.error("analysis publish failed", err);
    }
  }

  // Replaces bot.js's in-process Stockfish call — Stockfish can't run inside
  // a Workers isolate (native child_process + a 75MB wasm blob), so the bot
  // move is computed by the separately-hosted botServer.js over HTTP instead.
  async triggerBotMove(roomId) {
    const game = await this.getGame();
    if (!game.vsBot || game.result || game.chess.isGameOver()) return;
    if (game.chess.turn() !== game.botColor[0]) return;
    if (!this.env.BOT_ORIGIN) return;
    try {
      const res = await fetch(`${this.env.BOT_ORIGIN}/move`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": this.env.BOT_SHARED_SECRET || ""
        },
        body: JSON.stringify({ fen: game.chess.fen(), difficulty: game.botDifficulty })
      });
      const botMove = await res.json();
      if (!botMove || game.result) return;
      await this.applyMove(roomId, botMove);
    } catch (err) {
      console.error("bot move failed", err);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const room = url.searchParams.get("room");
      const color = url.searchParams.get("color") || "spectator";
      const name = url.searchParams.get("name") || "";
      if (!room) return new Response("missing room", { status: 400 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, [
        `room:${room}`,
        `color:${color}`,
        `name:${encodeURIComponent(name)}`
      ]);
      return new Response(null, { status: 101, webSocket: client });
    }

    // analysis-service pushes its result here after computing it (forwarded
    // by worker.js), replacing the old subscriber.pSubscribe("analysis:*").
    if (request.method === "POST" && url.pathname === "/analysis-callback") {
      const payload = await request.json();
      this.broadcast("analysis-update", payload);
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && url.pathname === "/moves") {
      const game = await this.getGame();
      return Response.json({ moves: game.moves, fen: game.chess.fen() });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws, messageStr) {
    let msg;
    try {
      msg = JSON.parse(messageStr);
    } catch {
      return; // ignore malformed frames rather than tearing down the connection
    }

    const { room, color, name } = this.tagsOf(ws);
    const game = await this.getGame();

    if (msg.type === "join-room") {
      const { vsBot, difficulty } = msg;
      if (vsBot && !game.vsBot) {
        game.vsBot = true;
        game.botColor = color === "white" ? "black" : "white";
        game.botDifficulty = difficulty || "medium";
      }
      if (color === "white" || color === "black") {
        const isReconnect = game.players[color] && game.players[color].name === name;
        game.players[color] = { connected: true, name };
        if (isReconnect) this.broadcast("player-reconnected", { color, name });
      }
      await this.persist();
      ws.send(JSON.stringify({ type: "game-state", ...serialize(game) }));
      await this.triggerBotMove(room);
      return;
    }

    if (msg.type === "move") {
      try {
        await this.applyMove(room, { from: msg.from, to: msg.to, promotion: msg.promotion });
        await this.triggerBotMove(room);
      } catch (err) {
        ws.send(JSON.stringify({ type: "move-rejected", reason: err.message, from: msg.from, to: msg.to }));
      }
      return;
    }

    if (msg.type === "resign") {
      // Identity comes from the WS's own tags, never from the message body —
      // same spectator-can't-forge-a-resignation guarantee index.js had.
      if (color !== "white" && color !== "black") return;
      if (!game || game.result) return;
      const winner = color === "white" ? "black" : "white";
      game.result = { reason: "resignation", winner, resignedBy: color };
      await this.persist();
      this.broadcast("game-state", serialize(game));
      return;
    }
  }

  async webSocketClose(ws) {
    const { color, name } = this.tagsOf(ws);
    if (color !== "white" && color !== "black") return;
    const game = await this.getGame();
    if (game.players[color] && game.players[color].name === name) {
      game.players[color].connected = false;
      await this.persist();
      this.broadcast("player-disconnected", { color, name });
    }
  }
}
