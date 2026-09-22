---
"@ifc-lite/parser": patch
---

Fix a corrupted STEP numeric literal (e.g. a dropped comma fusing `1.52,3.0` into `1.52.3`) silently parsing as the truncated value `1.52` instead of being refused. `parseAttributeValue`'s numeric fallback and `getNumber` now require the token to match the STEP REAL/INTEGER grammar in full before trusting `parseFloat`, and preserve the raw token otherwise — the same refuse-and-warn shape already used for an overflowing literal like `1.0E400`.
