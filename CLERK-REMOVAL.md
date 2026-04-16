# Clerk Removal — Environment Cleanup Checklist

> **DO NOT COMMIT THIS FILE.**
> Delete before merging to production.

## Summary

Clerk has been fully removed from the codebase. The LLM chat now uses:

- **Free models** via the existing server proxy (anonymous, IP-rate-limited)
- **BYOK models** (Anthropic, OpenAI) via direct browser-to-provider calls using the user's own API key stored in `localStorage`

---

## Environment variables to REMOVE

Remove these from Vercel project settings, `.env`, `.env.local`, and any CI/CD config:

### Clerk (all removed)

| Variable | Where | Notes |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Vercel env / `.env.local` | Was the client-side Clerk key |
| `CLERK_SECRET_KEY` | Vercel env | Server-side Clerk secret |
| `CLERK_JWT_KEY` | Vercel env | Pinned PEM public key for JWT verification |
| `CLERK_ISSUER_URL` | Vercel env | Clerk issuer URL |
| `CLERK_ALLOWED_ISSUERS` | Vercel env | Comma-separated issuer allowlist |
| `CLERK_JWT_AUDIENCE` | Vercel env | Expected JWT audience |
| `CLERK_JWT_AUDIENCES` | Vercel env | Plural variant |
| `CLERK_AUTHORIZED_PARTY` | Vercel env | Expected azp claim |
| `CLERK_AUTHORIZED_PARTIES` | Vercel env | Plural variant |

### Pro/paid model config (all removed)

| Variable | Where | Notes |
|---|---|---|
| `LLM_PRO_MODELS` | Vercel env | Legacy single pro model list |
| `LLM_PRO_MODELS_LOW` | Vercel env | Cost-bucket: $ models |
| `LLM_PRO_MODELS_MEDIUM` | Vercel env | Cost-bucket: $$ models |
| `LLM_PRO_MODELS_HIGH` | Vercel env | Cost-bucket: $$$ models |
| `LLM_PRO_MONTHLY_CREDITS` | Vercel env | Monthly credit allowance (no longer tracked) |
| `LLM_COST_TO_CREDITS` | Vercel env | Cost-to-credits conversion factor |
| `VITE_LLM_PRO_MODELS_LOW` | Vercel env / `.env.local` | Client-side mirror of pro models |
| `VITE_LLM_PRO_MODELS_MEDIUM` | Vercel env / `.env.local` | Client-side mirror |
| `VITE_LLM_PRO_MODELS_HIGH` | Vercel env / `.env.local` | Client-side mirror |

---

## Environment variables to KEEP

These are still used:

| Variable | Purpose |
|---|---|
| `LLM_API_BASE` | Upstream LLM provider base URL (e.g. OpenRouter) |
| `LLM_API_KEY` | Server-side API key for the proxy |
| `LLM_FREE_MODELS` | Comma-separated list of free model IDs served through proxy |
| `LLM_FREE_DAILY_LIMIT` | Daily request cap per anonymous IP |
| `VITE_LLM_FREE_MODELS` | Client-side mirror of free models for UI |
| `VITE_LLM_IMAGE_MODELS` | Models that support image inputs |
| `VITE_LLM_FILE_ATTACHMENT_MODELS` | Models that support file attachments |
| `APP_URL` | Application base URL (CORS) |
| `APP_ALLOWED_ORIGINS` | Additional allowed CORS origins |
| `DATABASE_URL` | Neon PostgreSQL (usage tracking) |
| All `POSTGRES_*` / `PG*` vars | Database connection |

---

## Clerk Dashboard

After env cleanup, you can also:

1. Archive or delete the Clerk application at https://dashboard.clerk.com
2. Remove the Clerk webhook endpoints if any were configured
3. Cancel the Clerk subscription if on a paid plan

---

## Web viewer changes

- The `/settings` route has been **removed** from the web viewer (`App.tsx` and `vercel.json`).
  The SettingsPage component still exists for the **desktop app** (Tauri shell mounts it).
- API key entry for BYOK models now happens **inline in the chat panel** — when a user
  selects a BYOK model without a key, a prompt appears directly in the conversation area.
- The `/upgrade` route was already removed in the previous commit.

## Verification

After removing env vars and redeploying:

1. Free models should work without any sign-in
2. Selecting a BYOK model should show an inline key prompt in the chat panel
3. The `/settings` and `/upgrade` routes should 404
4. API keys persist across page reloads (stored in `localStorage`)
5. Verify keys are browser-local: `JSON.parse(localStorage.getItem('ifc-lite:api-keys:v1') ?? '{}')`

**Delete this file before merging to production.**
