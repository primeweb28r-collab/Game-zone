// GameZone backend: Express + Turso (cloud SQLite) + Pesapal payments.
//
// Flow: buyer signs in -> clicks Buy -> pays on Pesapal -> Pesapal pings /api/pesapal/ipn
// -> we ask Pesapal if it really succeeded -> buyer gets the game in their library
// -> Download returns the file link only to people who bought it.
// This server also serves the website (index.html). Setup steps: README.md

require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@libsql/client");

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const JWT_SECRET = process.env.JWT_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const PESAPAL_BASE = (process.env.PESAPAL_BASE_URL || "https://cybqa.pesapal.com/pesapalv3/api").replace(/\/$/, "");

for (const k of ["JWT_SECRET", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "PUBLIC_URL", "PESAPAL_CONSUMER_KEY", "PESAPAL_CONSUMER_SECRET"]) {
  if (!process.env[k]) { console.error(`FATAL: ${k} is not set. See README.md.`); process.exit(1); }
}
if (JWT_SECRET.length < 32) { console.error("FATAL: JWT_SECRET must be at least 32 characters."); process.exit(1); }

// ---------- Database ----------
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const query = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const run = (sql, args = []) => db.execute({ sql, args });
const uid = () => crypto.randomUUID();

// Money is stored as whole numbers in cents (USD or TZS). Never decimals.
async function setupTables() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'PC', developer TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
      sale_pct INTEGER NOT NULL DEFAULT 0, score REAL NOT NULL DEFAULT 0, age TEXT NOT NULL DEFAULT 'T',
      cover_url TEXT NOT NULL DEFAULT '', screenshots TEXT NOT NULL DEFAULT '[]', videos TEXT NOT NULL DEFAULT '[]',
      official_url TEXT NOT NULL DEFAULT '', download_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', rights_confirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, merchant_reference TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
      game_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      tracking_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS entitlements (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, game_id TEXT NOT NULL, order_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, game_id))`,
    `CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, game_id TEXT NOT NULL, ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ], "write");
  console.log("Connected to Turso database and verified tables.");
}

async function seedAdmin() {
  if (!ADMIN_EMAIL || ADMIN_PASSWORD.length < 8) {
    console.warn("ADMIN_EMAIL / ADMIN_PASSWORD not set (8+ chars): no admin account created.");
    return;
  }
  const rows = await query("SELECT id FROM users WHERE email=?", [ADMIN_EMAIL]);
  if (rows[0]) { await run("UPDATE users SET role='admin' WHERE id=?", [rows[0].id]); return; }
  await run("INSERT INTO users(id,email,password_hash,role) VALUES(?,?,?,'admin')", [uid(), ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, 12)]);
  console.log("Seeded admin account:", ADMIN_EMAIL);
}

