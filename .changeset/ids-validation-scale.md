---
"@ifc-lite/parser": patch
"@ifc-lite/ids": patch
"@ifc-lite/sdk": patch
"@ifc-lite/cli": patch
---

fix(ids): make IDS validation usable on large models with code-list IDS packs.

Validating a 550k-entity model against an 848-spec IDS document took ~19
minutes of CPU, produced multi-GB reports, and the CLI then hung forever
after printing its results. Four root fixes:

- parser: `yieldToEventLoop` leaked one open `MessageChannel` per yield;
  in Node an open `MessagePort` holds a libuv handle, so every CLI command
  on a large file kept the process alive after completion. Ports now close
  (helper consolidated into one shared module).
- ids: `validateIDS` wraps the accessor in a per-run memoizing cache so
  property sets / types / attributes are extracted once per entity instead
  of once per entity *per specification* (O(specs×entities) source
  re-parses → O(entities)). Enumeration constraints additionally compile
  into exact-match sets (real-world code lists carry 800+ values).
- ids: per-entity result strings are now bounded — enumeration constraints
  render at most 10 values in failure messages, and the entity-independent
  requirement description is formatted once per requirement instead of per
  entity result (reports for failing models dropped from GBs to MBs).
- cli: `ifc-lite ids` now uses the canonical `@ifc-lite/ids/bridge`
  accessor (the drifted local copy missed type-inherited property sets),
  reports real progress (`spec 312/848 (37%)` instead of
  `undefined (undefined/undefined)`), and skips retaining passing entity
  results for human-readable output (`--json` is unchanged).

Behavior change (intentional): the CLI's PASS/FAIL verdict and exit code
now come from the validator's per-spec status, which counts
cardinality-only failures — a `minOccurs="1"` specification that matches
zero entities now correctly FAILs (exit 1) where it previously passed
silently. `bim.ids.summarize` likewise prefers the per-spec status when
the report carries one, so `--json` and text mode agree on the verdict.

Measured on the same model + IDS pack: 848 specs 19min→2min, 117 specs
3.4min→12s, both with a clean exit instead of a hang.
