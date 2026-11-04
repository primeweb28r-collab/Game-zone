# GameZone — responsive gaming storefront

GameZone is an Express website backed by Turso (libSQL) and Pesapal. The storefront is served from `index.html`; the API and payment verification live in `server.js`.

## Storefront features

- Cinematic hero carousel whose games, images, order and optional headline/description are chosen by the admin (falls back to the top-rated games when no slide is configured), with timed rotation, manual controls, pause and reduced-motion support.
- Top Games, Featured Games, Special Discounts, Recently Viewed and Recommended sections.
- Dedicated discounts page; catalogue search, genre/platform filters, price filters and sorting.
- Game profiles with screenshot galleries, trailer links, PC minimum/recommended requirements, price and purchase action.
- Wishlist, up-to-three-game comparison and recently viewed history (browser-local preferences).
- Responsive desktop/tablet/mobile layouts, two-column phone catalogue, touch-friendly controls, safe-area spacing and fixed mobile quick navigation.
- Localized USD/TZS price formatting driven by each game's configured currency.
- Account library and purchase history.
- Verified-purchaser reviews: only users with an entitlement can submit; submissions remain pending until an admin approves them.
- Customer support tickets with customer tracking and admin status management.
- Newsletter email capture stored in Turso. **No campaign emails are sent** until a mailing provider is configured.
- Admin analytics for accounts, orders, downloads, paid revenue by currency, top purchased games, pending reviews, review moderation and support requests.

## Existing payment and download security

1. Buyer signs in and starts checkout.
2. The server calculates the amount from the Turso game record and creates a Pesapal order.
3. Pesapal sends an IPN; the server independently checks transaction status, amount and currency with Pesapal.
4. Only a verified paid order creates an entitlement. Eligible free games are added without checkout.
5. The library download endpoint requires authentication and a matching entitlement. Public game responses never expose the download URL.

Do not place secrets in the repository or browser code. Do not configure game files unless you own the rights or have explicit distribution permission.

## Database changes

The server creates the `reviews`, `newsletter_subscribers`, `support_tickets` and `hero_slides` tables automatically. It also performs additive migrations for `games.requirements_min` and `games.requirements_recommended`; existing game records are retained. No new storage provider or game-file storage system is introduced.

## Setup

### 1. Turso

1. Create a Turso database.
2. Copy its `libsql://` database URL and authentication token.

### 2. Pesapal

1. Create Pesapal developer credentials and test with sandbox first.
2. Use the sandbox base URL until a complete test payment and IPN verification succeed.

### 3. Deploy

Upload `server.js`, `index.html`, `package.json`, `.gitignore` and this README to your repository. On Render use:

- Build command: `npm install`
- Start command: `npm start`

Configure these environment variables in the hosting dashboard:

| Key | Purpose |
|---|---|
| `JWT_SECRET` | Random secret, at least 32 characters |
| `TURSO_DATABASE_URL` | Turso database URL |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `ADMIN_EMAIL` | Admin account email |
| `ADMIN_PASSWORD` | Admin password, at least 8 characters |
| `PUBLIC_URL` | Public HTTPS service URL, without trailing slash |
| `PESAPAL_CONSUMER_KEY` | Pesapal key |
| `PESAPAL_CONSUMER_SECRET` | Pesapal secret |
| `PESAPAL_BASE_URL` | Sandbox or live Pesapal API base URL |
| `NODE_ENV` | `production` |

Never commit `.env` or production credentials.

## Admin workflow

- Sign in at `/#admin` using the configured admin account.
- Create/edit games, set currency, price, discount, rating, platform, minimum/recommended PC requirements, cover, screenshots and trailer URLs.
- Add the authorized download destination. The browser never receives that destination from the public catalogue API.
- Confirm distribution rights before publishing.
- Use the analytics, review moderation and support queue sections on the admin page.
- **Hero banner:** in the admin page, open the *Hero banner* section, press *Add slide*, pick a game, then choose its image by uploading from your device (any size/aspect ratio), dragging a file in, or picking one of that game's cover/screenshots. Optionally set a custom headline and description, reorder with the arrows, hide a slide, then press *Save hero banner*. Up to 10 slides. Draft games are hidden from the banner until published. If no slide is active, the banner shows the top-rated games. Use wide landscape images for the strongest result.

