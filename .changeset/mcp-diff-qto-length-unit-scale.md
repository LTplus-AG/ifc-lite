---
'@ifc-lite/mcp': patch
---

Fix `model_diff` reporting a `Qto_` `IfcElementQuantity` (Length/Area/Volume) as `modified` when a model is re-authored in a different project length unit but no physical quantity actually changed — the same false positive `#3458`-adjacent fix closed on the CLI's `ifc-lite diff` (see the `@ifc-lite/cli` changeset). `buildModelFingerprints`' `buildDataInput`/`createdFingerprint` now scale a Qto_ value to base SI with `quantitySiScale` (`@ifc-lite/parser`) before rounding and hashing, for both a stored and an overlay-queued quantity, keeping this adapter's fingerprints identical to the CLI's — the invariant `diff-fingerprints.test.ts`'s parity suite enforces.
