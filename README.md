# Restock Watch 🚨

Paste a product link (e.g. the Dyson SG HushJet page). The bot checks it every few minutes and sends a **Telegram ping with a "Buy now" link the moment it's back in stock**. You tap, pay with your saved card / Apple Pay, done — usually under a minute.

## Why it doesn't auto-checkout
Shops like Dyson put bot detection and CAPTCHAs on checkout. Auto-buying would mean fighting those (against their terms, and accounts get banned) and storing your card on a server (a juicy target for hackers). The fast alert + one-tap link gets you 95% of the speed with none of that risk.

## How it works
```
 every ~3 min        product page          is it in stock?         flipped to YES?
 scheduler.js  ──►  safeFetch.js   ──►     checker.js       ──►    notify.js → Telegram
                    (allowlist +           (JSON-LD → your
                     SSRF guard)            phrase → text)
```
| File | What it does |
|---|---|
| `src/config.js` | Reads settings from `.env` |
| `src/safeFetch.js` | Only fetches allowlisted shops; blocks private IPs; size/time limits |
| `src/checker.js` | Decides in stock / sold out / unknown |
| `src/scheduler.js` | Runs checks one at a time, backs off if the shop blocks us |
| `src/notify.js` | Telegram alerts |
| `src/store.js` | Saves your watchlist to `data/items.json` |
| `src/server.js` | Dashboard login + API, security headers, rate limits |
| `public/` | The dashboard (HTML/CSS/JS) |

## Deploy from your phone or iPad (~15 minutes, no laptop)

**1. Make your Telegram bot** (Telegram app)
1. Search **@BotFather** → send `/newbot` → pick a name.
2. It replies with a long token like `712345:AAH…`. Long-press → Copy. Keep it for step 3.

**2. Put the code on GitHub** (github.com in Safari)
- Easiest: create an empty **private** repo called `restock-watch`, then ask Claude to push the code into it.
- Every future change gets pushed there too, and Render redeploys automatically.

**3. Deploy on Render** (render.com in Safari)
1. Sign up with **"GitHub"** and allow access to the `restock-watch` repo.
2. Tap **New → Blueprint** → choose `restock-watch`. Render reads `render.yaml` and fills in everything.
3. It asks for two values:
   - `ADMIN_PASSWORD` — 12+ characters, your dashboard login.
   - `TELEGRAM_BOT_TOKEN` — paste from step 1.
4. Tap **Apply**. Render will ask for a card: the always-on **Starter** plan plus a 1 GB disk. (The free plan sleeps after 15 minutes and would miss restocks.)
5. Wait ~3 minutes for "Live". Your link looks like `https://restock-watch-xxxx.onrender.com`.

**4. Use it**
1. Open your link → log in.
2. **Connect Telegram**: tap *Get my code*, send that code to your bot, tap *I've sent it*. You'll get a test ping.
3. Paste a product link, e.g. `https://www.dyson.com.sg/hushjet-purifier-compact-black-teal` → *Start watching*.
4. Safari Share button → **Add to Home Screen** to get an app icon.

### Running on a computer instead (optional)
```bash
npm install
cp .env.example .env   # fill it in
npm test && npm start  # http://localhost:3000
```

## If an item shows "Not sure" or "Problem"
- **Not sure**: open the page when sold out and copy the exact sold-out wording (e.g. `Notify me`) into *More options → Sold-out wording*.
- **Problem: Shop blocked the check (HTTP 403)**: the shop's bot protection rejected a plain request. The bot automatically slows down. If it persists, that shop needs a real-browser checker (Playwright) — a good next upgrade.
- **Shop not on the allowlist**: on Render → your service → *Environment* → add `ALLOWED_HOSTS` with the shop's exact hostname (comma-separated, keep the existing ones). Defaults: Dyson SG, Courts, FairPrice, Harvey Norman, Best Denki.

## Security notes
- No card details or shop passwords are ever stored.
- The server only fetches HTTPS pages on allowlisted shops, and refuses to connect to private/internal IPs even via DNS tricks.
- Login is rate-limited (5 tries / 15 min); cookies are HttpOnly, SameSite=Strict, signed.
- Strict Content-Security-Policy; page data is rendered as text only (no XSS).
- Keep `.env` out of git (already in `.gitignore`).
