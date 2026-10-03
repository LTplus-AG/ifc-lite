---
"@ifc-lite/collab-server": patch
"@ifc-lite/mcp": patch
"@ifc-lite/flow-nodes": patch
"@ifc-lite/semantic": patch
---

Malformed percent-escapes and unparseable request targets no longer escape as a bare `URIError` or `TypeError`. The collab server answers a request target `new URL` rejects with 400 instead of 500, closes a websocket with a malformed room path with 4400 instead of 1011, and the blob-GC scan reads each room log by its file name instead of decoding the name into a room id (a log with a malformed name is read, or named in the abort message, instead of stopping the sweep with `URI malformed`). The MCP entity resource answers a malformed GlobalId as "no such entity", and the Speckle URL parser refuses it with its named "no usable id" error, and the semantic relay's HTTPS listener answers an unparseable request target with 400 instead of 500.
