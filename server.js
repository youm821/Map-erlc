// ERLC Navigator server: serves the site, proxies the ER:LC API, saves road edits.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MAP_FILE = path.join(DATA_DIR, "map.json");
const DEFAULT_MAP = path.join(__dirname, "defaults", "map.json");
const API = "https://api.erlc.gg/v2/server?Players=true";
const TYPES = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png" };
const cache = new Map();

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function isAdmin(req) {
  const pw = process.env.ADMIN_PASSWORD;
  return !!pw && same(req.headers["x-admin-password"] || "", pw);
}
function readBody(req) {
  return new Promise((ok, no) => {
    let d = "";
    req.on("data", c => { d += c; if (d.length > 1e6) { no(new Error("too big")); req.destroy(); } });
    req.on("end", () => ok(d));
    req.on("error", no);
  });
}
async function players(req, res) {
  const key = req.headers["x-server-key"] || process.env.ERLC_SERVER_KEY;
  if (!key) return send(res, 400, { message: "No server key. Set ERLC_SERVER_KEY on the server or paste one in the page." });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 5000) return send(res, hit.code, hit.text);
  try {
    const r = await fetch(API, { headers: { "server-key": key } });
    const text = await r.text();
    if (cache.size > 50) cache.clear();
    cache.set(key, { t: Date.now(), code: r.status, text });
    send(res, r.status, text);
  } catch (e) {
    send(res, 502, { message: "Couldn't reach the ER:LC API" });
  }
}
function readMap() {
  for (const f of [MAP_FILE, DEFAULT_MAP]) { try { return fs.readFileSync(f, "utf8"); } catch (e) {} }
  return "{}";
}
async function saveMap(req, res) {
  if (!process.env.ADMIN_PASSWORD) return send(res, 403, { message: "ADMIN_PASSWORD is not set on the server" });
  if (!isAdmin(req)) return send(res, 401, { message: "Wrong admin password" });
  let d;
  try { d = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { message: "Bad JSON" }); }
  if (!d || typeof d.roads !== "object" || typeof d.postals !== "object") return send(res, 400, { message: "Need roads and postals" });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MAP_FILE, JSON.stringify({ roads: d.roads, postals: d.postals }));
  send(res, 200, { ok: true });
}
function serveStatic(url, res) {
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (p === path.sep || p === "/" || p === ".") p = "index.html";
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB)) return send(res, 403, "Forbidden", "text/plain");
  fs.readFile(f, (err, data) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": f.endsWith(".html") ? "no-cache" : "public, max-age=3600" });
    res.end(data);
  });
}
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/players" && req.method === "GET") return players(req, res);
    if (url.pathname === "/api/map" && req.method === "GET") return send(res, 200, readMap());
    if (url.pathname === "/api/map" && req.method === "POST") return saveMap(req, res);
    if (url.pathname === "/api/auth" && req.method === "POST") return isAdmin(req) ? send(res, 200, { ok: true }) : send(res, 401, { message: "Wrong admin password" });
    if (req.method === "GET") return serveStatic(url, res);
    send(res, 405, { message: "Method not allowed" });
  } catch (e) { send(res, 500, { message: "Server error" }); }
}).listen(PORT, () => console.log("ERLC Navigator on port " + PORT));
