import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame, serialize, applyMove, isBotRoom } from "./gameLogic.js";

test("createGame starts at the standard position with no moves/result", () => {
  const game = createGame();
  assert.equal(game.chess.fen(), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  assert.deepEqual(game.moves, []);
  assert.deepEqual(game.players, {});
  assert.equal(game.result, null);
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
