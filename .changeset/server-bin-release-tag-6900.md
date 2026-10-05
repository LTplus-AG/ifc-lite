---
'@ifc-lite/server-bin': patch
---

Download the server binary from its own `server-v<version>` release (falling back to the legacy `v<version>` tag), and never fall back to a release of a different major version. server-bin 2.0.0 shared the `v2.0.0` tag with an older, asset-less root release, so it silently installed the 1.22.1 binary (#6900).
