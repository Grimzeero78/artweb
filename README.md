# IsaaCart — artweb

Stencil-art portfolio for Isaac Bridget (isaacbridgetart), now **full stack**:

- **Frontend** — static site in [`public/`](public/index.html) (Tailwind + vanilla JS)
- **Backend** — Cloudflare Worker API in [`src/worker.js`](src/worker.js) (zero dependencies)
- **Database** — Cloudflare D1 (SQLite), schema in [`schema.sql`](schema.sql)

Contact messages and artwork bookings submitted on the site are stored in D1,
so nothing is lost even when a visitor skips the WhatsApp handoff.

---

## Connect to Cloudflare (one-time setup)

> Requires a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and Node.js 18+.

```bash
# 1. Install wrangler (Cloudflare's CLI) and log in
npm install
npx wrangler login

# 2. Create the D1 database
npx wrangler d1 create artweb-db

# 3. Copy the "database_id" from the output above and paste it
#    into wrangler.toml → REPLACE_WITH_YOUR_D1_DATABASE_ID

# 4. Create the table on the live database
npx wrangler d1 execute artweb-db --remote --file=./schema.sql

# 5. Deploy (site + API together, same URL as before)
npx wrangler deploy
```

That's it — your site is served from the Worker with `/api/*` routes live.

## Read messages & bookings

```bash
# Latest 50 messages (contact + bookings)
npx wrangler d1 execute artweb-db --remote \
  --command "SELECT id, type, name, phone, email, subject, message, artwork_title, created_at FROM messages ORDER BY id DESC LIMIT 50" --json

# Count unread
npx wrangler d1 execute artweb-db --remote \
  --command "SELECT COUNT(*) AS unread FROM messages WHERE status = 'new'"
```

Tip: you can also run `npx wrangler d1 studio artweb-db --remote` for a spreadsheet view, or connect the D1 database to Cloudflare Workers Observability / a future admin page.

## Local development

```bash
npm install
npx wrangler d1 execute artweb-db --local --file=./schema.sql
npx wrangler dev          # → http://localhost:8787
```

## API reference

| Route | Method | Body | Response |
| --- | --- | --- | --- |
| `/api/health` | GET | — | `{ ok, service, db }` |
| `/api/contact` | POST | `{ name, phone, email?, subject?, message, website? }` | `{ ok, id }` |
| `/api/book` | POST | `{ name, phone, message?, artworkId, artworkTitle, artworkPrice?, artworkSize?, artworkMedium?, artworkLayers? }` | `{ ok, id }` |

Built-in protections: field validation + length caps, honeypot field (`website`),
per-IP flood control (5 submissions / 10 min), 20 KB body limit, parameterized SQL only.

## Admin dashboard (manage everything, no code)

Open **https://artweb.dev078.workers.dev/admin** and log in with the admin password.

From there you can:

- **Upload pictures** from your phone/computer (auto-resized, stored in D1, served from `/img/...`)
- **Add / edit / delete artworks** — title, price, size, medium, layers, year, description, availability
- **Mark artworks sold/available** with one click — the public gallery updates instantly
- **Read visitor messages and booking requests** — mark read, archive, delete

### Change the admin password

```bash
npx wrangler secret put ADMIN_PASSWORD   # type the new password, press Enter
```

Security: sessions are HMAC-signed HttpOnly cookies (12 h), failed logins are
rate-limited (5 tries / 10 min / IP), and the admin page is `noindex`.

## Repo layout

```
artweb/
├── public/          # static site (served by the Worker)
│   ├── index.html
│   └── favicon.ico
├── src/
│   └── worker.js    # API routes + asset serving
├── schema.sql       # D1 tables & indexes
└── wrangler.toml    # Cloudflare config (assets, D1 binding)
```
