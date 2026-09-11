import http from "http";
import express from "express";
import { Server } from "socket.io";
import { createClient } from "redis";
import { Chess } from "chess.js";
import { getBotMove } from "./bot.js";
import { saveGame, loadGame } from "./db.js";
import { createGame, isBotRoom, applyMove as applyMoveCore, serialize, tickClock, STARTING_CLOCK_MS, normalizeStartingClockMs } from "./gameLogic.js";

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const PORT = process.env.PORT || 3002;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/health", (_req, res) => res.json({ status: "ok", service: "game-service" }));

// One Chess.js instance + move log per room, held in memory as the live
// cache (still the only place a room's connected-socket state lives — that
// never survives a restart regardless). Durable game state itself is
// write-through'd to Postgres in applyMove/resign (see db.js) and rehydrated
// here on a cache miss, so a game-service restart no longer loses in-progress
// games — only GAME_DB_URL being unset (e.g. running outside docker-compose)
// falls back to memory-only, same as before this existed.
const games = new Map(); // roomId -> { chess: Chess, moves: [], players: {white, black} }

// Proactive flag-fall: fires even if the side to move never attempts another
// move at all (applyMove's own clock check only catches a flag-fall that
// arrives attached to a move attempt). One timer per room, rescheduled after
// every clock-relevant event; scheduleFlagTimer no-ops for bot rooms/games
// without a started clock, so callers can call it unconditionally.
const flagTimers = new Map(); // roomId -> Timeout

function clearFlagTimer(roomId) {
  clearTimeout(flagTimers.get(roomId));
  flagTimers.delete(roomId);
}

function scheduleFlagTimer(game, roomId) {
  clearFlagTimer(roomId);
  if (isBotRoom(roomId) || !game.clockStarted || game.result || game.chess.isGameOver()) return;

  const colorToMove = game.chess.turn() === "w" ? "white" : "black";
  const remaining = Math.max(0, game.clocks[colorToMove] - (Date.now() - game.turnStartedAt));
  flagTimers.set(
    roomId,
    setTimeout(() => {
      flagTimers.delete(roomId);
      if (game.result) return;
      // Re-run the same tickClock math a move attempt would use (rather
      // than trusting the scheduled duration outright) in case this fired
      // a beat late from event-loop delay.
      const { clocks, flagFall } = tickClock(game.clocks, colorToMove, game.turnStartedAt, Date.now());
      game.clocks = clocks;
      if (!flagFall) {
        scheduleFlagTimer(game, roomId);
        return;
      }
      const winner = colorToMove === "white" ? "black" : "white";
      game.result = { reason: "flagfall", winner, loser: colorToMove };
      io.to(roomId).emit("game-state", serialize(game));
      saveGame(roomId, game).catch((e) => console.error("save game failed", e));
    }, remaining)
  );
}

async function getOrCreateGame(roomId) {
  if (games.has(roomId)) return games.get(roomId);

  const saved = isBotRoom(roomId) ? null : await loadGame(roomId);
  const game = saved
    ? {
        chess: new Chess(saved.fen),
        moves: saved.moves,
        players: saved.players,
        result: saved.result,
        // ponytail: clocks aren't persisted (db.js has no column for them) —
        // a restart mid-game resets both sides to a fresh 3:00 instead of
        // losing the room entirely. Add a clocks column if exact
        // restart-safe time matters later.
        clocks: { white: STARTING_CLOCK_MS, black: STARTING_CLOCK_MS },
        turnStartedAt: null,
        clockStarted: false
      }
    : createGame();

  games.set(roomId, game);
  return game;
}

// Publisher: tells analysis-service a move happened, without waiting for a reply.
const publisher = createClient({ url: REDIS_URL });
publisher.on("error", (e) => console.error("Redis pub error", e));
await publisher.connect();

// Subscriber: listens for analysis-service's win-probability results and
// relays them to both players. This is the async round-trip in action.
const subscriber = createClient({ url: REDIS_URL });
subscriber.on("error", (e) => console.error("Redis sub error", e));
await subscriber.connect();
await subscriber.pSubscribe("analysis:*", (message, channel) => {
  const roomId = channel.split(":")[1];
  const payload = JSON.parse(message);
  io.to(roomId).emit("analysis-update", payload);
});

