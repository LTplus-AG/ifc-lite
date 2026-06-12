---
"@ifc-lite/embed-sdk": patch
---

Fix the default embed viewer origin: `embed.ifc-lite.com` does not exist (NXDOMAIN), the hosted viewer lives at `embed.ifclite.com`. Without an explicit `origin` option, `IFCLiteEmbed.create()` pointed the iframe at a dead domain and rejected with a handshake timeout after 15s. Existing SDK versions can work around this by passing `origin: 'https://embed.ifclite.com'`.
