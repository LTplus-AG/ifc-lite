---
'@ifc-lite/parser': patch
'@ifc-lite/geometry': patch
---

The geometry pre-pass hands the parser a finished entity index, and on that path the parser never scans the file — so anything the pre-pass dropped is invisible on the parser side. #3695 made a malformed-record stop (a quoted string or block comment that opened and never closed) reportable on the paths that do their own scanning, but the pre-scanned path had no field to carry it, and the sharded stitch could not tell a scan that stopped from a scan that reached the end of the entities: both arrive as `handoff === -1`, the merge loop breaks either way, and every later record is dropped with nothing said. That is the load path a large model takes in a browser.

`ShardColumns` now carries `malformedStart` and `stitchShards` returns `malformedRecordCount`, attributed against the boundary each shard's records are cut at — the rule `oversizedIdStarts` already uses, because a shard starting inside a quoted value reports a stop the file does not contain. The count travels on through `onEntityIndex`, `WorkerParser.setEntityIndex` and `PreScannedEntityIndex.malformedRecordCount` to `EntityScanResult.malformedRecordCount`, where the existing `onDiagnostic` message fires as it does on every other path.

No producer sets `malformedStart` yet: the Rust sharded scan has no malformed-stop offset to return until #3699 lands, so today the field is always absent and the stitch reports 0 — which is "nothing reported", not proof of a clean scan. This is the wiring, ready for that offset to arrive.
