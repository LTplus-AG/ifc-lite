---
"@ifc-lite/collab": minor
"@ifc-lite/collab-server": minor
---

`@ifc-lite/collab` follow-up: deterministic per-user color hash exposed
publicly (`colorForUser`, `DEFAULT_USER_PALETTE`, `fnv1a`) and consumed
automatically by `Presence.setUser` when the caller doesn't supply a color.
`UserIdentity.color` is now optional.

Conflict detector tightened: only flags concurrent deletes (not creates) at
the entity top level, and now also surfaces concurrent Pset-creation as a
`pset-property` event keyed by Pset name.

`@ifc-lite/collab-server` follow-up: an append-only audit log
(`AuditSink`, `MemoryAuditSink`, `noopAuditSink`, `shortHash`) that records
`(timestamp, user, room, op-type, op-hash)` for every connect, sync,
update, awareness, and reject event; and a per-peer rate limiter
(`createRateLimiter`, `RateLimitOptions`) wired into the room's update
filter. Editor-or-better roles get a 200-token / 60-tps default bucket;
`startCollabServer` accepts a function form so service accounts can have
tighter budgets than humans.

Tests added: 23 new (color, audit + rate limit, disconnect/reconnect,
property-based convergence with seeded random traces, conflict scenarios
for each `ConflictKind`, broader entity-op coverage). Total now 49.
