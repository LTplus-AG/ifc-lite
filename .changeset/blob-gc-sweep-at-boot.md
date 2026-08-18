---
'@ifc-lite/collab-server': patch
---

The blob sweep now runs once at startup instead of only after the first interval
elapses, and the configurable grace window has a floor.

`setInterval` does not fire immediately, so with the default six-hour period a
server that restarts more often than that never completed a sweep at all: the GC
was present in the code and absent in effect. Hosted deploys restart on
redeploy, OOM and platform events, so that was the normal case rather than an
edge one.

`COLLAB_BLOB_GC_GRACE_MS` also accepted `0`, which is the destructive value: it
makes the cutoff equal to now, condemning every unreferenced blob regardless of
age, including one uploaded moments earlier by an in-flight share whose document
reference has not landed yet. The minimum is now one minute.