io.on("connection", (socket) => {
  // Track which room and color this socket is associated with for disconnect handling
  let currentRoomId = null;
  let currentColor = null;

  socket.on("join-room", async ({ roomId, color, name, vsBot, difficulty, timeControlMs }) => {
    // Store context for disconnect handler
    currentRoomId = roomId;
    currentColor = color;

    socket.join(roomId);
    const game = await getOrCreateGame(roomId);

    // Bot games skip room-service entirely — the client generates its own
    // roomId and there's never a second human socket, so the "opponent"
    // color is just whichever one the human didn't pick.
    if (vsBot && !game.vsBot) {
      game.vsBot = true;
      game.botColor = color === "white" ? "black" : "white";
      game.botDifficulty = difficulty || "medium";
    }

    if (color === "white" || color === "black") {
      const isReconnect = game.players[color] && game.players[color].name === name;

      // Update or create player entry
      game.players[color] = { socketId: socket.id, name, connected: true };

      // If this is a reconnect, notify other players
      if (isReconnect) {
        io.to(roomId).emit("player-reconnected", { color, name });
      }
    }

    // Room-configurable time control: applied from whichever join sends a
    // valid value, as long as the clock hasn't started yet — both the
    // creator and the joiner read the same room.timeControlMs from
    // room-service, so this is idempotent between them. Guarded by
    // clockStarted so a later reconnect can't reset an in-progress clock.
    if (!game.clockStarted && typeof timeControlMs !== "undefined") {
      const clamped = normalizeStartingClockMs(timeControlMs);
      game.clocks = { white: clamped, black: clamped };
    }

    // Chess clock starts once both seats are actually filled (or immediately
    // for a bot game, which has no second human to wait for) — not at room
    // creation, so a lone first player waiting for an opponent doesn't burn
    // their own clock. Reconnects don't re-trigger this (clockStarted latches).
    const clockJustStarted = !game.clockStarted && (game.vsBot || (game.players.white && game.players.black));
    if (clockJustStarted) {
      game.turnStartedAt = Date.now();
      game.clockStarted = true;
    }

    const state = serialize(game);
    // Normally only the joiner needs this reply. But the clock starting is
    // new shared information the already-present player needs too (their
    // own last game-state had clocks: null) — broadcast to the whole room
    // instead in that one case, rather than emitting to the joiner twice
    // (which would race any one-shot "game-state" listener, client or test).
    if (clockJustStarted) io.to(roomId).emit("game-state", state);
    else socket.emit("game-state", state);
    triggerBotMove(game, roomId);
    scheduleFlagTimer(game, roomId);
  });

  socket.on("move", async ({ roomId, from, to, promotion }) => {
    const game = await getOrCreateGame(roomId);
    try {
      applyMove(game, roomId, { from, to, promotion });
      triggerBotMove(game, roomId);
      scheduleFlagTimer(game, roomId);
    } catch (err) {
      // A flag-fall caught here (rather than by the proactive timer below)
      // still leaves that timer armed for a now-finished game — clear it.
      if (err.message === "flag fell") clearFlagTimer(roomId);
      socket.emit("move-rejected", { reason: err.message, from, to });
    }
  });

  socket.on("resign", () => {
    // Only an actual player can resign — a spectator's currentColor is
    // "spectator", not "white"/"black", so this also guards against a
    // spectator forging a resignation for a side they aren't playing.
    if (currentColor !== "white" && currentColor !== "black") return;
    if (!currentRoomId) return;
    const game = games.get(currentRoomId);
    if (!game || game.result) return; // no game yet, or already over

    const winner = currentColor === "white" ? "black" : "white";
    game.result = { reason: "resignation", winner, resignedBy: currentColor };
    clearFlagTimer(currentRoomId);
    io.to(currentRoomId).emit("game-state", serialize(game));
    if (!isBotRoom(currentRoomId)) saveGame(currentRoomId, game).catch((e) => console.error("save game failed", e));
  });

  socket.on("disconnect", () => {
    // Mark player as disconnected but keep the game state
    // Allow reconnect with same room+color
    if (currentRoomId && currentColor) {
      const game = games.get(currentRoomId);
      if (game && game.players[currentColor] && game.players[currentColor].socketId === socket.id) {
        game.players[currentColor].connected = false;
        io.to(currentRoomId).emit("player-disconnected", { 
          color: currentColor, 
          name: game.players[currentColor].name 
        });
      }
    }
  });
});

// REST endpoint for the move log (used by the "trackable log" requirement,
// and independently testable/curl-able without opening a websocket).
app.get("/rooms/:id/moves", (req, res) => {
  const game = games.get(req.params.id);
  if (!game) return res.status(404).json({ error: "no such game" });
  res.json({ moves: game.moves, fen: game.chess.fen() });
});

// Shared by the socket "move" handler and the bot's own turn, so both paths
// get identical validation, broadcast, and the Redis publish analysis-service
// depends on. The actual logic lives in gameLogic.js (unit-tested there,
// deps-injected); this is just the wiring to the real io/publisher/saveGame.
function applyMove(game, roomId, moveArgs) {
  return applyMoveCore(game, roomId, moveArgs, {
    emit: (room, event, payload) => io.to(room).emit(event, payload),
    publish: (channel, message) => publisher.publish(channel, message),
    saveGame
  });
}

function triggerBotMove(game, roomId) {
  if (!game.vsBot || game.result || game.chess.isGameOver()) return;
  if (game.chess.turn() !== game.botColor[0]) return;
  getBotMove(game.chess.fen(), game.botDifficulty)
    .then((botMove) => {
      if (!botMove || game.result) return;
      applyMove(game, roomId, botMove);
    })
    .catch((err) => console.error("bot move failed", err));
}

server.listen(PORT, () => console.log(`game-service listening on ${PORT}`));
