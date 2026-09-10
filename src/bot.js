import { Stockfish } from "@se-oss/stockfish";

const DIFFICULTY = {
  easy: { skillLevel: 2, depth: 5 },
  medium: { skillLevel: 10, depth: 10 },
  hard: { skillLevel: 18, depth: 15 }
};

// ponytail: one shared engine instance serializes concurrent bot games
// (analyze() calls queue behind each other). Fine for a learning project's
// traffic; a pool (StockfishPool from the same package) is the upgrade path
// if concurrent bot games become a real load.
let enginePromise = null;
function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const engine = new Stockfish();
      await engine.waitReady();
      return engine;
    })();
  }
  return enginePromise;
}

// Returns { from, to, promotion } for the given FEN at the requested
// difficulty, or null if the engine has no move (e.g. game already over).
export async function getBotMove(fen, difficulty = "medium") {
  const { skillLevel, depth } = DIFFICULTY[difficulty] || DIFFICULTY.medium;
  const engine = await getEngine();
  await engine.send(`setoption name Skill Level value ${skillLevel}`);
  const { bestmove } = await engine.analyze(fen, depth);
  if (!bestmove || bestmove === "(none)") return null;
  return {
    from: bestmove.slice(0, 2),
    to: bestmove.slice(2, 4),
    promotion: bestmove.slice(4, 5) || undefined
  };
}