## Important launch checks

- The privacy and terms pages contain operational draft language, not legal advice. Add the real operator identity, support contact, data retention details, applicable Tanzania disclosures, governing law and a reviewed refund policy before taking live orders.
- Newsletter addresses are stored in Turso only. Configure and test a mailing provider, consent wording, unsubscribe flow and retention policy before sending campaigns.
- Ratings entered in the admin catalogue are editorial/catalogue scores; they are not represented as customer-review averages.
- TZS is displayed without fractional digits. Confirm the intended TZS pricing convention and Pesapal settlement currency before publishing prices.
- The existing image endpoint stores compressed image data in Turso. This is suitable only for a modest catalogue; monitor database size and plan a dedicated image CDN/object store if the catalogue grows. Game files remain external and are not stored in Turso.
- Test sandbox registration, login, free claims, successful/failed/pending Pesapal payments, IPN retries, entitlement creation, protected downloads, mobile navigation, review moderation and support tickets before launch.

## API overview

- Public: `GET /api/games`, `GET /api/games/:slug`, `GET /api/games/:slug/reviews`
- Accounts: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/me`
- Orders/library: `POST /api/orders`, `GET /api/orders/:ref`, `GET /api/orders/mine`, `GET /api/library`, `GET /api/library/:slug/download`
- Reviews: `POST /api/games/:slug/reviews` (authenticated verified purchaser)
- Support: `POST /api/support`, `GET /api/support`
- Newsletter: `POST /api/newsletter`
- Hero banner: `GET /api/hero` (public), `GET/PUT /api/admin/hero` (admin; PUT replaces the ordered slide list)
- Admin: `GET/POST /api/admin/games`, `PUT/DELETE /api/admin/games/:id`, `GET /api/admin/orders`, `GET /api/admin/analytics`, `GET /api/admin/reviews`, `PUT /api/admin/reviews/:id`, `GET /api/admin/support`, `PUT /api/admin/support/:id`

## Link formats

Download destinations accept HTTP(S) URLs and validated BitTorrent magnet URIs. Magnet links are handed to the user's registered torrent client only after the entitlement check. Browser and device handling varies. Only use links for content you are authorized to distribute.

## Display zoom

The whole site uses CSS page zoom, the same mechanic as Orbit. By default it is 80% on all devices. Visitors can change it from the **Settings** page (footer link, or the Account page) with a 50-150% slider; the choice is saved in the browser (`gz-zoom`) and overrides the automatic default until they press *Reset to auto*.

The zoom factor is also exposed to CSS as `--z`. Parts sized from the screen (hero height, page background, notch/home-indicator spacing) divide by it, so they keep matching the real screen at any zoom. Use `calc(Nvh / var(--z,1))` for any new viewport-unit sizing.

## Phone spacing

Phones (up to 640px wide) use the same spacing rhythm as tablet and PC: 20px page margins, 14px grid gaps, 24px section headings, 34px section spacing, and 13-15px card text and buttons. Keep new phone styles close to the PC values rather than compressing them.

## Hero edge

The homepage hero has a glowing green boundary (thin green frame, a green glow along the bottom edge that fades out at the sides). It is the `.hero::before` and `.hero::after` rules at the end of the stylesheet; lower the `rgba(157,245,43,...)` alpha values there to soften it.

## Theme

The site background is built in code (no image file): layered CSS gradients for the drifting smoke, an SVG hex grid, a neon HUD frame at the corners, and a controller silhouette. The markup is the `.bgfx` block at the top of `<body>` and the styles are in the "code-built theme" section at the end of the stylesheet. Cards, panels and dialogs have neon corner brackets, buttons have cut corners, headings have a green slash accent, and the header/footer have glowing green lines. Smoke drift is switched off for visitors who prefer reduced motion.
