---
"@ifc-lite/mcp": minor
"@ifc-lite/viewer": minor
---

The `--bridge` protocol now carries image results. A tab may send MCP `image` content (PNG, JPEG or WebP, checked against its file signature, at most 2 per result and 3 MiB of base64 each), and the bridge forwards it to the agent unchanged. The bridge advertises this with `features: ["image-content"]` in `welcome`; the protocol version stays 1, and a tab paired with an older bridge sends a text note asking for an update instead. `BridgeCallResult.content` is now `BridgeContent[]` (text or image), so TypeScript code reading `.text` from a block must narrow on `type` first.

The TypeScript change is breaking and uses the repository's minor bump policy for 0.x packages.

The viewer adds a read-only `viewer_screenshot` agent tool: the current viewport through the same native capture as the toolbar screenshot, scaled to `max_width` (256 to 1920, default 1024) and returned as JPEG or PNG.
