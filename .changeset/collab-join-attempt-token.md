---
"@ifc-lite/viewer": patch
---

Leaving a shared room and rejoining the same room before the first join had finished no longer leaves two sessions fighting over the viewer. Previously the abandoned join could resume after the rejoin and commit its own session. If it failed, it cleared the rejoin's room, role and token. Each join now carries its own attempt token. A join the user has left cannot commit a session, wire listeners, or touch the live join's state. Everything it set up is torn down when it is retired.