// ---------- Helpers ----------
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); // catches async errors
const isHttps = (u) => typeof u === "string" && /^https:\/\/[^\s"'<>]+$/i.test(u);
// Download destinations may be HTTPS/HTTP cloud URLs or validated BitTorrent magnet URIs.
// Magnet links are only returned after the existing entitlement check succeeds.
const isDownloadLink = (u) => {
  if (isHttps(u) || (typeof u === "string" && /^http:\/\/[^\s"'<>]+$/i.test(u))) return true;
  if (typeof u !== "string" || !/^magnet:\?/i.test(u) || u.length > 8192) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "magnet:" && /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(parsed.searchParams.get("xt") || "");
  } catch { return false; }
};
const parseList = (s) => { try { return JSON.parse(s); } catch (e) { return []; } };
const finalCents = (g) => Math.round((Number(g.price_cents) * (100 - Number(g.sale_pct))) / 100);
const sign = (u) => jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: "7d" });

// Role is always read from the database, never trusted from the token.
const requireAuth = ah(async (req, res, next) => {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in required" });
  try {
    const p = jwt.verify(h.slice(7), JWT_SECRET);
    const rows = await query("SELECT id,email,role FROM users WHERE id=?", [p.sub]);
    if (!rows[0]) throw new Error("no user");
    req.user = rows[0];
    next();
  } catch (e) { res.status(401).json({ error: "Session expired. Please sign in again." }); }
});
const requireAdmin = (req, res, next) => (req.user && req.user.role === "admin" ? next() : res.status(403).json({ error: "Admins only" }));

// What the public sees: never includes the download link.
const publicGame = (g) => ({
  id: g.id, slug: g.slug, title: g.title, category: g.category, platform: g.platform, developer: g.developer,
  description: g.description, currency: g.currency, priceCents: g.price_cents, salePct: g.sale_pct, finalCents: finalCents(g),
  score: g.score, age: g.age, coverUrl: g.cover_url, screenshots: parseList(g.screenshots), videos: parseList(g.videos), officialUrl: g.official_url,
});
const adminGame = (g) => ({ ...publicGame(g), status: g.status, rightsConfirmed: !!g.rights_confirmed, downloadUrl: g.download_url });

// ---------- Pesapal ----------
let pesaToken = { value: null, exp: 0 };
async function pesaCall(p, { method = "GET", body, auth = true } = {}) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (auth) headers.Authorization = "Bearer " + (await pesaGetToken());
  const r = await fetch(PESAPAL_BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(`Pesapal ${p} failed (${r.status}): ${JSON.stringify(data.error || data).slice(0, 300)}`);
  return data;
}
async function pesaGetToken() {
  if (pesaToken.value && Date.now() < pesaToken.exp - 30000) return pesaToken.value;
  const d = await pesaCall("/Auth/RequestToken", { method: "POST", auth: false,
    body: { consumer_key: process.env.PESAPAL_CONSUMER_KEY, consumer_secret: process.env.PESAPAL_CONSUMER_SECRET } });
  if (!d.token) throw new Error("Pesapal gave no token. Check your keys and PESAPAL_BASE_URL.");
  pesaToken = { value: d.token, exp: d.expiryDate ? new Date(d.expiryDate).getTime() : Date.now() + 4 * 60000 };
  return pesaToken.value;
}
async function getIpnId() { // registered with Pesapal once, then remembered
  const url = PUBLIC_URL + "/api/pesapal/ipn", key = "ipn:" + url;
  const rows = await query("SELECT value FROM settings WHERE key=?", [key]);
  if (rows[0]) return rows[0].value;
  const d = await pesaCall("/URLSetup/RegisterIPN", { method: "POST", body: { url, ipn_notification_type: "GET" } });
  await run("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", [key, d.ipn_id]);
  return d.ipn_id;
}

// The ONLY place an order becomes paid: we ask Pesapal directly and check amount + currency.
async function settleOrder(ref) {
  const o = (await query("SELECT * FROM orders WHERE merchant_reference=?", [ref]))[0];
  if (!o || o.status === "paid" || !o.tracking_id) return o || null;
  const s = await pesaCall("/Transactions/GetTransactionStatus?orderTrackingId=" + encodeURIComponent(o.tracking_id));
  if (s.status_code === 1) {
    const ok = Math.round(Number(s.amount) * 100) === Number(o.amount_cents) &&
      String(s.currency || "").toUpperCase() === o.currency &&
      (!s.merchant_reference || s.merchant_reference === o.merchant_reference);
    if (!ok) {
      await run("UPDATE orders SET status='review' WHERE id=?", [o.id]);
      console.error("Order amount mismatch, needs manual review:", o.merchant_reference);
      return { ...o, status: "review" };
    }
    await db.batch([
      { sql: "UPDATE orders SET status='paid', paid_at=datetime('now') WHERE id=?", args: [o.id] },
      { sql: "INSERT OR IGNORE INTO entitlements(id,user_id,game_id,order_id) VALUES(?,?,?,?)", args: [uid(), o.user_id, o.game_id, o.id] },
    ], "write");
    return { ...o, status: "paid" };
  }
  if (s.status_code === 2 || s.status_code === 3) {
    await run("UPDATE orders SET status='failed' WHERE id=?", [o.id]);
    return { ...o, status: "failed" };
  }
  return o;
}

// ---------- App ----------
const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy
app.use(express.json({ limit: "200kb" }));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()) : PUBLIC_URL, allowedHeaders: ["Content-Type", "Authorization"] }));
app.use((req, res, next) => { res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "strict-origin-when-cross-origin" }); next(); });
app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 15 * 60000, limit: 30, standardHeaders: true, legacyHeaders: false });

