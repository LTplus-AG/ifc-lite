---
'@ifc-lite/collab-server': patch
---

Stop the collab server counting itself as a room participant, and give it a real
keepalive. y-protocols' `Awareness` constructor self-registers a local state of
`{}` and renews it every 15 seconds, so every room's peer badge read one too
high: it showed "(2)" directly above a roster saying "You're the only one here",
because the roster filters on a `user` field and the badge did not.

That renewal was also the only server-to-client traffic in a single-occupant
room, and so was accidentally feeding y-websocket's 30 second reconnect
watchdog. Clearing the ghost alone put every lone client into a permanent ~30
second disconnect/reconnect loop, so the server now sends an explicit
application-level keepalive instead of relying on that side effect.
