---
"@ifc-lite/viewer": minor
---

BIMcollab sign-in works with a confidential OAuth client (#4919). When `VITE_BCF_APP_BIMCOLLAB_TOKEN_RELAY` is set (normally to `/api/bcf/oauth/token`), the code exchange and every later refresh of that session go through a same-origin server relay. The relay adds the client secret from the server-only `BCF_BIMCOLLAB_CLIENT_SECRET`, so the browser never holds it. The relay accepts only BIMcollab space token endpoints and the registered redirect URIs. If its deployment has no credentials, it answers `503 relay_not_configured` and the viewer falls back to the direct exchange. The Vite dev server serves the same relay, so `vite --port 5000` works against the localhost callback.
