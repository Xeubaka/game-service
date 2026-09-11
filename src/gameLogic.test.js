import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  serialize,
  applyMove,
  isBotRoom,
  tickClock,
  STARTING_CLOCK_MS,
  normalizeStartingClockMs,
  canRequestRematch,
  requestRematch,
  canRespondToRematch,
  resetGameForRematch,
  REMATCH_WINDOW_MS,
  summarizeGameForAdmin
} from "./gameLogic.js";

test("createGame starts at the standard position with no moves/result", () => {
  const game = createGame();
  assert.equal(game.chess.fen(), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  assert.deepEqual(game.moves, []);
  assert.deepEqual(game.players, {});
  assert.equal(game.result, null);
  assert.deepEqual(game.clocks, { white: STARTING_CLOCK_MS, black: STARTING_CLOCK_MS });
  assert.equal(game.clockStarted, false);
});

test("normalizeStartingClockMs clamps to [1min, 60min] and defaults invalid input to the 3-minute standard", () => {
  assert.equal(normalizeStartingClockMs(5 * 60 * 1000), 5 * 60 * 1000);
  assert.equal(normalizeStartingClockMs(30 * 1000), 60 * 1000); // below 1 min floor
  assert.equal(normalizeStartingClockMs(120 * 60 * 1000), 60 * 60 * 1000); // above 60 min ceiling
  assert.equal(normalizeStartingClockMs(0), STARTING_CLOCK_MS);
  assert.equal(normalizeStartingClockMs(-1000), STARTING_CLOCK_MS);
  assert.equal(normalizeStartingClockMs(NaN), STARTING_CLOCK_MS);
  assert.equal(normalizeStartingClockMs(undefined), STARTING_CLOCK_MS);
  assert.equal(normalizeStartingClockMs("not a number"), STARTING_CLOCK_MS);
});

test("tickClock decrements the moving side's clock by elapsed time", () => {
  const { clocks, flagFall } = tickClock({ white: 60000, black: 60000 }, "white", 1000, 6000);
  assert.equal(flagFall, false);
  assert.equal(clocks.white, 55000);
  assert.equal(clocks.black, 60000); // untouched
});

test("tickClock reports flag-fall once elapsed time exceeds the remaining clock", () => {
  const { clocks, flagFall } = tickClock({ white: 5000, black: 60000 }, "white", 0, 6000);
  assert.equal(flagFall, true);
  assert.equal(clocks.white, 0);
});

test("tickClock adds the 5s low-time bonus only when remaining was already under 5s before this tick", () => {
  const underThreshold = tickClock({ white: 4000, black: 60000 }, "white", 0, 1000);
  assert.equal(underThreshold.flagFall, false);
  assert.equal(underThreshold.clocks.white, 4000 - 1000 + 5000);

  const atOrAboveThreshold = tickClock({ white: 5000, black: 60000 }, "white", 0, 1000);
  assert.equal(atOrAboveThreshold.clocks.white, 5000 - 1000); // no bonus
});

test("applyMove ticks the clock once clockStarted, and refuses (flag-fall) a move arriving after time expired", () => {
  const game = createGame();
  game.clockStarted = true;
  game.clocks.white = 500; // half a second left
  game.turnStartedAt = 0;

  assert.throws(() => applyMove(game, "ROOM1", { from: "e2", to: "e4" }, {}, 1000), /flag fell/);
  assert.equal(game.result.reason, "flagfall");
  assert.equal(game.result.winner, "black");
  assert.equal(game.result.loser, "white");
  assert.equal(game.clocks.white, 0);
  assert.deepEqual(game.moves, []); // the move itself never applied
});

test("applyMove leaves the clock untouched for bot rooms even when clockStarted", () => {
  const game = createGame();
  game.clockStarted = true;
  const move = applyMove(game, "bot-xyz", { from: "e2", to: "e4" }, {}, game.turnStartedAt ?? Date.now());
  assert.equal(move.san, "e4");
  assert.deepEqual(game.clocks, { white: STARTING_CLOCK_MS, black: STARTING_CLOCK_MS });
});

test("applyMove does not tick the clock before clockStarted (lone player waiting for an opponent)", () => {
  const game = createGame(); // clockStarted defaults to false
  const move = applyMove(game, "ROOM1", { from: "e2", to: "e4" }, {}, Date.now() + 10 * 60 * 1000);
  assert.equal(move.san, "e4");
  assert.deepEqual(game.clocks, { white: STARTING_CLOCK_MS, black: STARTING_CLOCK_MS });
});

test("applyMove refuses further moves once chess.js itself reports the game over (checkmate), not just via game.result", () => {
  const game = createGame();
  applyMove(game, "ROOM1", { from: "f2", to: "f3" });
  applyMove(game, "ROOM1", { from: "e7", to: "e5" });
  applyMove(game, "ROOM1", { from: "g2", to: "g4" });
  applyMove(game, "ROOM1", { from: "d8", to: "h4" }); // fool's mate
  assert.throws(() => applyMove(game, "ROOM1", { from: "e1", to: "e2" }), /game is already over/);
});

test("isBotRoom matches only client-generated bot-* room ids", () => {
  assert.equal(isBotRoom("bot-abc123"), true);
  assert.equal(isBotRoom("ABC123"), false);
});

test("applyMove delegates validation to chess.js and rejects illegal moves", () => {
  const game = createGame();
  // chess.js (this version) throws on an illegal move rather than returning
  // falsy — applyMove lets that propagate as-is, which is what the socket
  // handler in index.js catches and turns into a move-rejected event.
  assert.throws(() => applyMove(game, "ROOM1", { from: "e2", to: "e5" }), /Invalid move/);
  // Rejected move must not mutate game state.
  assert.deepEqual(game.moves, []);
  assert.equal(game.chess.turn(), "w");
});

test("applyMove accepts a legal move, updates the move log and chess position", () => {
  const game = createGame();
  const move = applyMove(game, "ROOM1", { from: "e2", to: "e4" });

  assert.equal(move.san, "e4");
  assert.equal(game.moves.length, 1);
  assert.equal(game.moves[0].san, "e4");
  assert.equal(game.moves[0].from, "e2");
  assert.equal(game.moves[0].to, "e4");
  assert.equal(game.chess.turn(), "b");
});

test("applyMove defaults promotion to queen when none is given", () => {
  // A position one legal move from promotion, white pawn on e7.
  const game = createGame();
  game.chess.load("8/4P3/8/8/8/8/7k/K7 w - - 0 1");
  const move = applyMove(game, "ROOM1", { from: "e7", to: "e8" });
  assert.equal(move.promotion, "q");
  assert.match(game.moves[0].san, /=Q/);
});

test("applyMove refuses further moves once the game has a result", () => {
  const game = createGame();
  game.result = { reason: "resignation", winner: "black", resignedBy: "white" };
  assert.throws(() => applyMove(game, "ROOM1", { from: "e2", to: "e4" }), /game is already over/);
  assert.deepEqual(game.moves, []);
});

test("applyMove publishes to Redis with roomId, fen, and moveCount on a legal move", () => {
  const game = createGame();
  const published = [];
  applyMove(game, "ROOM1", { from: "e2", to: "e4" }, {
    publish: (channel, message) => published.push({ channel, message })
  });

  assert.equal(published.length, 1);
  assert.equal(published[0].channel, "moves:ROOM1");
  const payload = JSON.parse(published[0].message);
  assert.equal(payload.roomId, "ROOM1");
  assert.equal(payload.fen, game.chess.fen());
  assert.equal(payload.moveCount, 1);
});

test("applyMove does not publish when the move is illegal", () => {
  const game = createGame();
  const published = [];
  assert.throws(() => applyMove(game, "ROOM1", { from: "e2", to: "e5" }, {
    publish: (channel, message) => published.push({ channel, message })
  }));
  assert.equal(published.length, 0);
});

test("applyMove broadcasts the serialized game state via emit", () => {
  const game = createGame();
  const emitted = [];
  applyMove(game, "ROOM1", { from: "e2", to: "e4" }, {
    emit: (roomId, event, payload) => emitted.push({ roomId, event, payload })
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].roomId, "ROOM1");
  assert.equal(emitted[0].event, "game-state");
  assert.deepEqual(emitted[0].payload.moves, ["e4"]);
});

test("applyMove write-throughs to Postgres for a real room but skips bot rooms", async () => {
  const saved = [];
  const saveGame = (roomId, game) => {
    saved.push(roomId);
    return Promise.resolve();
  };

  const realRoom = createGame();
  applyMove(realRoom, "ROOM1", { from: "e2", to: "e4" }, { saveGame });

  const botRoom = createGame();
  applyMove(botRoom, "bot-xyz", { from: "e2", to: "e4" }, { saveGame });

  // saveGame is fire-and-forget; give the microtask queue a turn.
  await Promise.resolve();
  assert.deepEqual(saved, ["ROOM1"]);
});

test("serialize reports turn, check/checkmate/draw flags, and SAN move list", () => {
  const game = createGame();
  applyMove(game, "ROOM1", { from: "e2", to: "e4" });
  const state = serialize(game);

  assert.equal(state.turn, "black");
  assert.equal(state.isCheck, false);
  assert.equal(state.isCheckmate, false);
  assert.equal(state.isDraw, false);
  assert.deepEqual(state.moves, ["e4"]);
  assert.equal(state.result, null);
});

test("serialize omits clocks/turnStartedAt until the clock has actually started", () => {
  const game = createGame();
  const state = serialize(game);
  assert.equal(state.clocks, null);
  assert.equal(state.turnStartedAt, null);
});

test("serialize exposes clocks and turnStartedAt once the clock has started", () => {
  const game = createGame();
  game.clockStarted = true;
  game.turnStartedAt = 12345;
  const state = serialize(game);
  assert.deepEqual(state.clocks, { white: STARTING_CLOCK_MS, black: STARTING_CLOCK_MS });
  assert.equal(state.turnStartedAt, 12345);
});

test("serialize reports lastMove as null on a fresh game and the most recent from/to after moves", () => {
  const game = createGame();
  assert.equal(serialize(game).lastMove, null);

  applyMove(game, "ROOM1", { from: "e2", to: "e4" });
  assert.deepEqual(serialize(game).lastMove, { from: "e2", to: "e4" });

  applyMove(game, "ROOM1", { from: "e7", to: "e5" });
  assert.deepEqual(serialize(game).lastMove, { from: "e7", to: "e5" });
});

test("serialize surfaces checkmate via chess.js (fool's mate)", () => {
  const game = createGame();
  applyMove(game, "ROOM1", { from: "f2", to: "f3" });
  applyMove(game, "ROOM1", { from: "e7", to: "e5" });
  applyMove(game, "ROOM1", { from: "g2", to: "g4" });
  applyMove(game, "ROOM1", { from: "d8", to: "h4" });

  const state = serialize(game);
  assert.equal(state.isCheckmate, true);
  assert.equal(state.turn, "white");
});

// --- Rematch (game-service#3/room-service#3/frontend#2) ---

function finishedTwoPlayerGame() {
  const game = createGame();
  game.players = { white: { name: "Alice" }, black: { name: "Bob" } };
  game.result = { reason: "resignation", winner: "black", resignedBy: "white" };
  return game;
}

test("canRequestRematch requires a finished 2-player game, the opponent present, and no pending offer", () => {
  const game = finishedTwoPlayerGame();
  assert.equal(canRequestRematch(game, "ROOM1", "white"), true);
  assert.equal(canRequestRematch(game, "ROOM1", "black"), true);

  assert.equal(canRequestRematch(game, "ROOM1", "spectator"), false);
  assert.equal(canRequestRematch(game, "bot-xyz", "white"), false); // no second human to accept

  const ongoing = createGame();
  ongoing.players = { white: {}, black: {} };
  assert.equal(canRequestRematch(ongoing, "ROOM1", "white"), false); // game not over

  const opponentGone = finishedTwoPlayerGame();
  delete opponentGone.players.black;
  assert.equal(canRequestRematch(opponentGone, "ROOM1", "white"), false);

  const alreadyPending = finishedTwoPlayerGame();
  requestRematch(alreadyPending, "white");
  assert.equal(canRequestRematch(alreadyPending, "ROOM1", "black"), false);
});

test("requestRematch records who asked and a 30s expiry", () => {
  const game = finishedTwoPlayerGame();
  const rematch = requestRematch(game, "white", 1000);
  assert.deepEqual(rematch, { requestedBy: "white", expiresAt: 1000 + REMATCH_WINDOW_MS });
  assert.deepEqual(game.rematch, rematch);
});

test("canRespondToRematch only allows the non-requesting player to answer", () => {
  const game = finishedTwoPlayerGame();
  assert.equal(canRespondToRematch(game, "white"), false); // no pending offer yet

  requestRematch(game, "white");
  assert.equal(canRespondToRematch(game, "black"), true);
  assert.equal(canRespondToRematch(game, "white"), false); // can't accept your own offer
  assert.equal(canRespondToRematch(game, "spectator"), false);
});

test("resetGameForRematch starts a fresh game at the same time control and clears the offer", () => {
  const game = finishedTwoPlayerGame();
  game.baseClockMs = 10 * 60 * 1000; // this room's configured time control
  game.moves = [{ san: "e4", from: "e2", to: "e4", fen: game.chess.fen(), ts: 0 }]; // pretend the finished game had moves
  requestRematch(game, "white");

  resetGameForRematch(game, 5000);

  assert.equal(game.chess.fen(), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  assert.deepEqual(game.moves, []);
  assert.equal(game.result, null);
  assert.equal(game.rematch, null);
  assert.deepEqual(game.clocks, { white: 10 * 60 * 1000, black: 10 * 60 * 1000 });
  assert.equal(game.turnStartedAt, 5000);
});

test("serialize exposes the pending rematch offer, and null when there isn't one", () => {
  const game = finishedTwoPlayerGame();
  assert.equal(serialize(game).rematch, null);

  const rematch = requestRematch(game, "black", 2000);
  assert.deepEqual(serialize(game).rematch, rematch);
});

// --- Admin page game history (chess-plataform#3) ---

function adminRow(overrides) {
  return {
    room_id: "ROOMX",
    fen: createGame().chess.fen(),
    moves: [],
    players: { white: { name: "Alice" }, black: { name: "Bob" } },
    result: null,
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

test("summarizeGameForAdmin reports an ongoing game with no result column", () => {
  const summary = summarizeGameForAdmin(adminRow({ room_id: "ROOM1" }));
  assert.equal(summary.roomId, "ROOM1");
  assert.equal(summary.status, "ongoing");
  assert.equal(summary.outcome, "ongoing");
  assert.equal(summary.moveCount, 0);
  assert.deepEqual(summary.players, { white: { name: "Alice" }, black: { name: "Bob" } });
});

test("summarizeGameForAdmin renders resignation and flagfall results from the result column", () => {
  const resigned = summarizeGameForAdmin(
    adminRow({ result: { reason: "resignation", winner: "black", resignedBy: "white" } })
  );
  assert.equal(resigned.status, "ended");
  assert.equal(resigned.outcome, "white resigned — black won");

  const flagged = summarizeGameForAdmin(adminRow({ result: { reason: "flagfall", winner: "black", loser: "white" } }));
  assert.equal(flagged.status, "ended");
  assert.equal(flagged.outcome, "white ran out of time — black won");
});

test("summarizeGameForAdmin derives checkmate from the stored FEN when the result column is null", () => {
  const game = createGame();
  applyMove(game, "ROOM1", { from: "f2", to: "f3" });
  applyMove(game, "ROOM1", { from: "e7", to: "e5" });
  applyMove(game, "ROOM1", { from: "g2", to: "g4" });
  applyMove(game, "ROOM1", { from: "d8", to: "h4" }); // fool's mate

  const summary = summarizeGameForAdmin(adminRow({ fen: game.chess.fen(), moves: game.moves.map((m) => m.san) }));
  assert.equal(summary.status, "ended");
  assert.equal(summary.outcome, "checkmate — black won");
  assert.equal(summary.moveCount, 4);
});

test("summarizeGameForAdmin derives a draw from the stored FEN (insufficient material) when the result column is null", () => {
  const summary = summarizeGameForAdmin(adminRow({ fen: "8/8/8/4k3/8/8/8/4K3 w - - 0 1" }));
  assert.equal(summary.status, "ended");
  assert.equal(summary.outcome, "draw");
});
