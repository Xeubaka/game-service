import { Chess } from "chess.js";

// Bot games are single-player scratch sessions (client-generated roomId,
// never revisited) — skip Postgres for them entirely, not worth the round trip.
export const isBotRoom = (roomId) => roomId.startsWith("bot-");

export const STARTING_CLOCK_MS = 3 * 60 * 1000;
const LOW_TIME_THRESHOLD_MS = 5000;
const LOW_TIME_BONUS_MS = 5000;
// Bounds for a room-configurable time control (room-service#2/game-service#2)
// — matches room-service's own 1-60 minute clamp on the host's chosen value.
const MIN_STARTING_CLOCK_MS = 60 * 1000;
const MAX_STARTING_CLOCK_MS = 60 * 60 * 1000;

// game-service trusts the client-supplied join-room payload the same way it
// already trusts color/vsBot/difficulty (no auth anywhere in this app), but
// still clamps a wildly invalid duration (0, negative, NaN) rather than
// letting it produce an instant or unbounded flag-fall.
export function normalizeStartingClockMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return STARTING_CLOCK_MS;
  return Math.min(MAX_STARTING_CLOCK_MS, Math.max(MIN_STARTING_CLOCK_MS, n));
}

export function createGame() {
  return {
    chess: new Chess(),
    moves: [],
    players: {},
    result: null,
    clocks: { white: STARTING_CLOCK_MS, black: STARTING_CLOCK_MS },
    // Clock only starts once both seats are actually filled (index.js sets
    // clockStarted/turnStartedAt at that point) — a lone first player
    // waiting for an opponent shouldn't burn their own clock. Bot games
    // never start it (see applyMove/scheduleFlagTimer's isBotRoom guards).
    turnStartedAt: null,
    clockStarted: false
  };
}

// Applies elapsed time (since turnStartedAt) to the side that just moved.
// Pure function so it's the single source of truth for the flag-fall
// condition/math, shared by applyMove (checked when a move arrives) and
// index.js's proactive flag-fall timer (checked when nobody moves at all).
//
// Low-time rule: once a side's remaining time was already below 5 seconds
// *before* this tick, completing the move in time adds 5 seconds on top of
// whatever remains — not a flat reset.
export function tickClock(clocks, colorToMove, turnStartedAt, now) {
  const elapsed = now - turnStartedAt;
  const remainingBefore = clocks[colorToMove];
  const remainingAfterElapsed = remainingBefore - elapsed;
  if (remainingAfterElapsed <= 0) {
    return { clocks: { ...clocks, [colorToMove]: 0 }, flagFall: true };
  }
  const bonus = remainingBefore < LOW_TIME_THRESHOLD_MS ? LOW_TIME_BONUS_MS : 0;
  return { clocks: { ...clocks, [colorToMove]: remainingAfterElapsed + bonus }, flagFall: false };
}

export function serialize(game) {
  const last = game.moves[game.moves.length - 1];
  return {
    fen: game.chess.fen(),
    turn: game.chess.turn() === "w" ? "white" : "black",
    isCheck: game.chess.isCheck(),
    isCheckmate: game.chess.isCheckmate(),
    isDraw: game.chess.isDraw(),
    moves: game.moves.map((m) => m.san),
    lastMove: last ? { from: last.from, to: last.to } : null, // for the frontend's last-move highlight
    players: game.players, // Include player connection status
    result: game.result, // null while ongoing; { reason, winner, resignedBy } on resignation, { reason: "flagfall", winner, loser } on flag-fall
    // clocks: remaining ms per side as of turnStartedAt (frozen for whoever
    // isn't on the move). Frontend renders a local countdown for the side to
    // move between these resync points instead of the server ticking every
    // second, per docs/SCOPE.md's explicit design call on this item.
    clocks: game.clockStarted ? game.clocks : null,
    turnStartedAt: game.clockStarted ? game.turnStartedAt : null
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
export function applyMove(game, roomId, { from, to, promotion }, deps = {}, now = Date.now()) {
  const { emit, publish, saveGame } = deps;

  if (game.result || game.chess.isGameOver()) throw new Error("game is already over");

  // Bot games never start the clock (see createGame) — no point racing a
  // human against Stockfish's own thinking time.
  if (game.clockStarted && !isBotRoom(roomId)) {
    const colorToMove = game.chess.turn() === "w" ? "white" : "black";
    const { clocks, flagFall } = tickClock(game.clocks, colorToMove, game.turnStartedAt, now);
    game.clocks = clocks;
    if (flagFall) {
      const winner = colorToMove === "white" ? "black" : "white";
      game.result = { reason: "flagfall", winner, loser: colorToMove };
      if (emit) emit(roomId, "game-state", serialize(game));
      if (saveGame) Promise.resolve(saveGame(roomId, game)).catch((e) => console.error("save game failed", e));
      throw new Error("flag fell");
    }
  }

  const move = game.chess.move({ from, to, promotion: promotion || "q" });
  if (!move) throw new Error("illegal move");

  game.moves.push({ san: move.san, from, to, fen: game.chess.fen(), ts: now });
  game.turnStartedAt = now;

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
