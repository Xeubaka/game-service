import { Chess } from "chess.js";

// Bot games are single-player scratch sessions (client-generated roomId,
// never revisited) — skip Postgres for them entirely, not worth the round trip.
export const isBotRoom = (roomId) => roomId.startsWith("bot-");

export function createGame() {
  return { chess: new Chess(), moves: [], players: {}, result: null };
}

export function serialize(game) {
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

// Core move-application logic, shared by the socket "move" handler and the
// bot's own turn (index.js) so both paths get identical validation,
// broadcast, and the Redis publish analysis-service depends on.
//
// Side effects (socket broadcast, Redis publish, Postgres write-through) are
// injected via `deps` rather than imported directly, so this function is
// unit-testable without a live socket.io server, Redis connection, or
// Postgres pool — index.js supplies the real implementations; tests can
// supply fakes/spies.
//
//   deps.emit(roomId, event, payload)   — broadcast to the room
//   deps.publish(channel, message)      — fire-and-forget Redis publish
//   deps.saveGame(roomId, game)         — fire-and-forget Postgres write-through
//
// Any dep may be omitted (defaults to a no-op), which is what lets tests
// exercise just the parts they care about.
export function applyMove(game, roomId, { from, to, promotion }, deps = {}) {
  const { emit, publish, saveGame } = deps;

  if (game.result) throw new Error("game is already over");
  const move = game.chess.move({ from, to, promotion: promotion || "q" });
  if (!move) throw new Error("illegal move");

  game.moves.push({ san: move.san, from, to, fen: game.chess.fen(), ts: Date.now() });

  if (emit) emit(roomId, "game-state", serialize(game));

  // Fire-and-forget publish. game-service does NOT wait for analysis-service.
  if (publish) {
    publish(
      `moves:${roomId}`,
      JSON.stringify({ roomId, fen: game.chess.fen(), moveCount: game.moves.length })
    );
  }

  // Fire-and-forget write-through. A game-service restart rehydrates from
  // Postgres via getOrCreateGame instead of losing in-progress games.
  if (saveGame && !isBotRoom(roomId)) {
    Promise.resolve(saveGame(roomId, game)).catch((e) => console.error("save game failed", e));
  }

  return move;
}
