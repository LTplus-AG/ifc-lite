---
'@ifc-lite/collab-server': patch
---

Stop the collab server counting itself as a room participant. y-protocols'
`Awareness` constructor self-registers a local state of `{}` and renews it every
15 seconds, so every room's peer badge read one too high: it showed "(2)"
directly above a roster saying "You're the only one here", because the roster
filters on a `user` field and the badge did not. The server now clears its own
awareness state, which also stops the renewal.
