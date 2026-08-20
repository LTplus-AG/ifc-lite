---
'@ifc-lite/clash': patch
---

Add frozen-output vectors that pin `uuidFromSeed`'s hard-coded expected UUIDs.

Every existing test touching `uuidFromSeed` (in `bcf-bridge.test.ts`) either
compared two calls against each other within the same process, or checked
shape/regex/version-nibble — none asserted a fixed expected value. That is
the same shape as an encode/decode pair sharing a table: internally
consistent, free to drift. Confirmed by mutation: replacing all four salt
constants in `deterministic-uuid.ts` with different arbitrary values still
produced valid-shaped, self-consistent UUIDs, and the existing suite stayed
green.

These are BCF topic guids: `bcf-bridge.ts` derives a topic's guid from
`uuidFromSeed(group.id)` so that re-running the same coordination produces
byte-identical topic guids and previously exported BCF topics keep
correlating with the clash they describe. A silent change to the salts, the
mixing/rotation order, or the version/variant nibble derivation would
silently detach every previously exported BCF topic from its clash.

No behavior change — this is test-only. The new vectors are frozen output
captured from the current implementation, not values derived from any
specification (there is no external reference for this algorithm); the test
file documents this explicitly so a failing assertion is never "fixed" by
regenerating the expected value from the new code.
