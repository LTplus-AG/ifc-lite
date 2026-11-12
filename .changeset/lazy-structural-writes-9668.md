---
"@ifc-lite/viewer": patch
---

The structural write path (`bim.store.addStructural*`, the structural relationship methods and the assistant's structural graph review) now loads in its own chunk instead of at startup. The viewer starts loading it when the script host is built. A script call that arrives before it has loaded is refused with a message naming the method; the assistant's review waits for it.
