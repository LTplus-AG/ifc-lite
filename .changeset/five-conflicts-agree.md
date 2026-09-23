---
"@ifc-lite/collab": patch
---

Fix the conflict detector throwing a `TypeError` out of `Y.applyUpdate` when it is attached to a raw `Y.Doc` (for example one passed as `CollabSessionOptions.doc`) whose top-level maps had never been accessed locally. The first remote update decoded `entities` as a bare `Y.AbstractType`, and because the detector watches the same doc the websocket provider writes to, the throw landed inside the provider's message handling. The detector now initialises the maps it reads when it is created, so that update is classified normally instead of crashing.

Also fix the detector missing conflicts when a single `Y.applyUpdate` carries writes from more than one remote client (relay catch-up, a merged diff, coalesced updates). It used to attribute the whole transaction to one guessed client. It now reads the structs the transaction inserted and credits every client that wrote the key, so a conflict is reported the same way whether it arrives batched or as separate transactions.
