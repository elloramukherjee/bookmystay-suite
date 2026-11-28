# Deploying on Railway (Hobby)

One Railway project, two services, one public domain:

```
Browser ──HTTPS──▶ <app>.up.railway.app ──▶ BookMyStay-App (Express, PORT from Railway, 0.0.0.0)
                                              ├─ /api/v1/…  REST API, webhooks, Gemini (server-side only)
                                              └─ /…         React app (client/dist, SPA fallback)
                                                   │
                                                   └─ private network ─▶ MongoDB (mongodb.railway.internal:27017,
                                                                          volume mounted at /data/db, no public proxy)
```

## 1. Services

| Service | Source | Notes |
|---|---|---|
| `MongoDB` | Railway MongoDB template | Volume at `/data/db`. No TCP proxy needed: the app uses the private network. |
| `BookMyStay-App` | This GitHub repo (root directory `/`) | Built from `Dockerfile` via `railway.json`. Generate one public domain under Settings → Networking. |

`railway.json` sets: builder `DOCKERFILE`, health check `/api/v1/health` (200 only when MongoDB is reachable),
restart on failure. No custom build/start command is needed. The image runs `npm ci` → `npm run build`
(server `tsc` + client `vite build`) and starts `node dist/server.js` with `NODE_ENV=production`, `SERVE_CLIENT=true`.

Without Docker (Railpack), the equivalent would be build `npm ci --include=dev && npm run build`, start `npm start`,
plus `NODE_ENV=production` and `SERVE_CLIENT=true` as variables. The Dockerfile is the supported path.

## 2. Variables on `BookMyStay-App`

| Variable | Value |
|---|---|
| `MONGODB_URI` | `${{MongoDB.MONGO_URL}}/bookmystay?authSource=admin` (reference variable. **Must** include `/bookmystay`. The server refuses a URI without a database name.) |
| `CLIENT_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` (or your custom domain, `https://…`) |
| `TRUST_PROXY` | `1` (Railway's edge proxy, so rate limits see real client IPs) |
| `JWT_ACCESS_SECRET` | 48 random bytes, see below |
| `JWT_REFRESH_SECRET` | 48 random bytes, different from the access secret |
| `IP_HASH_SALT` | 16+ random characters |
| `PAYMENT_PROVIDER` | `pay_at_hotel` (or `razorpay` + `PAYMENT_GATEWAY_KEY`, `PAYMENT_GATEWAY_SECRET`, `PAYMENT_WEBHOOK_SECRET`) |
| `GEMINI_API_KEY` | Your Google AI Studio key (optional: without it every chat goes to staff) |
| `GEMINI_MODEL` | `gemini-3.8-flash` (default) |
| `GEMINI_FALLBACK_MODEL` | optional, e.g. `gemini-3.5-flash` |
| `GEMINI_THINKING_LEVEL` | `LOW` |
| `WHATSAPP_*` | optional (simulator mode until set, see `docs/WHATSAPP-SETUP.md`) |

Do **not** set `PORT` (Railway injects it) or any `VITE_*` secret (they ship to the browser). `NODE_ENV` and
`SERVE_CLIENT` are already set by the Dockerfile.

Generate secrets: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

## 3. Moving data from a local MongoDB

Railway's MongoDB is private. For a one-off import, temporarily add a TCP proxy (MongoDB → Settings → Networking →
TCP Proxy, port `27017`), then:

```bash
mongodump --uri="mongodb://127.0.0.1:27017" --db=bookmystay --out=./mongo-backup
# Public URL: MongoDB → Variables → MONGO_PUBLIC_URL (or user/password + the proxy host:port)
mongorestore --uri="mongodb://mongo:<PASSWORD>@<proxy-host>:<proxy-port>/?authSource=admin" \
  --nsInclude="bookmystay.*" --drop ./mongo-backup
```

`--drop` replaces existing collections. Leave it out to merge. Remove the TCP proxy afterwards. `mongo-backup/` is
git-ignored. Delete it when no longer needed (it contains guest data).

## 4. Checklist

1. `npm ci && npm run verify` locally (typecheck, all tests, production build).
2. Push to GitHub. Create `BookMyStay-App` from the repo in the same project as `MongoDB`.
3. Set the variables above. Generate the public domain, then set `CLIENT_URL` to it.
4. Deploy. Wait for the health check to pass. Logs should show `Connecting to MongoDB` → `MongoDB connected`
   (host `mongodb.railway.internal:27017`, database `bookmystay`) → `Serving the web app from the API`.
5. In the app service shell: `npm run preflight:dist --workspace server`. Review anything marked ✗ / !.
6. Smoke test: home page, a deep link (e.g. `/login`) refreshed in the browser, staff sign-in, a chat message
   (Gemini reply), a test booking with your own number, then cancel it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `MONGODB_URI: has no database name` | Append `/bookmystay?authSource=admin` to `${{MongoDB.MONGO_URL}}`. |
| `MongoDB connection failed; retrying` then giving up | MongoDB service down, or the reference variable points at a differently named service (`${{<ServiceName>.MONGO_URL}}`). |
| Health check fails, logs fine | The app must listen on Railway's `PORT`. Make sure `PORT` is not overridden in Variables. |
| Staff are logged out on refresh | `CLIENT_URL` must exactly match the public `https://` origin. |
| `Standalone MongoDB` readiness error in logs | Railway's MongoDB may run without a replica set. The app falls back to guarded atomic updates (no multi-document transactions). See `docs/DEPLOYMENT.md` for the trade-off. |
