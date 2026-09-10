import http from "http";
import { getBotMove } from "./bot.js";

// Stockfish (bot.js) can't run inside a Cloudflare Workers isolate — it
// shells out via child_process and ships a 75MB wasm blob. This tiny HTTP
// wrapper is what the GameRoom Durable Object calls instead (BOT_ORIGIN),
// keeping bot.js itself completely unchanged.
const PORT = process.env.PORT || 3005;
const SHARED_SECRET = process.env.BOT_SHARED_SECRET || "";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { status: "ok", service: "game-bot" });
  }

  if (req.method !== "POST" || req.url !== "/move") {
    return json(res, 404, { error: "not found" });
  }

  if (SHARED_SECRET && req.headers["x-internal-secret"] !== SHARED_SECRET) {
    return json(res, 401, { error: "unauthorized" });
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", async () => {
    try {
      const { fen, difficulty } = JSON.parse(body || "{}");
      const move = await getBotMove(fen, difficulty);
      json(res, 200, move);
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  });
});

server.listen(PORT, () => console.log(`game-bot listening on ${PORT}`));
