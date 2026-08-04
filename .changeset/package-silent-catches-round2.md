---
'@ifc-lite/data': patch
'@ifc-lite/cache': patch
'@ifc-lite/create': patch
'@ifc-lite/cli': patch
'@ifc-lite/geometry': patch
---

Stop four package-level failures from being reported as ordinary results.

- `@ifc-lite/data` / `@ifc-lite/cache`: a List-typed property with no value
  came back as `[]` — a real empty list — because the NULL string sentinel
  resolved to `''` and the resulting `JSON.parse` throw was swallowed. NULL
  now reads as `null`, matching the string branch beside it, and a genuinely
  unparseable list value logs once (latched) before falling back to `[]`.
- `@ifc-lite/create`: `extractWallSegmentsForStorey` silently defaulted to a
  metre length-unit scale when unit extraction threw, mis-scaling every
  extracted wall segment on a millimetre model. It now warns with the error,
  matching `resolveSpatialAnchor` / `resolveDuplicateSource`.
- `@ifc-lite/cli`: `ifc-lite schema` printed a reduced built-in schema as if
  it were the full SDK surface when `@ifc-lite/sandbox/schema` could not be
  loaded; it now says so on stderr and exits non-zero (stdout is still pure
  JSON, unchanged shape), so a piping caller that discards stderr still sees
  the failure. `--version` no longer reports a hard-coded `0.4.0` when
  `package.json` is unreadable — it reports `0.0.0-unknown` and explains why
  on stderr.
- `@ifc-lite/geometry`: the shard and finalise paths that fall back from a
  SharedArrayBuffer view to a materialised (file-sized) copy now say so once
  per worker, matching the streaming-prepass path that already did.
