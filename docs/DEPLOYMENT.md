# Deployment

Target topology (per the brief): **Vercel** (frontend) + **Railway** (backend) + **Supabase**
(PostgreSQL). Total time ~20 minutes.

## 1. Supabase (database)

1. [supabase.com](https://supabase.com) → New project → pick a region close to your Railway
   region → set a strong DB password.
2. Project Settings → **Database** → Connection string. You need both forms:
   - **Transaction pooler** (port `6543`) → runtime `DATABASE_URL`. Append
     `?pgbouncer=true&connection_limit=10`.
   - **Session / direct** (port `5432`) → `DIRECT_URL` (used only by `prisma migrate`).
3. Nothing else to configure — migrations create the schema, constraints and triggers.

## 2. Railway (backend)

1. [railway.app](https://railway.app) → New Project → **Deploy from GitHub repo** → pick this
   repo.
2. Service settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm run build` (runs `prisma generate` + `tsc`)
   - **Start Command:** `npm run start:deploy` (runs `prisma migrate deploy`, then starts —
     migrations are applied automatically on every release)
3. Variables:

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | Supabase pooler URL (`...:6543/postgres?pgbouncer=true&connection_limit=10`) |
   | `DIRECT_URL` | Supabase direct URL (`...:5432/postgres`) |
   | `NODE_ENV` | `production` |
   | `FRONTEND_ORIGIN` | your Vercel URL, e.g. `https://ent-jfe.vercel.app` (add it after step 3; comma-separate to also allow previews) |
   | `STRIPE_MOCK_LATENCY_MS` | `40` |

   (`PORT` is injected by Railway; the server binds `0.0.0.0:$PORT` automatically.)
4. Deploy → copy the public URL (e.g. `https://ent-jfe-backend.up.railway.app`) → check
   `GET /health`.

> Render works identically: Root Directory `backend`, build `npm install && npm run build`,
> start `npm run start:deploy`.

## 3. Vercel (frontend)

1. [vercel.com](https://vercel.com) → Add New Project → import the repo.
2. **Root Directory:** `frontend` (framework auto-detected: Next.js).
3. Environment variable: `NEXT_PUBLIC_API_URL` = the Railway URL (no trailing slash).
4. Deploy → copy the Vercel URL → go back to Railway and set/update `FRONTEND_ORIGIN` to it
   (CORS), redeploy backend.

## 4. Post-deploy verification

```bash
# health + empty books
curl https://<railway-url>/health
curl https://<railway-url>/trial-balance        # balanced: true (0 entries)

# optional demo data (run locally against prod DB — uses the real service layer)
cd backend
DATABASE_URL="<supabase-pooler-url>" DIRECT_URL="<supabase-direct-url>" npm run db:seed

# the full Part C.1 stress run against production
API_URL=https://<railway-url> npm run load-test
```

Then open the Vercel URL: create an order → pay → watch the ledger; try `cus_eve_declined` (402)
and `cus_max_unavailable` (502 → click again: the SAME key resumes, no double charge); run a
settlement twice and watch the second one replay.

## Environment matrix

| Variable | Local dev | Tests | Production |
| --- | --- | --- | --- |
| `DATABASE_URL` | `localhost:5433/ent_jfe` | `localhost:5433/ent_jfe_test` (`.env.test`) | Supabase pooler `:6543` + `pgbouncer=true` |
| `DIRECT_URL` | same as above | same as above | Supabase direct `:5432` |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | — | Vercel URL |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | — | Railway URL |

Notes:
- Prisma + pgbouncer (transaction mode) is safe here: no session state, short transactions;
  migrations bypass the pooler via `DIRECT_URL`.
- The load test will happily run against production — it cleans nothing up by design (append-only
  system); use a fresh Supabase project if you want pristine demo data afterwards, or run the
  seed with `--reset` (TRUNCATE) before showing the dashboard.
