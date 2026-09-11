---
"@ifc-lite/cli": patch
---

Fix `query --group-by --sum/--avg/--min/--max --json` reporting a fabricated `0` for a group that has no data for the aggregated quantity, indistinguishable from a group whose real aggregate genuinely computes to `0`. Each group entry now carries `matchedEntities`, the count of entities in that group that actually had the quantity — `matchedEntities: 0` means the numeric field is fabricated, not measured. The existing numeric field's type is unchanged (still always a number) so this is additive, not breaking.

The non-JSON (table) rendering now annotates a no-data group's line with `(no data)`, and the trailing warning now fires only when no group in the result matched any data, instead of when the grand total across all groups happened to be `0` (which previously both missed a no-data group mixed in with real-data groups, and falsely warned when a real aggregate legitimately cancels to `0`, e.g. summing `-5` and `5`).

`schedule --subtotals` already propagated a genuine `null` for a no-data subtotal end-to-end (CSV and JSON), so it needed no change.