app.get("/health", (req, res) => res.json({ ok: true }));

// ----- Accounts -----
const emailOk = (e) => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
app.post("/api/auth/register", authLimiter, ah(async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase(), pw = String((req.body || {}).password || "");
  if (!emailOk(email)) return res.status(400).json({ error: "Enter a valid email" });
  if (pw.length < 8 || pw.length > 72) return res.status(400).json({ error: "Password must be 8 to 72 characters" });
  if ((await query("SELECT 1 FROM users WHERE email=?", [email]))[0]) return res.status(409).json({ error: "That email is already registered" });
  const id = uid();
  await run("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)", [id, email, await bcrypt.hash(pw, 12)]);
  res.status(201).json({ token: sign({ id }), user: { email, role: "user" } });
}));
app.post("/api/auth/login", authLimiter, ah(async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase(), pw = String((req.body || {}).password || "");
  const u = (await query("SELECT * FROM users WHERE email=?", [email]))[0];
  if (!u || !(await bcrypt.compare(pw, u.password_hash))) return res.status(401).json({ error: "Wrong email or password" });
  res.json({ token: sign(u), user: { email: u.email, role: u.role } });
}));
app.get("/api/me", requireAuth, (req, res) => res.json({ user: { email: req.user.email, role: req.user.role } }));

// ----- Games (public) -----
app.get("/api/games", ah(async (req, res) => {
  const q = "%" + String(req.query.q || "").toLowerCase() + "%", cat = String(req.query.category || "");
  const rows = await query(`SELECT * FROM games WHERE status='published' AND lower(title||' '||category) LIKE ? ${cat ? "AND category=?" : ""} ORDER BY score DESC, title`, cat ? [q, cat] : [q]);
  res.json({ games: rows.map(publicGame) });
}));
app.get("/api/games/:slug", ah(async (req, res) => {
  const g = (await query("SELECT * FROM games WHERE slug=? AND status='published'", [req.params.slug]))[0];
  g ? res.json({ game: publicGame(g) }) : res.status(404).json({ error: "Game not found" });
}));

// ----- Games (admin) -----
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function buildGame(b, old = {}) {
  const g = {
    slug: b.slug ?? old.slug, title: b.title ?? old.title, category: b.category ?? old.category ?? "",
    platform: b.platform ?? old.platform ?? "PC", developer: b.developer ?? old.developer ?? "",
    description: b.description ?? old.description ?? "", price_cents: b.priceCents ?? old.price_cents ?? 0,
    currency: String(b.currency ?? old.currency ?? "USD").toUpperCase(), sale_pct: b.salePct ?? old.sale_pct ?? 0,
    score: b.score ?? old.score ?? 0, age: b.age ?? old.age ?? "T", cover_url: b.coverUrl ?? old.cover_url ?? "",
    screenshots: b.screenshots ?? parseList(old.screenshots), videos: b.videos ?? parseList(old.videos),
    official_url: b.officialUrl ?? old.official_url ?? "", download_url: b.downloadUrl ?? old.download_url ?? "",
    status: b.status ?? old.status ?? "draft", rights: b.rightsConfirmed ?? !!old.rights_confirmed,
  };
  const e = [];
  if (!g.title || typeof g.title !== "string" || g.title.length > 200) e.push("Title is required (max 200 characters)");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(g.slug || "")) e.push("Slug must be lowercase letters, numbers and hyphens");
  if (!int(g.price_cents, 0, 100000000)) e.push("priceCents must be a whole number (0 or more)");
  if (!int(g.sale_pct, 0, 100)) e.push("salePct must be a whole number from 0 to 100");
  if (!["USD", "TZS"].includes(g.currency)) e.push("Currency must be USD or TZS");
  if (!(g.score >= 0 && g.score <= 10)) e.push("Score must be between 0 and 10");
  if (!["E", "T", "M"].includes(g.age)) e.push("Age must be E, T or M");
  if (!["draft", "published", "retired"].includes(g.status)) e.push("Invalid status");
  if (g.cover_url && !isHttps(g.cover_url)) e.push("Cover URL must start with https://");
  if (g.official_url && !isHttps(g.official_url)) e.push("Official website must start with https://");
  if (g.download_url && !isDownloadLink(g.download_url)) e.push("Download URL must be a valid http(s) URL or magnet URI with a valid BitTorrent info hash");
  if (!Array.isArray(g.screenshots) || !g.screenshots.every(isHttps)) e.push("Screenshots must be https links");
  if (!Array.isArray(g.videos) || !g.videos.every(isHttps)) e.push("Videos must be https links");
  if (g.status === "published") {
    if (!g.cover_url) e.push("A cover image is required to publish");
    if (!g.description) e.push("A description is required to publish");
    if (!g.download_url) e.push("A download link is required to publish");
    if (!g.rights) e.push("Confirm you own the rights or have permission to sell this game");
  }
  return { g, e };
}
const gameValues = (g) => [g.slug, g.title, g.category, g.platform, g.developer, g.description, g.price_cents, g.currency, g.sale_pct,
  g.score, g.age, g.cover_url, JSON.stringify(g.screenshots), JSON.stringify(g.videos), g.official_url, g.download_url, g.status, g.rights ? 1 : 0];

