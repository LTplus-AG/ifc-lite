---
"@ifc-lite/collab": patch
---

Fix the conflict detector crashing with a `TypeError` when a top-level shared map hasn't been locally accessed yet (a raw `Y.Doc` supplied via `CollabSessionOptions.doc`, first touched by a remote update) — the same doc a `CollabSession`'s websocket provider mutates, so the throw previously propagated into `y-websocket`'s own message handling. Also fix the detector missing a conflict when one batched `Y.applyUpdate` carries structs from more than one remote client (a relay catch-up, a merged diff, or coalesced updates): attribution is now per written key instead of guessing a single client for the whole transaction, so a conflict is reported the same way whether it arrives batched or as separate transactions.
