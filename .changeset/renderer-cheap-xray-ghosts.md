---
'@ifc-lite/renderer': patch
---

X-Ray context ghosts (`ghostExceptIds`) draw with a lighter fragment stage. A ghost keeps the main shader's discards, flat face normal and diffuse light rig, and skips the specular term, cast shadows, the selection tint and the entity colour override, none of which show at the ghost alpha. Blended geometry gets no hidden-surface removal, so every ghosted layer under a pixel paid for that shading: on a large architectural model, orbiting with one storey solid and the rest ghosted drops from about 70 ms to about 15 ms a frame. Transparency overrides, selected and excepted ids, and natively translucent materials keep the full shader. The ghost pipeline is built on first use and validated asynchronously; until it lands, or if it fails, ghosts draw as before.
