import http from "http";
import express from "express";
import { Server } from "socket.io";
import { createClient } from "redis";
import { Chess } from "chess.js";

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const PORT = process.env.PORT || 3002;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/health", (_req, res) => res.json({ status: "ok", service: "game-service" }));

// One Chess.js instance + move log per room, held in memory here.
// (In production this would move to Redis/Postgres so any game-service
// replica could serve the room — worth mentioning in an interview as the
// "how would you scale this horizontally" answer.)
const games = new Map(); // roomId -> { chess: Chess, moves: [], players: {white, black} }

function getOrCreateGame(roomId) {
  if (!games.has(roomId)) {
    games.set(roomId, { chess: new Chess(), moves: [], players: {}, result: null });
  }
  return games.get(roomId);
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

  socket.on("join-room", ({ roomId, color, name }) => {
    // Store context for disconnect handler
    currentRoomId = roomId;
    currentColor = color;

    socket.join(roomId);
    const game = getOrCreateGame(roomId);
    
    if (color === "white" || color === "black") {
      const isReconnect = game.players[color] && game.players[color].name === name;
      
      // Update or create player entry
      game.players[color] = { socketId: socket.id, name, connected: true };
      
      // If this is a reconnect, notify other players
      if (isReconnect) {
        io.to(roomId).emit("player-reconnected", { color, name });
      }
    }
    
    socket.emit("game-state", serialize(game));
  });

  socket.on("move", ({ roomId, from, to, promotion }) => {
    const game = getOrCreateGame(roomId);
    try {
      if (game.result) throw new Error("game is already over");
      const move = game.chess.move({ from, to, promotion: promotion || "q" });
      if (!move) throw new Error("illegal move");

      game.moves.push({ san: move.san, from, to, fen: game.chess.fen(), ts: Date.now() });

      const state = serialize(game);
      io.to(roomId).emit("game-state", state);

      // Fire-and-forget publish. game-service does NOT wait for analysis-service.
      publisher.publish(
        `moves:${roomId}`,
        JSON.stringify({ roomId, fen: game.chess.fen(), moveCount: game.moves.length })
      );
    } catch (err) {
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
    io.to(currentRoomId).emit("game-state", serialize(game));
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

function serialize(game) {
  return {
    fen: game.chess.fen(),
    turn: game.chess.turn() === "w" ? "white" : "black",
    isCheck: game.chess.isCheck(),
    isCheckmate: game.chess.isCheckmate(),
    isDraw: game.chess.isDraw(),
    moves: game.moves.map((m) => m.san),
    players: game.players, // Include player connection status
    result: game.result // null while the game is ongoing; { reason, winner, resignedBy } once someone resigns
  };
}

server.listen(PORT, () => console.log(`game-service listening on ${PORT}`));
