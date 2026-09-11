import pg from "pg";

const { Pool } = pg;
const DB_URL = process.env.GAME_DB_URL;

// No GAME_DB_URL (e.g. running outside docker-compose) => every function
// below is a no-op and the in-memory Map is the only state, same as before
// this file existed. Same graceful-degradation shape as analysis-service
// being offline: game-service must never fail to serve a game just because
// persistence isn't available.
const pool = DB_URL ? new Pool({ connectionString: DB_URL }) : null;

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        room_id TEXT PRIMARY KEY,
        fen TEXT NOT NULL,
        moves JSONB NOT NULL,
        players JSONB NOT NULL,
        result JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }
  return schemaReady;
}

export async function saveGame(roomId, game) {
  if (!pool) return;
  await ensureSchema();
  await pool.query(
    `INSERT INTO games (room_id, fen, moves, players, result, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (room_id) DO UPDATE
       SET fen = $2, moves = $3, players = $4, result = $5, updated_at = now()`,
    [
      roomId,
      game.chess.fen(),
      JSON.stringify(game.moves),
      JSON.stringify(game.players),
      game.result ? JSON.stringify(game.result) : null
    ]
  );
}

export async function loadGame(roomId) {
  if (!pool) return null;
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT fen, moves, players, result FROM games WHERE room_id = $1`,
    [roomId]
  );
  return rows[0] || null;
}

// Backs the admin page's game history list (chess-plataform#3) — most
// recently updated first, capped at 100 rather than paginated (a
// teaching-scope local admin view, not a production audit log).
export async function listGames() {
  if (!pool) return [];
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT room_id, fen, moves, players, result, updated_at FROM games ORDER BY updated_at DESC LIMIT 100`
  );
  return rows;
}
