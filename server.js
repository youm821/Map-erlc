// ERLC Navigator server: landing site + app, Discord login, per-server (tenant) data, ER:LC API proxy.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SRV_DIR = path.join(DATA_DIR, "servers");
const DEFAULT_MAP = path.join(__dirname, "defaults", "map.json");
const API = "https://api.erlc.gg/v2/server?Players=true&EmergencyCalls=true&ModCalls=true";
const DESKTOP = process.env.DESKTOP === "1";
const DISCORD = (process.env.DISCORD_BASE || "https://discord.com").replace(/\/+$/, "");
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED = new Set(["admin", "api", "app", "s", "servers", "dashboard", "auth", "static", "public", "www", "healthz"]);
const TYPES = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const cache = new Map(), hits = new Map(), fails = new Map();
const SECRET = process.env.SERVER_SECRET ? crypto.scryptSync(process.env.SERVER_SECRET, "erlc-nav", 32) : null;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET && !DESKTOP) console.log("Note: SESSION_SECRET is not set, so Discord logins reset every time the server restarts.");
const MAIN_OWNERS = (process.env.OWNER_DISCORD_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const discordCfg = () => process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET ? { id: process.env.DISCORD_CLIENT_ID, secret: process.env.DISCORD_CLIENT_SECRET } : null;

function send(res, code, body, type = "application/json", extra = {}) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const redirect = (res, to, cookiesOut) => { const h = { Location: to, "Cache-Control": "no-store" }; if (cookiesOut) h["Set-Cookie"] = cookiesOut; res.writeHead(302, h); res.end(); };
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
// --- signed cookies / sessions
function sign(obj) { const p = Buffer.from(JSON.stringify(obj)).toString("base64url"); return p + "." + crypto.createHmac("sha256", SESSION_SECRET).update(p).digest("base64url"); }
function unsign(s) {
  if (!s) return null; const i = s.lastIndexOf("."); if (i < 1) return null;
  const p = s.slice(0, i), m = s.slice(i + 1);
  if (!same(m, crypto.createHmac("sha256", SESSION_SECRET).update(p).digest("base64url"))) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o.exp && o.exp < Date.now() ? null : o; } catch (e) { return null; }
}
function cookiesOf(req) {
  const o = {}; (req.headers.cookie || "").split(";").forEach(c => { const i = c.indexOf("="); if (i > 0) { try { o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch (e) {} } }); return o;
}
const sessionOf = req => unsign(cookiesOf(req).erlc_session);
const cookie = (name, val, maxAge, secure) => `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
const avatarUrl = u => u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
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
function allT() { try { return fs.readdirSync(SRV_DIR).filter(f => f.endsWith(".json")).map(f => loadT(f.slice(0, -5))).filter(Boolean); } catch (e) { return []; } }
function tenant(slug) {
  if (!SLUG_RE.test(slug) && slug !== "main") return null;
  let rec = loadT(slug);
  if (slug === "main") { rec = rec || {}; rec.name = rec.name || "Main server"; return { slug, rec, main: true }; }
  return rec ? { slug, rec, main: false } : null;
}
function roleOf(req, t) {                       // "owner" | "admin" | null, from the Discord login
  const u = sessionOf(req); if (!u) return null;
  if (t.main) return MAIN_OWNERS.includes(u.id) ? "owner" : null;
  if (t.rec.owner === u.id) return "owner";
  return (t.rec.admins || []).includes(u.id) ? "admin" : null;
}
function adminOk(req, t) {
  if (DESKTOP) return true;
  if (roleOf(req, t)) return true;
  const k = ipOf(req) + ":" + t.slug;
  if (blocked(k)) return null;                  // null = too many attempts
  const pw = String(req.headers["x-admin-password"] || "");
  let ok = false;
  if (t.rec.admin) ok = same(hashPw(pw, t.rec.admin.salt), t.rec.admin.hash);
  else if (t.main && process.env.ADMIN_PASSWORD) ok = same(pw, process.env.ADMIN_PASSWORD);
  if (!ok && pw) failed(k);
  return ok;
}
const keyOf = t => dec(t.rec.key) || (t.main ? process.env.ERLC_SERVER_KEY : null);
function mapOf(t) { if (t.rec.map) return t.rec.map; try { return JSON.parse(fs.readFileSync(DEFAULT_MAP, "utf8")); } catch (e) { return {}; } }
async function guard(req, res, t) {
  const a = adminOk(req, t);
  if (a === null) { send(res, 429, { message: "Too many wrong passwords. Try again in a few minutes." }); return false; }
  if (!a) { send(res, 401, { message: "Not allowed. Log in with Discord as an admin of this server, or use the admin password." }); return false; }
  return true;
}
const needOwner = (req, res, t) => {
  if (DESKTOP || roleOf(req, t) === "owner") return true;
  send(res, sessionOf(req) ? 403 : 401, { message: "Only the server owner can do that." }); return false;
};
// --- origin / pages
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
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB) || path.extname(f) === ".html") return send(res, 404, "Not found", "text/plain");
  fs.readFile(f, (err, data) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "public, max-age=3600" });
    res.end(data);
  });
}
// --- Discord login
const safeNext = n => (typeof n === "string" && /^\/[^/\\]/.test(n) ? n : "/dashboard");
function discordStart(req, res, url) {
  const cfg = discordCfg();
  if (!cfg) return send(res, 503, "Discord login isn't set up on this site yet.", "text/plain");
  const state = crypto.randomBytes(16).toString("hex"), next = safeNext(url.searchParams.get("next")), secure = origin(req).startsWith("https");
  const q = new URLSearchParams({ client_id: cfg.id, redirect_uri: origin(req) + "/auth/discord/callback", response_type: "code", scope: "identify", state, prompt: "none" });
  redirect(res, DISCORD + "/oauth2/authorize?" + q, [cookie("erlc_oauth", sign({ state, next, exp: Date.now() + 600000 }), 600, secure)]);
}
async function discordCallback(req, res, url) {
  const cfg = discordCfg(), secure = origin(req).startsWith("https"), clear = cookie("erlc_oauth", "", 0, secure);
  const o = unsign(cookiesOf(req).erlc_oauth), code = url.searchParams.get("code");
  if (!cfg || !o || !code || !same(o.state, url.searchParams.get("state") || "")) return redirect(res, "/?login=failed", [clear]);
  try {
    const tr = await fetch(DISCORD + "/api/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.id, client_secret: cfg.secret, grant_type: "authorization_code", code, redirect_uri: origin(req) + "/auth/discord/callback" }) });
    if (!tr.ok) return redirect(res, "/?login=failed", [clear]);
    const tok = await tr.json();
    const ur = await fetch(DISCORD + "/api/users/@me", { headers: { Authorization: "Bearer " + tok.access_token } });
    if (!ur.ok) return redirect(res, "/?login=failed", [clear]);
    const u = await ur.json();
    if (!u || !/^\d{5,25}$/.test(String(u.id))) return redirect(res, "/?login=failed", [clear]);
    const s = { id: String(u.id), name: String(u.global_name || u.username || "Discord user").slice(0, 40), avatar: u.avatar || null, exp: Date.now() + 30 * 86400000 };
    redirect(res, safeNext(o.next), [cookie("erlc_session", sign(s), 30 * 86400, secure), clear]);
  } catch (e) { redirect(res, "/?login=failed", [clear]); }
}
function me(req, res) {
  const u = sessionOf(req);
  send(res, 200, { user: u ? { id: u.id, name: u.name, avatar: avatarUrl(u) } : null, discord: !!discordCfg(), loginRequired: !!discordCfg() && !DESKTOP });
}
// --- tenant API
async function players(req, res, t) {
  const key = req.headers["x-server-key"] || keyOf(t);
  if (!key) return send(res, 400, { message: "No ER:LC server key for this server. An admin can add one on the Admin page or dashboard, or paste your own in Settings." });
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
async function setSettings(req, res, t) {
  if (!(await guard(req, res, t))) return;
  const d = await jsonBody(req); if (!d) return send(res, 400, { message: "Bad JSON" });
  if (d.name !== undefined) { const n = String(d.name).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40); if (n.length < 2) return send(res, 400, { message: "Name must be 2+ characters" }); t.rec.name = n; }
  if (d.listed !== undefined && !t.main) t.rec.listed = !!d.listed;
  saveT(t.slug, t.rec); send(res, 200, { ok: true, name: t.rec.name, listed: !!t.rec.listed });
}
async function setAdmins(req, res, t) {
  if (t.main) return send(res, 400, { message: "Main-server admins are set with OWNER_DISCORD_IDS." });
  if (!needOwner(req, res, t)) return;
  const d = await jsonBody(req); if (!d) return send(res, 400, { message: "Bad JSON" });
  const list = new Set(t.rec.admins || []);
  if (d.add !== undefined) { if (!/^\d{5,25}$/.test(String(d.add))) return send(res, 400, { message: "That doesn't look like a Discord user ID (a long number)." }); if (list.size >= 20) return send(res, 400, { message: "Up to 20 admins." }); list.add(String(d.add)); }
  if (d.remove !== undefined) list.delete(String(d.remove));
  t.rec.admins = [...list]; saveT(t.slug, t.rec); send(res, 200, { ok: true, admins: t.rec.admins });
}
function deleteServer(req, res, t) {
  if (t.main) return send(res, 400, { message: "The main server can't be deleted." });
  if (!needOwner(req, res, t)) return;
  try { fs.unlinkSync(fileOf(t.slug)); } catch (e) {} send(res, 200, { ok: true });
}
const slugify = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
async function createServer(req, res) {
  if (process.env.ALLOW_SIGNUP === "0") return send(res, 403, { message: "New servers are disabled here." });
  const user = sessionOf(req);
  if (discordCfg() && !user && !DESKTOP) return send(res, 401, { message: "Log in with Discord first." });
  if (limited("create:" + ipOf(req), 8, 3600000)) return send(res, 429, { message: "Too many new servers from this address. Try later." });
  const d = await jsonBody(req); if (!d) return send(res, 400, { message: "Bad JSON" });
  if (process.env.INVITE_CODE && !same(String(d.inviteCode || ""), process.env.INVITE_CODE)) return send(res, 403, { message: "Wrong invite code" });
  const name = String(d.name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);
  if (name.length < 2) return send(res, 400, { message: "Give your server a name (2+ characters)" });
  const slug = slugify(d.slug || name);
  if (!SLUG_RE.test(slug) || RESERVED.has(slug) || slug === "main") return send(res, 400, { message: "Pick a different web address (3-32 letters, numbers, dashes)" });
  if (loadT(slug)) return send(res, 409, { message: "That address is taken" });
  if (user && allT().filter(r => r.owner === user.id).length >= 5) return send(res, 400, { message: "You can own up to 5 servers." });
  const pw = String(d.adminPassword || "");
  if (!user && pw.length < 6) return send(res, 400, { message: "Admin password must be at least 6 characters" });
  if (user && pw && pw.length < 6) return send(res, 400, { message: "Admin password must be at least 6 characters (or leave it empty)" });
  const rec = { name, slug, key: enc(String(d.erlcKey || "").trim()), listed: !!d.listed, created: Date.now(), map: null, owner: user ? user.id : null, admins: [] };
  if (pw) { const salt = crypto.randomBytes(16).toString("hex"); rec.admin = { salt, hash: hashPw(pw, salt) }; }
  saveT(slug, rec);
  send(res, 200, { ok: true, slug, app: "/s/" + slug, admin: "/s/" + slug + "/admin" });
}
function listServers() {
  const out = [{ slug: "main", name: (loadT("main") || {}).name || "Main server" }];
  for (const r of allT()) if (r.listed && r.slug !== "main") out.push({ slug: r.slug, name: r.name });
  return out.slice(0, 300);
}
function myServers(req, res) {
  const u = sessionOf(req); if (!u) return send(res, 401, { message: "Not logged in" });
  const out = [];
  if (MAIN_OWNERS.includes(u.id)) { const t = tenant("main"); out.push({ slug: "main", name: t.rec.name, role: "owner", listed: true, hasKey: !!keyOf(t), admins: [], main: true }); }
  for (const r of allT()) {
    if (r.slug === "main") continue;
    const role = r.owner === u.id ? "owner" : (r.admins || []).includes(u.id) ? "admin" : null;
    if (role) out.push({ slug: r.slug, name: r.name, role, listed: !!r.listed, hasKey: !!r.key, admins: role === "owner" ? (r.admins || []) : [] });
  }
  send(res, 200, out);
}
// --- server
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x"), p = url.pathname.replace(/\/+$/, "") || "/", m = req.method;
    if (p === "/healthz" && (m === "GET" || m === "HEAD")) return send(res, 200, "ok", "text/plain");
    if (p === "/auth/discord" && m === "GET") return discordStart(req, res, url);
    if (p === "/auth/discord/callback" && m === "GET") return discordCallback(req, res, url);
    if (p === "/auth/logout") return redirect(res, "/", [cookie("erlc_session", "", 0, origin(req).startsWith("https"))]);
    if (p === "/api/me" && m === "GET") return me(req, res);
    if (p === "/api/my/servers" && m === "GET") return myServers(req, res);
    if (p === "/api/servers/config" && m === "GET") return send(res, 200, { signup: process.env.ALLOW_SIGNUP !== "0", invite: !!process.env.INVITE_CODE, discord: !!discordCfg(), loginRequired: !!discordCfg() && !DESKTOP });
    if (p === "/api/servers" && m === "GET") return send(res, 200, listServers());
    if (p === "/api/servers" && m === "POST") return createServer(req, res);
    let slug = null, act = null, mm;
    if ((mm = p.match(/^\/api\/s\/([a-z0-9-]+)\/(info|map|players|auth|key|settings|admins)$/))) { slug = mm[1]; act = mm[2]; }
    else if ((mm = p.match(/^\/api\/s\/([a-z0-9-]+)$/)) && m === "DELETE") { slug = mm[1]; act = "delete"; }
    else if ((mm = p.match(/^\/api\/(map|players|auth|key)$/))) { slug = "main"; act = mm[1]; }   // legacy single-server paths
    if (slug) {
      const t = tenant(slug); if (!t) return send(res, 404, { message: "No such server" });
      if (act === "info" && m === "GET") return send(res, 200, { slug, name: t.rec.name, hasKey: !!keyOf(t), role: roleOf(req, t) });
      if (act === "map" && m === "GET") return send(res, 200, mapOf(t));
      if (act === "map" && m === "POST") return saveMap(req, res, t);
      if (act === "players" && m === "GET") return players(req, res, t);
      if (act === "key" && m === "POST") return setKey(req, res, t);
      if (act === "settings" && m === "POST") return setSettings(req, res, t);
      if (act === "admins" && m === "POST") return setAdmins(req, res, t);
      if (act === "delete") return deleteServer(req, res, t);
      if (act === "auth" && m === "POST") { if (!(await guard(req, res, t))) return; return send(res, 200, { ok: true, role: roleOf(req, t) }); }
      return send(res, 405, { message: "Method not allowed" });
    }
    if (m === "GET" || m === "HEAD") {
      if (p === "/") return page("landing.html", res, req, "ERLC Navigator \u00b7 Maps for Liberty County", DESC);
      if (p === "/servers") return page("servers.html", res, req, "Servers \u00b7 ERLC Navigator", "Browse ER:LC communities that use ERLC Navigator, or set up your own.");
      if (p === "/dashboard") return page("dashboard.html", res, req, "Dashboard \u00b7 ERLC Navigator", "Create and manage your ERLC Navigator servers.");
      if (p === "/app") return page("app.html", res, req, "ERLC Navigator", DESC);
      if (p === "/app/admin") return page("app.html", res, req, "Admin \u00b7 ERLC Navigator", DESC);
      if (p === "/admin") return redirect(res, "/app/admin");
      if ((mm = p.match(/^\/s\/([a-z0-9-]+)(\/admin)?$/))) { const t = tenant(mm[1]); return t ? page("app.html", res, req, t.main ? "ERLC Navigator" : t.rec.name + " \u00b7 ERLC Navigator", t.main ? DESC : "Live navigation map for the " + t.rec.name + " ER:LC server: players, calls, turn-by-turn directions and places.") : send(res, 404, "No such server. Create one at /dashboard", "text/plain"); }
      return serveStatic(p, res);
    }
    send(res, 405, { message: "Method not allowed" });
  } catch (e) { send(res, 500, { message: "Server error" }); }
});
module.exports = server;
module.exports.helpers = { sign, unsign };
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
