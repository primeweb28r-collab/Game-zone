# GameZone backend — accounts, Pesapal payments, protected downloads

Everything is in **one file** (`server.js`) plus `index.html` (your website).
The server runs on **Render**, the data lives in **Turso** (free, permanent),
and payments go through **Pesapal**.

**How a purchase works:**
1. Buyer signs in and clicks Buy.
2. They pay on Pesapal's page (M-Pesa, Airtel Money, Mixx by Yas, or card).
3. Pesapal tells your server. The server checks with Pesapal that the money
   really arrived, then adds the game to the buyer's library.
4. The buyer clicks Download and is sent to the file link. Only buyers can get it.

---

## Step 1: Create your free Turso database

1. Go to **turso.tech** → sign up (you can use GitHub)
2. Click **Create Database**, name it e.g. `gamezone-db`, choose a region → **Create**
3. On the database page, copy the **Database URL** (starts with `libsql://`)
4. Click **Create Token** and copy the token. You can't see it again.

## Step 2: Get your Pesapal sandbox keys

1. Go to the Pesapal developer site and create a **sandbox (demo)** account
2. Copy the **Consumer Key** and **Consumer Secret**
3. Use the sandbox first. No real money moves. Only switch to live after a
   full test purchase works.

## Step 3: Put the files on GitHub

Create a new GitHub repository and upload these files (drag and drop works):
`server.js`, `package.json`, `index.html`, `.gitignore`.
**Do not upload a `.env` file.**

## Step 4: Create the service on Render

1. Render → **New +** → **Web Service** → pick your GitHub repo
2. **Build Command:** `npm install`   **Start Command:** `npm start`
3. Under **Environment**, add these:

| Key | Value |
|---|---|
| `JWT_SECRET` | a long random string (32+ characters) |
| `TURSO_DATABASE_URL` | the `libsql://...` URL from Step 1 |
| `TURSO_AUTH_TOKEN` | the token from Step 1 |
| `ADMIN_EMAIL` | your email (this becomes the admin login) |
| `ADMIN_PASSWORD` | a strong password, 8+ characters |
| `PUBLIC_URL` | your Render address, e.g. `https://gamezone.onrender.com` (no slash at the end) |
| `PESAPAL_CONSUMER_KEY` | from Step 2 |
| `PESAPAL_CONSUMER_SECRET` | from Step 2 |
| `PESAPAL_BASE_URL` | `https://cybqa.pesapal.com/pesapalv3/api` (sandbox) |
| `NODE_ENV` | `production` |

4. Click **Create Web Service**. Watch the logs for:
```
Connected to Turso database and verified tables.
Seeded admin account: you@example.com
GameZone backend listening on port ...
```

## Step 5: Test

- Open `https://your-service.onrender.com/health` → you should see `{"ok":true}`
- Your website opens at your Render address

## Going live later

Switch `PESAPAL_BASE_URL` and your keys to the **live** ones from Pesapal's docs, and
test one small real purchase. Render's free plan sleeps when idle, so payment
confirmations can be slow. Upgrade the plan before you take real orders.

## Notes

- Prices are whole numbers in cents (USD or TZS). Example: $19.99 = `1999`.
- A game can't be published without a cover, description, download link and the rights checkbox.
- Download links are plain links, so a buyer could share one. Time-limited links (Cloudflare R2) are a later upgrade.
- **The website (`index.html`) is not connected to this API yet.** It still shows
  the demo data saved in the browser. Connecting it is the next step.

## API (for the next step)

Send the login token as `Authorization: Bearer <token>`.

- Public: `GET /api/games`, `GET /api/games/:slug`
- Accounts: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/me`
- Buying: `POST /api/orders` `{gameId}`, `GET /api/orders/:ref`, `GET /api/library`, `GET /api/library/:slug/download`
- Admin: `GET/POST /api/admin/games`, `PUT/DELETE /api/admin/games/:id`, `GET /api/admin/orders`
