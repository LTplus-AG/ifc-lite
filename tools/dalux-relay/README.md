# Dalux CORS Relay

A minimal Cloudflare Worker that relays requests to `field.dalux.com` and adds
CORS headers. Deploy it to proxy Dalux Build API calls from the browser, where
the Dalux API's lack of CORS headers blocks direct `fetch()`.

## How it works

1. The worker receives a request from the ifc-lite viewer.
2. It rewrites the URL to target `field.dalux.com`, injects the API key from an
   environment secret, and forwards the request.
3. The response is returned with permissive CORS headers so the browser allows it.

The API key lives server-side in the Worker secret — it never reaches the browser.

## Deploy

```bash
# Install wrangler (Cloudflare's CLI)
npm i -g wrangler

# Authenticate
wrangler login

# Set the API key secret
wrangler secret put DALUX_API_KEY

# Deploy
wrangler deploy
```

## Configuration

- `DALUX_API_KEY` — Worker secret, set via `wrangler secret put`.
- `ALLOWED_ORIGINS` — Optional comma-separated list of allowed CORS origins.
  Defaults to `*`. Set via `wrangler secret put ALLOWED_ORIGINS` or in
  `wrangler.toml` vars.