app.get("/api/admin/games", requireAuth, requireAdmin, ah(async (req, res) => {
  res.json({ games: (await query("SELECT * FROM games ORDER BY created_at DESC")).map(adminGame) });
}));
app.post("/api/admin/games", requireAuth, requireAdmin, ah(async (req, res) => {
  const { g, e } = buildGame(req.body || {});
  if (e.length) return res.status(400).json({ errors: e });
  const id = uid();
  try {
    await run(`INSERT INTO games(slug,title,category,platform,developer,description,price_cents,currency,sale_pct,score,age,cover_url,screenshots,videos,official_url,download_url,status,rights_confirmed,id) VALUES(${"?,".repeat(18)}?)`, [...gameValues(g), id]);
  } catch (err) { return res.status(409).json({ errors: ["That slug is already used"] }); }
  res.status(201).json({ id });
}));
app.put("/api/admin/games/:id", requireAuth, requireAdmin, ah(async (req, res) => {
  const old = (await query("SELECT * FROM games WHERE id=?", [req.params.id]))[0];
  if (!old) return res.status(404).json({ error: "Game not found" });
  const body = req.body || {};
  if (old.status === "published" && body.slug && body.slug !== old.slug) return res.status(400).json({ errors: ["The slug is locked after publishing"] });
  const { g, e } = buildGame(body, old);
  if (e.length) return res.status(400).json({ errors: e });
  try {
    await run(`UPDATE games SET slug=?,title=?,category=?,platform=?,developer=?,description=?,price_cents=?,currency=?,sale_pct=?,score=?,age=?,cover_url=?,screenshots=?,videos=?,official_url=?,download_url=?,status=?,rights_confirmed=?,updated_at=datetime('now') WHERE id=?`, [...gameValues(g), old.id]);
  } catch (err) { return res.status(409).json({ errors: ["That slug is already used"] }); }
  res.json({ ok: true });
}));
app.delete("/api/admin/games/:id", requireAuth, requireAdmin, ah(async (req, res) => {
  if ((await query("SELECT 1 FROM entitlements WHERE game_id=? LIMIT 1", [req.params.id]))[0]) return res.status(409).json({ error: "This game has buyers. Retire it instead of deleting." });
  await run("DELETE FROM games WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));
app.get("/api/admin/orders", requireAuth, requireAdmin, ah(async (req, res) => {
  res.json({ orders: await query(`SELECT o.merchant_reference,o.status,o.amount_cents,o.currency,o.created_at,o.paid_at,u.email,g.title
    FROM orders o JOIN users u ON u.id=o.user_id JOIN games g ON g.id=o.game_id ORDER BY o.created_at DESC LIMIT 200`) });
}));

// ----- Buying -----
// Price is read from the database here, never from the browser.
app.post("/api/orders", requireAuth, ah(async (req, res) => {
  const g = (await query("SELECT * FROM games WHERE id=? AND status='published'", [String((req.body || {}).gameId || "")]))[0];
  if (!g) return res.status(404).json({ error: "Game not found" });
  if ((await query("SELECT 1 FROM entitlements WHERE user_id=? AND game_id=?", [req.user.id, g.id]))[0]) return res.status(409).json({ error: "You already own this game" });
  const amount = finalCents(g), ref = "GZ-" + uid(), id = uid();
  if (amount === 0) { // free game: no payment needed
    await run("INSERT OR IGNORE INTO entitlements(id,user_id,game_id) VALUES(?,?,?)", [id, req.user.id, g.id]);
    return res.json({ free: true });
  }
  await run("INSERT INTO orders(id,merchant_reference,user_id,game_id,amount_cents,currency) VALUES(?,?,?,?,?,?)", [id, ref, req.user.id, g.id, amount, g.currency]);
  try {
    const d = await pesaCall("/Transactions/SubmitOrderRequest", { method: "POST", body: {
      id: ref, currency: g.currency, amount: amount / 100, description: ("GameZone: " + g.title).slice(0, 100),
      callback_url: `${PUBLIC_URL}/?order=${ref}#library`, notification_id: await getIpnId(),
      billing_address: { email_address: req.user.email, country_code: String((req.body || {}).country || "TZ").slice(0, 2).toUpperCase() },
    } });
    await run("UPDATE orders SET tracking_id=? WHERE id=?", [d.order_tracking_id, id]);
    res.json({ redirectUrl: d.redirect_url, reference: ref });
  } catch (err) {
    console.error(err);
    await run("UPDATE orders SET status='failed' WHERE id=?", [id]);
    res.status(502).json({ error: "Payment service is unavailable. Please try again." });
  }
}));

// Pesapal calls this when a payment changes. We don't trust the details it sends; we re-check with Pesapal.
app.get("/api/pesapal/ipn", ah(async (req, res) => {
  const ref = String(req.query.OrderMerchantReference || ""), trk = String(req.query.OrderTrackingId || "");
  try { if (ref) await settleOrder(ref); }
  catch (err) { console.error(err); return res.status(500).json({ status: 500 }); } // an error makes Pesapal retry
  res.json({ orderNotificationType: "IPNCHANGE", orderTrackingId: trk, orderMerchantReference: ref, status: 200 });
}));

// The page buyers return to after paying. Also asks Pesapal directly in case the ping is late.
app.get("/api/orders/:ref", requireAuth, ah(async (req, res) => {
  const o = (await query("SELECT user_id FROM orders WHERE merchant_reference=?", [req.params.ref]))[0];
  if (!o || o.user_id !== req.user.id) return res.status(404).json({ error: "Order not found" });
  try { await settleOrder(req.params.ref); } catch (err) { console.error(err); }
  res.json({ status: (await query("SELECT status FROM orders WHERE merchant_reference=?", [req.params.ref]))[0].status });
}));

// ----- Library and downloads -----
app.get("/api/library", requireAuth, ah(async (req, res) => {
  res.json({ games: await query("SELECT g.slug,g.title,g.cover_url,g.platform,e.created_at FROM entitlements e JOIN games g ON g.id=e.game_id WHERE e.user_id=? ORDER BY e.created_at DESC", [req.user.id]) });
}));
// Only buyers get the file link. The website then sends the browser to it.
app.get("/api/library/:slug/download", requireAuth, ah(async (req, res) => {
  const g = (await query("SELECT g.id,g.download_url FROM games g JOIN entitlements e ON e.game_id=g.id WHERE g.slug=? AND e.user_id=?", [req.params.slug, req.user.id]))[0];
  if (!g) return res.status(403).json({ error: "Buy this game to download it" });
  if (!g.download_url) return res.status(409).json({ error: "The file is not available yet. Please contact support." });
  await run("INSERT INTO downloads(id,user_id,game_id,ip) VALUES(?,?,?,?)", [uid(), req.user.id, g.id, req.ip]);
  res.json({ url: g.download_url });
}));

// ---------- Website ----------
// Only index.html is served (never the server files).
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Something went wrong" }); });

// ---------- Start ----------
setupTables().then(seedAdmin).then(() => {
  app.listen(PORT, () => console.log(`GameZone backend listening on port ${PORT}`));
}).catch((e) => { console.error("FATAL: could not start:", e.message); process.exit(1); });
