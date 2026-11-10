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
    `CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, user_id TEXT NOT NULL, rating INTEGER NOT NULL,
      body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, game_id))`,
    `CREATE TABLE IF NOT EXISTS support_tickets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ], "write");
  // Older databases: add the PC requirements columns once (ignored if they already exist).
  for (const col of ["requirements_min", "requirements_rec"]) {
    try { await run(`ALTER TABLE games ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch (e) { /* already there */ }
  }
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
const isImg = (u) => typeof u === "string" && (/^https:\/\/[^\s"'<>]+$/i.test(u) || /^\/img\/[0-9a-f-]{36}$/i.test(u));
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
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const pwStamp = (hash) => sha256(hash).slice(0, 16); // changes whenever the password changes
const sign = (u) => jwt.sign({ sub: u.id, pv: pwStamp(u.password_hash) }, JWT_SECRET, { expiresIn: "7d" });

// Role is always read from the database, never trusted from the token.
const requireAuth = ah(async (req, res, next) => {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in required" });
  try {
    const p = jwt.verify(h.slice(7), JWT_SECRET);
    const rows = await query("SELECT id,email,role,password_hash FROM users WHERE id=?", [p.sub]);
    if (!rows[0] || p.pv !== pwStamp(rows[0].password_hash)) throw new Error("no user or password changed");
    req.user = { id: rows[0].id, email: rows[0].email, role: rows[0].role };
    next();
  } catch (e) { res.status(401).json({ error: "Session expired. Please sign in again." }); }
});
const requireAdmin = (req, res, next) => (req.user && req.user.role === "admin" ? next() : res.status(403).json({ error: "Admins only" }));

// What the public sees: never includes the download link.
const publicGame = (g) => ({
  id: g.id, slug: g.slug, title: g.title, category: g.category, platform: g.platform, developer: g.developer,
  description: g.description, currency: g.currency, priceCents: g.price_cents, salePct: g.sale_pct, finalCents: finalCents(g),
  score: g.score, age: g.age, coverUrl: g.cover_url, screenshots: parseList(g.screenshots), videos: parseList(g.videos), officialUrl: g.official_url,
  requirementsMin: g.requirements_min || "", requirementsRecommended: g.requirements_rec || "",
});
const adminGame = (g) => ({ ...publicGame(g), status: g.status, rightsConfirmed: !!g.rights_confirmed, downloadUrl: g.download_url });

// ---------- Pesapal ----------
let pesaToken = { value: null, exp: 0 };
async function pesaCall(p, { method = "GET", body, auth = true } = {}) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (auth) headers.Authorization = "Bearer " + (await pesaGetToken());
  const r = await fetch(PESAPAL_BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  // Pesapal sends "error": {error_type:null, code:null, message:null} even on SUCCESS, so only a filled-in error counts.
  const e = data.error, realError = e && (typeof e !== "object" || e.error_type || e.code || e.message);
  if (!r.ok || realError) throw new Error(`Pesapal ${p} failed (${r.status}): ${JSON.stringify(data.error || data).slice(0, 300)}`);
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
  const url = PUBLIC_URL + "/api/pesapal/ipn", key = "ipn:" + PESAPAL_BASE + ":" + url;
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
  if (s.status_code !== 1) {
    console.log("Pesapal status for", o.merchant_reference, "| code:", s.status_code, "| description:", s.payment_status_description,
      "| method:", s.payment_method, "| amount:", s.amount, s.currency, "| message:", s.description);
  }
  if (s.status_code === 1) {
    const ok = Math.round(Number(s.amount) * 100) === Number(o.amount_cents) &&
      String(s.currency || "").toUpperCase() === o.currency &&
      (!s.merchant_reference || s.merchant_reference === o.merchant_reference);
    if (!ok) {
      await run("UPDATE orders SET status='review' WHERE id=?", [o.id]);
      console.error("Order amount mismatch, needs manual review:", o.merchant_reference,
        "| expected", o.amount_cents, o.currency, "| Pesapal says", s.amount, s.currency, s.merchant_reference);
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
const jsonSmall = express.json({ limit: "200kb" });
app.use((req, res, next) => (req.path === "/api/admin/images" ? next() : jsonSmall(req, res, next)));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()) : PUBLIC_URL, allowedHeaders: ["Content-Type", "Authorization"] }));
app.use((req, res, next) => { res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "strict-origin-when-cross-origin" }); next(); });
app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 15 * 60000, limit: 30, standardHeaders: true, legacyHeaders: false });

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- Image uploads (admin picks files from their device; stored in Turso) ----------
const IMG_TYPES = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/webp": (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
  "image/gif": (b) => b.toString("ascii", 0, 3) === "GIF",
};
app.post("/api/admin/images", express.json({ limit: "7mb" }), requireAuth, requireAdmin, ah(async (req, res) => {
  const { mime, data } = req.body || {};
  if (!IMG_TYPES[mime] || typeof data !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(data)) return res.status(400).json({ error: "Unsupported image" });
  const buf = Buffer.from(data, "base64");
  if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: "Image is too large (max 5 MB)" });
  if (!IMG_TYPES[mime](buf)) return res.status(400).json({ error: "File is not a valid image" });
  const id = uid();
  await run("INSERT INTO images(id,mime,data) VALUES(?,?,?)", [id, mime, data]);
  res.json({ url: "/img/" + id });
}));
app.get("/img/:id", ah(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).end();
  const r = (await query("SELECT mime,data FROM images WHERE id=?", [req.params.id]))[0];
  if (!r) return res.status(404).end();
  res.set({ "Content-Type": r.mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  res.send(Buffer.from(r.data, "base64"));
}));


