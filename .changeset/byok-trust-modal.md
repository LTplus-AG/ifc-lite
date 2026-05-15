---
'@ifc-lite/viewer': minor
---

BYOK key entry moves from an inline strip into a trust-focused modal with one tab per provider. Each tab shows an SVG that contrasts the direct browser → provider request path against the "via our server" path we never use, DevTools-verifiable trust claims, a clipboard-detect shortcut (so users who just created a key on the provider console don't have to paste), and a 60-second walkthrough. A small key icon in the chat header reopens the modal for management, and a "🔒 → api.provider.com" pill next to the model name names the actual API host whenever a BYOK route is active.

Adds three new BYOK model IDs: `claude-opus-4-7` (Anthropic), `gpt-5.5` and `gpt-5.5-pro` (OpenAI).

Web build: this is the first time API-key entry has a real surface outside the cramped inline strip, since `/settings` is desktop-only.
