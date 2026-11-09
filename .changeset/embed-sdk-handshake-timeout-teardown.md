---
"@ifc-lite/embed-sdk": patch
---

When the `IFCLiteEmbed.create()` handshake times out, the embed is now destroyed before `create()` rejects: the iframe is removed and the window `message` listener is detached, so a READY arriving late no longer posts the configured token into the abandoned iframe, and host retries no longer stack iframes in the container.
