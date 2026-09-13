---
"@ifc-lite/wasm": patch
"@ifc-lite/server-bin": patch
---

The void router's "did this cut change the host" check now reads the host and the cut result about the host's one reference point. It used to read each about its own bounding-box centre, so on a host with an open crack, an end cut that kept the triangle count and moved the bounding box could shift the crack's reading by as much as the volume it removed, and a real cut was judged unchanged and thrown away for a fallback.
