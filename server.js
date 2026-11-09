// ERLC Navigator server: serves the app, proxies the ER:LC API, and hosts many independent "servers" (tenants).
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SRV_DIR = path.join(DATA_DIR, "servers");
const DEFAULT_MAP = path.join(__dirname, "defaults", "map.json");
const API = "https://api.erlc.gg/v2/server?Players=true&EmergencyCalls=true&ModCalls=true";
const DESKTOP = process.env.DESKTOP === "1";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED = new Set(["admin", "api", "s", "servers", "static", "public", "www"]);
const TYPES = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const cache = new Map(), hits = new Map(), fails = new Map();
const SECRET = process.env.SERVER_SECRET ? crypto.scryptSync(process.env.SERVER_SECRET, "erlc-nav", 32) : null;

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const ipOf = req => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
function limited(k, max, ms) { const n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < ms); if (a.length >= max) { hits.set(k, a); return true; } a.push(n); hits.set(k, a); return false; }
const blocked = k => (fails.get(k) || []).filter(t => Date.now() - t < 600000).length >= 10;
const failed = k => fails.set(k, [...(fails.get(k) || []).filter(t => Date.now() - t < 600000), Date.now()]);
function readBody(req) {
  return new Promise((ok, no) => {
    let d = ""; req.on("data", c => { d += c; if (d.length > 1e6) { no(new Error("too big")); req.destroy(); } });
    req.on("end", () => ok(d)); req.on("error", no);
  });
}
async function jsonBody(req) { try { return JSON.parse(await readBody(req) || "{}"); } catch (e) { return null; } }
// --- secrets
function enc(text) {
  if (!text) return null;
  if (!SECRET) return "plain:" + text;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", SECRET, iv), ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return "gcm:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function dec(s) {
  if (!s) return null;
  try {
    if (s.startsWith("plain:")) return s.slice(6);
    if (!SECRET) return null;
    const b = Buffer.from(s.slice(4), "base64"), d = crypto.createDecipheriv("aes-256-gcm", SECRET, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch (e) { return null; }
}
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
// --- tenants
const fileOf = slug => path.join(SRV_DIR, slug + ".json");
function loadT(slug) { try { return JSON.parse(fs.readFileSync(fileOf(slug), "utf8")); } catch (e) { return null; } }
function saveT(slug, rec) { fs.mkdirSync(SRV_DIR, { recursive: true }); const f = fileOf(slug), tmp = f + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(rec)); fs.renameSync(tmp, f); }
function tenant(slug) {
  if (!SLUG_RE.test(slug) && slug !== "main") return null;
  let rec = loadT(slug);
  if (slug === "main") { rec = rec || {}; rec.name = rec.name || "Main server"; return { slug, rec, main: true }; }
  return rec ? { slug, rec, main: false } : null;
}
function adminOk(req, t) {
  if (DESKTOP) return true;
  const k = ipOf(req) + ":" + t.slug;
  if (blocked(k)) return null;                       // null = too many attempts
  const pw = String(req.headers["x-admin-password"] || "");
  let ok = false;
  if (t.rec.admin) ok = same(hashPw(pw, t.rec.admin.salt), t.rec.admin.hash);
  else if (t.main && process.env.ADMIN_PASSWORD) ok = same(pw, process.env.ADMIN_PASSWORD);
  if (!ok) failed(k);
  return ok;
}
function keyOf(t) { return dec(t.rec.key) || (t.main ? process.env.ERLC_SERVER_KEY : null); }
function mapOf(t) {
  if (t.rec.map) return t.rec.map;
  try { return JSON.parse(fs.readFileSync(DEFAULT_MAP, "utf8")); } catch (e) { return {}; }
}
async function guard(req, res, t) {
  const a = adminOk(req, t);
  if (a === null) { send(res, 429, { message: "Too many wrong passwords. Try again in a few minutes." }); return false; }
  if (!a) { send(res, 401, { message: t.main && !t.rec.admin && !process.env.ADMIN_PASSWORD ? "ADMIN_PASSWORD is not set on the server" : "Wrong admin password" }); return false; }
  return true;
}
// --- handlers
async function players(req, res, t) {
  const key = req.headers["x-server-key"] || keyOf(t);
  if (!key) return send(res, 400, { message: "No ER:LC server key for this server. An admin can add one on the Admin page, or paste your own in Settings." });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 5000) return send(res, hit.code, hit.text);
  try {
    const r = await fetch(API, { headers: { "server-key": key } }), text = await r.text();
    if (cache.size > 100) cache.clear();
    cache.set(key, { t: Date.now(), code: r.status, text }); send(res, r.status, text);
  } catch (e) { send(res, 502, { message: "Couldn't reach the ER:LC API" }); }
}
async function saveMap(req, res, t) {
  if (!(await guard(req, res, t))) return;
  const d = await jsonBody(req);
  if (!d || typeof d.roads !== "object" || typeof d.postals !== "object") return send(res, 400, { message: "Need roads and postals" });
  t.rec.map = { roads: d.roads, postals: d.postals, places: d.places || [], closed: d.closed || [], ub: d.ub || [] };
  saveT(t.slug, t.rec); send(res, 200, { ok: true });
}
async function setKey(req, res, t) {
  if (!(await guard(req, res, t))) return;
  const d = await jsonBody(req); if (!d) return send(res, 400, { message: "Bad JSON" });
  t.rec.key = enc(String(d.key || "").trim()); saveT(t.slug, t.rec); send(res, 200, { ok: true, hasKey: !!t.rec.key });
}
const slugify = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
async function createServer(req, res) {
  if (process.env.ALLOW_SIGNUP === "0") return send(res, 403, { message: "New servers are disabled here." });
  if (limited("create:" + ipOf(req), 5, 3600000)) return send(res, 429, { message: "Too many new servers from this address. Try later." });
  const d = await jsonBody(req); if (!d) return send(res, 400, { message: "Bad JSON" });
  if (process.env.INVITE_CODE && !same(String(d.inviteCode || ""), process.env.INVITE_CODE)) return send(res, 403, { message: "Wrong invite code" });
  const name = String(d.name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);
  if (name.length < 2) return send(res, 400, { message: "Give your server a name (2+ characters)" });
  const slug = slugify(d.slug || name);
  if (!SLUG_RE.test(slug) || RESERVED.has(slug) || slug === "main") return send(res, 400, { message: "Pick a different web address (3-32 letters, numbers, dashes)" });
  if (loadT(slug)) return send(res, 409, { message: "That address is taken" });
  const pw = String(d.adminPassword || ""); if (pw.length < 6) return send(res, 400, { message: "Admin password must be at least 6 characters" });
  const salt = crypto.randomBytes(16).toString("hex");
  saveT(slug, { name, slug, admin: { salt, hash: hashPw(pw, salt) }, key: enc(String(d.erlcKey || "").trim()), listed: !!d.listed, created: Date.now(), map: null });
  send(res, 200, { ok: true, slug, app: "/s/" + slug, admin: "/s/" + slug + "/admin" });
}
function listServers() {
  const out = [{ slug: "main", name: (loadT("main") || {}).name || "Main server" }];
  try { for (const f of fs.readdirSync(SRV_DIR)) { if (!f.endsWith(".json") || f === "main.json") continue; const r = loadT(f.slice(0, -5)); if (r && r.listed) out.push({ slug: r.slug, name: r.name }); } } catch (e) {}
  return out.slice(0, 300);
}
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const DESC = "Apple Maps-style navigation for ER:LC (Liberty County): live players, turn-by-turn directions, calls, 3D buildings, and the nearest hospital, police and fire station.";
function origin(req) {
  const env = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  if (env) return env;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return proto + "://" + (req.headers["x-forwarded-host"] || req.headers.host || "localhost");
}
// Link-preview tags are filled in on the server because chat apps read them without running any scripts.
function page(file, res, req, title, desc) {
  fs.readFile(path.join(PUB, file), "utf8", (err, html) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    const o = origin(req), url = o + req.url.split("?")[0];
    html = html.replace(/__OG_TITLE__/g, esc(title || "ERLC Navigator")).replace(/__OG_DESC__/g, esc(desc || DESC))
      .replace(/__OG_URL__/g, esc(url)).replace(/__OG_IMAGE__/g, esc(o + "/og-image.png"));
    res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" }); res.end(html);
  });
}
function serveStatic(pathname, res) {
  let p = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  if (p === path.sep || p === "/" || p === ".") p = "index.html";
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB)) return send(res, 403, "Forbidden", "text/plain");
  fs.readFile(f, (err, data) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": f.endsWith(".html") ? "no-cache" : "public, max-age=3600" });
    res.end(data);
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x"), p = url.pathname.replace(/\/+$/, "") || "/", m = req.method;
    // multi-server API
    if (p === "/api/servers/config" && m === "GET") return send(res, 200, { signup: process.env.ALLOW_SIGNUP !== "0", invite: !!process.env.INVITE_CODE });
    if (p === "/api/servers" && m === "GET") return send(res, 200, listServers());
    if (p === "/api/servers" && m === "POST") return createServer(req, res);
    let slug = null, act = null, mm;
    if ((mm = p.match(/^\/api\/s\/([a-z0-9-]+)\/(info|map|players|auth|key)$/))) { slug = mm[1]; act = mm[2]; }
    else if ((mm = p.match(/^\/api\/(map|players|auth|key)$/))) { slug = "main"; act = mm[1]; }   // legacy single-server paths
    if (slug) {
      const t = tenant(slug); if (!t) return send(res, 404, { message: "No such server" });
      if (act === "info" && m === "GET") return send(res, 200, { slug, name: t.rec.name, hasKey: !!keyOf(t) });
      if (act === "map" && m === "GET") return send(res, 200, mapOf(t));
      if (act === "map" && m === "POST") return saveMap(req, res, t);
      if (act === "players" && m === "GET") return players(req, res, t);
      if (act === "key" && m === "POST") return setKey(req, res, t);
      if (act === "auth" && m === "POST") { if (!(await guard(req, res, t))) return; return send(res, 200, { ok: true }); }
      return send(res, 405, { message: "Method not allowed" });
    }
    // pages
    if (p === "/healthz" && (m === "GET" || m === "HEAD")) return send(res, 200, "ok", "text/plain");
    if (m === "GET") {
      if (p === "/servers") return page("servers.html", res, req, "Servers \u00b7 ERLC Navigator", "Create your own ERLC Navigator for your ER:LC server: your own link, places, closed roads and buildings.");
      if ((mm = p.match(/^\/s\/([a-z0-9-]+)(\/admin)?$/))) { const t = tenant(mm[1]); return t ? page("index.html", res, req, t.main ? "ERLC Navigator" : t.rec.name + " \u00b7 ERLC Navigator", t.main ? DESC : "Live navigation map for the " + t.rec.name + " ER:LC server: players, calls, turn-by-turn directions and places.") : send(res, 404, "No such server. Create one at /servers", "text/plain"); }
      if (p === "/admin") return page("index.html", res, req, "Admin \u00b7 ERLC Navigator", DESC);
      if (p === "/") return page("index.html", res, req, "ERLC Navigator", DESC);
      return serveStatic(p, res);
    }
    send(res, 405, { message: "Method not allowed" });
  } catch (e) { send(res, 500, { message: "Server error" }); }
});
module.exports = server;
// Keep-alive: Render's free plan sleeps after ~15 minutes without visits. While the app is running it pings
// its own public address so it stays awake. (Render sets RENDER_EXTERNAL_URL automatically.)
function keepAlive() {
  const base = (process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  if (!base || DESKTOP || process.env.KEEPALIVE === "0") return;
  const mins = Math.min(14, Math.max(0.01, parseFloat(process.env.KEEPALIVE_MINUTES) || 10));
  const ping = async () => {
    try { const r = await fetch(base + "/healthz", { signal: AbortSignal.timeout(20000) }); console.log("keep-alive ping", r.status); }
    catch (e) { console.log("keep-alive ping failed:", e.message); }
  };
  setInterval(ping, mins * 60000).unref();
  console.log("keep-alive on: pinging " + base + "/healthz every " + mins + " min");
}
if (require.main === module) server.listen(PORT, () => { console.log("ERLC Navigator on port " + PORT); keepAlive(); });