// ----- Accounts -----
const emailOk = (e) => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
app.post("/api/auth/register", authLimiter, ah(async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase(), pw = String((req.body || {}).password || "");
  if (!emailOk(email)) return res.status(400).json({ error: "Enter a valid email" });
  if (pw.length < 8 || pw.length > 72) return res.status(400).json({ error: "Password must be 8 to 72 characters" });
  if ((await query("SELECT 1 FROM users WHERE email=?", [email]))[0]) return res.status(409).json({ error: "That email is already registered" });
  const id = uid(), hash = await bcrypt.hash(pw, 12);
  await run("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)", [id, email, hash]);
  res.status(201).json({ token: sign({ id, password_hash: hash }), user: { email, role: "user" } });
}));
app.post("/api/auth/login", authLimiter, ah(async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase(), pw = String((req.body || {}).password || "");
  const u = (await query("SELECT * FROM users WHERE email=?", [email]))[0];
  if (!u || !(await bcrypt.compare(pw, u.password_hash))) return res.status(401).json({ error: "Wrong email or password" });
  res.json({ token: sign(u), user: { email: u.email, role: u.role } });
}));
// ----- Password reset -----
// The proof that it is really the owner: the reset link is sent ONLY to the email address on the account.
// The link holds a random one-time token (stored hashed), valid 30 minutes, usable once.
async function sendMail(to, subject, text) {
  if (!process.env.BREVO_API_KEY || !process.env.MAIL_FROM) { console.error("Email is not set up: add BREVO_API_KEY and MAIL_FROM in Render."); return false; }
  try {
    const html = "<div style=\"font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111\">" + String(text).split("\n").map((l) => l.replace(/(https?:\/\/\S+)/g, "<a href=\"$1\">$1</a>")).join("<br>") + "</div>";
    const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender: { name: "GameZone", email: process.env.MAIL_FROM }, to: [{ email: to }], subject, textContent: text, htmlContent: html }) });
    if (!r.ok) { console.error("Email failed:", r.status, (await r.text()).slice(0, 300)); return false; }
    return true;
  } catch (err) { console.error("Email error:", err.message); return false; }
}
const forgotLimiter = rateLimit({ windowMs: 15 * 60000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests. Please try again in a few minutes." } });
const RESET_NOTE = "If that email has a GameZone account, we have sent a reset link. It works for 30 minutes.";
app.post("/api/auth/forgot", forgotLimiter, ah(async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!emailOk(email)) return res.status(400).json({ error: "Enter a valid email" });
  const u = (await query("SELECT id,email FROM users WHERE email=?", [email]))[0];
  // Same answer whether or not the account exists, so nobody can use this form to find out who has an account.
  if (u) {
    await run("DELETE FROM password_resets WHERE expires_at < ?", [Date.now()]);
    const recent = (await query("SELECT 1 FROM password_resets WHERE user_id=? AND created_at > datetime('now','-1 minute')", [u.id]))[0];
    if (!recent) {
      const token = crypto.randomBytes(32).toString("hex");
      await db.batch([
        { sql: "DELETE FROM password_resets WHERE user_id=?", args: [u.id] },
        { sql: "INSERT INTO password_resets(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)", args: [uid(), u.id, sha256(token), Date.now() + 30 * 60000] },
      ], "write");
      sendMail(u.email, "Reset your GameZone password",
        "Someone asked to reset the password for your GameZone account.\n\nTo choose a new password, open this link (valid for 30 minutes, works once):\n" +
        PUBLIC_URL + "/?reset=" + token + "\n\nIf this was not you, ignore this email. Your password stays the same.").catch(() => {});
    }
  }
  res.json({ ok: true, message: RESET_NOTE });
}));
app.post("/api/auth/reset", authLimiter, ah(async (req, res) => {
  const token = String((req.body || {}).token || ""), pw = String((req.body || {}).password || "");
  const bad = () => res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
  if (pw.length < 8 || pw.length > 72) return res.status(400).json({ error: "Password must be 8 to 72 characters" });
  if (!/^[a-f0-9]{64}$/.test(token)) return bad();
  const row = (await query("SELECT * FROM password_resets WHERE token_hash=?", [sha256(token)]))[0];
  if (!row || row.used || Number(row.expires_at) < Date.now()) return bad();
  const hash = await bcrypt.hash(pw, 12);
  const claimed = await run("UPDATE password_resets SET used=1 WHERE id=? AND used=0", [row.id]); // single use, even if two requests race
  if (!claimed.rowsAffected) return bad();
  await run("UPDATE users SET password_hash=? WHERE id=?", [hash, row.user_id]);
  await run("DELETE FROM password_resets WHERE user_id=?", [row.user_id]);
  const u = (await query("SELECT email FROM users WHERE id=?", [row.user_id]))[0];
  if (u) sendMail(u.email, "Your GameZone password was changed", "The password for your GameZone account was just changed, and you were signed out everywhere.\n\nIf this was you, no action is needed. If it was not you, reset your password again at " + PUBLIC_URL + " and contact support.").catch(() => {});
  res.json({ ok: true });
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
    req_min: b.requirementsMin ?? old.requirements_min ?? "", req_rec: b.requirementsRecommended ?? old.requirements_rec ?? "",
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
  if (typeof g.req_min !== "string" || typeof g.req_rec !== "string" || g.req_min.length > 2000 || g.req_rec.length > 2000) e.push("PC requirements must be text (max 2000 characters)");
  if (g.cover_url && !isImg(g.cover_url)) e.push("Cover image is not valid");
  if (g.official_url && !isHttps(g.official_url)) e.push("Official website must start with https://");
  if (g.download_url && !isDownloadLink(g.download_url)) e.push("Download URL must be a valid http(s) URL or magnet URI with a valid BitTorrent info hash");
  if (!Array.isArray(g.screenshots) || !g.screenshots.every(isImg)) e.push("A screenshot is not valid");
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
  g.score, g.age, g.cover_url, JSON.stringify(g.screenshots), JSON.stringify(g.videos), g.official_url, g.download_url, g.status, g.rights ? 1 : 0, g.req_min, g.req_rec];

app.get("/api/admin/games", requireAuth, requireAdmin, ah(async (req, res) => {
  res.json({ games: (await query("SELECT * FROM games ORDER BY created_at DESC")).map(adminGame) });
}));
app.post("/api/admin/games", requireAuth, requireAdmin, ah(async (req, res) => {
  const { g, e } = buildGame(req.body || {});
  if (e.length) return res.status(400).json({ errors: e });
  const id = uid();
  try {
    await run(`INSERT INTO games(slug,title,category,platform,developer,description,price_cents,currency,sale_pct,score,age,cover_url,screenshots,videos,official_url,download_url,status,rights_confirmed,requirements_min,requirements_rec,id) VALUES(${"?,".repeat(20)}?)`, [...gameValues(g), id]);
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
    await run(`UPDATE games SET slug=?,title=?,category=?,platform=?,developer=?,description=?,price_cents=?,currency=?,sale_pct=?,score=?,age=?,cover_url=?,screenshots=?,videos=?,official_url=?,download_url=?,status=?,rights_confirmed=?,requirements_min=?,requirements_rec=?,updated_at=datetime('now') WHERE id=?`, [...gameValues(g), old.id]);
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


// ----- Site settings (hero banner + contact button), stored as JSON in the settings table -----
const getSetting = async (key, fallback) => { const r = (await query("SELECT value FROM settings WHERE key=?", [key]))[0]; try { return r ? JSON.parse(r.value) : fallback; } catch (e) { return fallback; } };
const putSetting = (key, val) => run("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", [key, JSON.stringify(val)]);
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

// Hero banner: public sees active slides of published games; admin sees and edits all slides.
app.get("/api/hero", ah(async (req, res) => {
  const slides = (await getSetting("hero", [])).filter((x) => x.active !== false);
  const ids = slides.map((x) => x.gameId);
  const ok = new Set(ids.length ? (await query(`SELECT id FROM games WHERE status='published' AND id IN (${ids.map(() => "?").join(",")})`, ids)).map((r) => r.id) : []);
  res.json({ slides: slides.filter((x) => ok.has(x.gameId)) });
}));
app.get("/api/admin/hero", requireAuth, requireAdmin, ah(async (req, res) => res.json({ slides: await getSetting("hero", []) })));
app.put("/api/admin/hero", requireAuth, requireAdmin, ah(async (req, res) => {
  const list = (req.body || {}).slides;
  if (!Array.isArray(list) || list.length > 10) return res.status(400).json({ error: "Up to 10 slides" });
  const slides = [];
  for (const [i, x] of list.entries()) {
    const gameId = clip(x && x.gameId, 64), imageUrl = clip(x && x.imageUrl, 2000);
    if (!(await query("SELECT 1 FROM games WHERE id=?", [gameId]))[0]) return res.status(400).json({ error: `Slide ${i + 1}: choose a game` });
    if (imageUrl && !isImg(imageUrl)) return res.status(400).json({ error: `Slide ${i + 1}: image is not valid` });
    slides.push({ gameId, imageUrl, headline: clip(x.headline, 120), tagline: clip(x.tagline, 240), active: x.active !== false });
  }
  await putSetting("hero", slides);
  res.json({ ok: true });
}));

// Contact (WhatsApp) button in the top panel.
const CONTACT_DEFAULT = { enabled: true, label: "Contact", phone: "", message: "Hello, I would like to ask about your products" };
app.get("/api/contact", ah(async (req, res) => res.json({ contact: { ...CONTACT_DEFAULT, ...(await getSetting("contact", {})) } })));
app.put("/api/admin/contact", requireAuth, requireAdmin, ah(async (req, res) => {
  const b = req.body || {}, phone = clip(b.phone, 500);
  if (phone && !/^https:\/\/[^\s"'<>]+$/i.test(phone) && !/^\+?[0-9\s-]{6,20}$/.test(phone)) return res.status(400).json({ error: "Enter a WhatsApp number with country code, or an https link" });
  const contact = { enabled: b.enabled !== false, label: clip(b.label, 20) || "Contact", phone, message: clip(b.message, 300) };
  await putSetting("contact", contact);
  res.json({ ok: true, contact });
}));

// ----- Reviews (only buyers can review; an admin approves them before they show) -----
app.get("/api/games/:slug/reviews", ah(async (req, res) => {
  const rows = await query(`SELECT r.rating,r.body,r.created_at FROM reviews r JOIN games g ON g.id=r.game_id
    WHERE g.slug=? AND g.status='published' AND r.status='approved' ORDER BY r.created_at DESC LIMIT 100`, [req.params.slug]);
  res.json({ reviews: rows.map((r) => ({ rating: r.rating, body: r.body, createdAt: r.created_at })) });
}));
app.post("/api/games/:slug/reviews", requireAuth, ah(async (req, res) => {
  const g = (await query("SELECT id FROM games WHERE slug=? AND status='published'", [req.params.slug]))[0];
  if (!g) return res.status(404).json({ error: "Game not found" });
  if (!(await query("SELECT 1 FROM entitlements WHERE user_id=? AND game_id=?", [req.user.id, g.id]))[0]) return res.status(403).json({ error: "Only buyers can review a game" });
  const rating = Number((req.body || {}).rating), body = clip((req.body || {}).body, 2000);
  if (!int(rating, 1, 5)) return res.status(400).json({ error: "Rating must be 1 to 5" });
  if (body.length < 5) return res.status(400).json({ error: "Please write a few words" });
  await run("INSERT INTO reviews(id,game_id,user_id,rating,body) VALUES(?,?,?,?,?) ON CONFLICT(user_id,game_id) DO UPDATE SET rating=excluded.rating,body=excluded.body,status='pending'", [uid(), g.id, req.user.id, rating, body]);
  res.status(201).json({ ok: true });
}));
app.get("/api/admin/reviews", requireAuth, requireAdmin, ah(async (req, res) => {
  res.json({ reviews: await query(`SELECT r.id,r.rating,r.body,r.status,r.created_at,g.title,u.email FROM reviews r
    JOIN games g ON g.id=r.game_id JOIN users u ON u.id=r.user_id ORDER BY (r.status='pending') DESC, r.created_at DESC LIMIT 200`) });
}));
app.put("/api/admin/reviews/:id", requireAuth, requireAdmin, ah(async (req, res) => {
  const status = (req.body || {}).status;
  if (!["approved", "rejected", "pending"].includes(status)) return res.status(400).json({ error: "Invalid status" });
  await run("UPDATE reviews SET status=? WHERE id=?", [status, req.params.id]);
  res.json({ ok: true });
}));

// ----- Support requests -----
app.get("/api/support", requireAuth, ah(async (req, res) => {
  res.json({ tickets: await query("SELECT id,subject,message,status,created_at FROM support_tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 100", [req.user.id]) });
}));
app.post("/api/support", requireAuth, ah(async (req, res) => {
  const subject = clip((req.body || {}).subject, 120), message = clip((req.body || {}).message, 3000);
  if (subject.length < 4) return res.status(400).json({ error: "Subject must be at least 4 characters" });
  if (message.length < 20) return res.status(400).json({ error: "Message must be at least 20 characters" });
  if ((await query("SELECT COUNT(*) n FROM support_tickets WHERE user_id=? AND created_at > datetime('now','-1 day')", [req.user.id]))[0].n >= 10) return res.status(429).json({ error: "Too many requests today. Please try again tomorrow." });
  await run("INSERT INTO support_tickets(id,user_id,subject,message) VALUES(?,?,?,?)", [uid(), req.user.id, subject, message]);
  res.status(201).json({ ok: true });
}));
app.get("/api/admin/support", requireAuth, requireAdmin, ah(async (req, res) => {
  res.json({ tickets: await query("SELECT t.id,t.subject,t.message,t.status,t.created_at,u.email FROM support_tickets t JOIN users u ON u.id=t.user_id ORDER BY (t.status='resolved'), t.created_at DESC LIMIT 200") });
}));
app.put("/api/admin/support/:id", requireAuth, requireAdmin, ah(async (req, res) => {
  const status = (req.body || {}).status;
  if (!["open", "in_progress", "resolved"].includes(status)) return res.status(400).json({ error: "Invalid status" });
  await run("UPDATE support_tickets SET status=? WHERE id=?", [status, req.params.id]);
  res.json({ ok: true });
}));

// ----- Admin analytics -----
app.get("/api/admin/analytics", requireAuth, requireAdmin, ah(async (req, res) => {
  const n = async (sql) => Number((await query(sql))[0].n);
  res.json({
    users: await n("SELECT COUNT(*) n FROM users"),
    orders: await n("SELECT COUNT(*) n FROM orders WHERE status='paid'"),
    downloads: await n("SELECT COUNT(*) n FROM downloads"),
    pendingReviews: await n("SELECT COUNT(*) n FROM reviews WHERE status='pending'"),
    revenue: (await query("SELECT currency, SUM(amount_cents) cents, COUNT(*) n FROM orders WHERE status='paid' GROUP BY currency")).map((r) => ({ currency: r.currency, cents: Number(r.cents), n: Number(r.n) })),
    gamesTop: (await query("SELECT g.title, COUNT(*) sales FROM entitlements e JOIN games g ON g.id=e.game_id GROUP BY g.id ORDER BY sales DESC LIMIT 5")).map((r) => ({ title: r.title, sales: Number(r.sales) })),
  });
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
      callback_url: `${PUBLIC_URL}/?order=${ref}`, notification_id: await getIpnId(),
      billing_address: { email_address: req.user.email, country_code: String((req.body || {}).country || "TZ").slice(0, 2).toUpperCase() },
    } });
    await run("UPDATE orders SET tracking_id=? WHERE id=?", [d.order_tracking_id, id]);
    res.json({ redirectUrl: d.redirect_url, reference: ref });
  } catch (err) {
    console.error("PESAPAL ORDER ERROR:", err && err.message ? err.message : err);
    await run("UPDATE orders SET status='failed' WHERE id=?", [id]);
    // Buyers get a friendly message; the signed-in admin also sees the real reason so setup problems are easy to find.
    const why = req.user.role === "admin" && err && err.message ? " (Admin details: " + String(err.message).slice(0, 300) + ")" : "";
    res.status(502).json({ error: "Payment service is unavailable. Please try again." + why });
  }
}));

// Pesapal calls this when a payment changes. We don't trust the details it sends; we re-check with Pesapal.
app.get("/api/pesapal/ipn", ah(async (req, res) => {
  const ref = String(req.query.OrderMerchantReference || ""), trk = String(req.query.OrderTrackingId || "");
  try { if (ref) await settleOrder(ref); }
  catch (err) { console.error(err); return res.status(500).json({ status: 500 }); } // an error makes Pesapal retry
  res.json({ orderNotificationType: "IPNCHANGE", orderTrackingId: trk, orderMerchantReference: ref, status: 200 });
}));

// Buyer's own purchase history (declared before /api/orders/:ref so "mine" is not read as a reference).
app.get("/api/orders/mine", requireAuth, ah(async (req, res) => {
  res.json({ orders: await query(`SELECT o.merchant_reference,o.status,o.amount_cents,o.currency,o.created_at,g.title
    FROM orders o JOIN games g ON g.id=o.game_id WHERE o.user_id=? ORDER BY o.created_at DESC LIMIT 100`, [req.user.id]) });
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
// Only buyers get a download link, and that link stops working after DL_LINK_MINUTES.
// The buyer keeps the game in their library for good; pressing Download again creates a fresh link.
const DL_LINK_MINUTES = 15, DL_PER_DAY = 10;
app.get("/api/library/:slug/download", requireAuth, ah(async (req, res) => {
  const g = (await query("SELECT g.id,g.download_url FROM games g JOIN entitlements e ON e.game_id=g.id WHERE g.slug=? AND e.user_id=?", [req.params.slug, req.user.id]))[0];
  if (!g) return res.status(403).json({ error: "Buy this game to download it" });
  if (!g.download_url) return res.status(409).json({ error: "The file is not available yet. Please contact support." });
  const used = (await query("SELECT COUNT(*) AS c FROM downloads WHERE user_id=? AND created_at > datetime('now','-1 day')", [req.user.id]))[0];
  if (Number(used.c) >= DL_PER_DAY && req.user.role !== "admin") return res.status(429).json({ error: "Daily download limit reached (" + DL_PER_DAY + " per day). Please try again tomorrow or contact support." });
  await run("INSERT INTO downloads(id,user_id,game_id,ip) VALUES(?,?,?,?)", [uid(), req.user.id, g.id, req.ip]);
  if (!/^https?:\/\//i.test(g.download_url)) return res.json({ url: g.download_url }); // e.g. magnet links cannot be time-limited
  const t = jwt.sign({ t: "dl", sub: req.user.id, g: g.id }, JWT_SECRET, { expiresIn: DL_LINK_MINUTES * 60 });
  res.json({ url: "/api/dl/" + t, expiresInMinutes: DL_LINK_MINUTES });
}));
app.get("/api/dl/:token", ah(async (req, res) => {
  const page = (msg) => res.status(410).set("Cache-Control", "no-store").type("html").send("<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>GameZone</title><body style=\"font-family:Arial,sans-serif;background:#070908;color:#f3f5f1;padding:32px\"><h2>" + msg + "</h2><p><a style=\"color:#9df52b\" href=\"/#library\">Back to my library</a></p></body>");
  let p;
  try { p = jwt.verify(req.params.token, JWT_SECRET); if (p.t !== "dl") throw new Error("not a download token"); }
  catch (e) { return page("This download link has expired. Open your library and press Download again."); }
  // Ownership is checked again now, so a refunded or removed purchase stops working immediately.
  const g = (await query("SELECT g.download_url FROM games g JOIN entitlements e ON e.game_id=g.id WHERE g.id=? AND e.user_id=?", [p.g, p.sub]))[0];
  if (!g || !g.download_url) return page("This download is not available. Please contact support.");
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.redirect(302, g.download_url);
}));

// ---------- Website ----------
// Only index.html is served (never the server files).
// ---------- Installable app (PWA) ----------
// These must come before the catch-all below, which otherwise answers every path with index.html.
const PWA_ICONS = {
  "icon-192.png": Buffer.from("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", "base64"),
  "icon-512.png": Buffer.from("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", "base64"),
  "icon-maskable-512.png": Buffer.from("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", "base64"),
};
app.get("/manifest.webmanifest", (req, res) => {
  res.type("application/manifest+json").set("Cache-Control", "public, max-age=3600").send(JSON.stringify({
    name: "GameZone", short_name: "GameZone", description: "GameZone: PC game store",
    start_url: "/", scope: "/", display: "standalone", orientation: "any",
    background_color: "#070908", theme_color: "#070908",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }));
});
Object.keys(PWA_ICONS).forEach((name) => app.get("/" + name, (req, res) => res.type("image/png").set("Cache-Control", "public, max-age=86400").send(PWA_ICONS[name])));
// The service worker only keeps a copy of the page itself for offline use. It never touches /api, so payments and libraries are always live.
const SW_JS = `
const CACHE = "gamezone-shell-v1";
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  if (r.mode === "navigate") {
    e.respondWith(fetch(r).then((res) => { const c = res.clone(); caches.open(CACHE).then((x) => x.put("/", c)); return res; }).catch(() => caches.match("/")));
  }
});
`;
app.get("/sw.js", (req, res) => res.type("application/javascript").set({ "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" }).send(SW_JS));

app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Something went wrong" }); });

// ---------- Safety net for payments ----------
// Pesapal's notification (IPN) can be missed (server asleep, restart, network). The buyer may also close
// the browser before returning. So the server itself re-checks unpaid orders with Pesapal.
let reconciling = false;
async function reconcileOrders(mode) {
  if (reconciling) return;
  reconciling = true;
  try {
    const sql = {
      startup: "SELECT merchant_reference FROM orders WHERE status IN ('pending','failed','review') AND tracking_id IS NOT NULL ORDER BY created_at DESC LIMIT 200",
      recent: "SELECT merchant_reference FROM orders WHERE status='pending' AND tracking_id IS NOT NULL AND created_at > datetime('now','-3 hours') ORDER BY created_at DESC LIMIT 30",
      older: "SELECT merchant_reference FROM orders WHERE status='pending' AND tracking_id IS NOT NULL AND created_at > datetime('now','-7 days') ORDER BY created_at DESC LIMIT 50",
    }[mode];
    for (const r of await query(sql)) {
      try { await settleOrder(r.merchant_reference); }
      catch (e) { if (!/payment_details_not_found/.test(e.message)) console.error("Payment re-check failed for", r.merchant_reference, e.message); } // not-found = buyer never paid, just keep waiting
    }
  } catch (e) { console.error("Payment re-check error:", e.message); }
  finally { reconciling = false; }
}
function startReconciler() {
  setTimeout(() => reconcileOrders("startup"), 5000); // one full sweep right after every start
  let tick = 0;
  setInterval(() => reconcileOrders(++tick % 20 === 0 ? "older" : "recent"), 3 * 60000); // every 3 min; hourly for older orders
}

// ---------- Start ----------
setupTables().then(seedAdmin).then(() => {
  app.listen(PORT, () => console.log(`GameZone backend listening on port ${PORT}`));
  startReconciler();
}).catch((e) => { console.error("FATAL: could not start:", e.message); process.exit(1); });
