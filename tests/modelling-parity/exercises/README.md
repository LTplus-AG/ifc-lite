# Headless exercise ladder (#9296, lane L2)

Run from the repository root with Node 24 and pnpm 10. Build the real CLI first,
under the fleet admission policy:

```sh
~/build-workers/ifc-fleet run --route local --cwd "$PWD" -- bash -lc 'pnpm install --frozen-lockfile && pnpm build:wasm:fetch && pnpm turbo build --filter=@ifc-lite/cli...'
```

Exit status zero means the result files were emitted; exercise failures remain
explicit structured statuses so the full ladder can continue.

Each entry point writes contract results to `PARITY_OUT/Fn/results.json` and
`results.jsonl` (default `tests/modelling-parity/.out/L2`). Raw SDK steps are
checkpointed after every synchronous operation. Generated IFCs, GLBs, bounds,
validation reports and reopened levels are disposable evidence, not source.

```sh
node tests/modelling-parity/exercises/f1.mjs
node tests/modelling-parity/exercises/f2.mjs
node tests/modelling-parity/exercises/f3.mjs
node tests/modelling-parity/exercises/f4.mjs
node tests/modelling-parity/exercises/f5.mjs --floors 10 --budget-s 900
node tests/modelling-parity/exercises/f5.mjs --floors 40 --budget-s 900
node tests/modelling-parity/exercises/f6.mjs
pnpm parity:exercises
```

Use admission for the full ladder and tall exercises. The `ms` metrics are
shared-host diagnostics, not qualified performance comparisons. `--budget-s`
bounds the entire exercise, including validation subprocesses, with a parent
watchdog that kills only its own child even when the SDK blocks synchronously.
The default is 900 seconds. Timeout results include elapsed time, completed
steps and last sampled element/heap counts (the mutation counter is a lower
bound at interruption; hosted descendants may be cloned implicitly). Heap is sampled between SDK actions;
transient allocations inside a blocked action can exceed this lower bound.
`--floors` must be a positive integer. F5 defaults to 40 floors, a 36×36 m plate,
7×7 grid and 40 columns per floor outside the core. F4 is 24×18 m and six floors.

F6 defaults to the manifest fixture `ara3d/AC20-FZK-Haus.ifc` (Archicad), available
through `pnpm fixtures`; an offline corpus copy can be restored to that path.
It never substitutes a synthetic model. `--fixture /absolute/path.ifc` selects
another offline fixture; its SHA256 is recorded. Missing input is a failure.
F3 is deliberately skipped with `deferred to R1` by the parent’s R0 scope update. Skip never counts as pass.

F1 makes a 5×4 m room, hosted door/window, slab and space. F2 rebuilds the
12×10 m FZK-Haus with occupied levels at 0 and 2.7 m, nine/four walls,
five ground-floor doors, nine/two windows, six/one named spaces, four beams
and one stair. Its 30° gable-roof request is inspected in the exported geometry.
The exact target from PR #9304 (head 70e17347d135456bfec0d7be7361adee5bc383d8)
is pinned as `f2-fzk-haus.target`; its historical note about the old brief is
superseded by the parent’s updated contract. No dependency on that PR merging.
The floor-height edit is reversed to preserve the final reference elevations.
The internal partition layout is approximate: the target supplies counts,
lengths and room areas, not a full plan. Target comparisons include per-level
counts, opening size histograms, mesh wall extents, footprint, named mesh/quantity
space areas, roof form, slope and upward area, using the target tolerances.
Missing geometry or unsupported gable authoring fails explicitly.
F4/F5 copy a typical structural floor with core, stair, four curtain facades and
a real shaft opening, then raise the lobby to 6 m. Vertical GLB rays check the
shaft and adjacent solid floor on the original slab and its copies.

The oracles inspect real exports:

- F1 exported NetFloorArea must be 20 m²; F2 uses the seven named reference areas.
- Every storey elevation after the edit is checked, then checked again after
  reopening each schema through the CLI/SDK.
- IFC4 and IFC2X3 are parsed by `ifc-lite validate --json`. Only zero errors and
  a nonempty parsed store are a pass. This is the repository validator, not
  buildingSMART/IfcOpenShell EXPRESS validation.
- GLB export uses the public `GeometryProcessor` with metadata enabled. The
  CLI's normal GLB export omits IDs. The reader composes node matrices and
  translations, reads actual POSITION/index buffers, and combines assembly
  children using exported IfcRelAggregates. Unsupported TRS fails explicitly.
- Bounds use GLB Y-up heights, with 6 cm tolerance. Walls must reach the next
  floor; columns and curtain walls must span the raised lobby. Stair checks
  allow a first riser above zero and require the top landing to reach the floor.
- A ray through a hosted door must miss the wall mesh, while an adjacent ray
  must hit. This checks the cut, not merely an opening relationship.
- Copied wall attachment property references must target their own next level
  or the relative `NextStoreyAbove` constraint. This distinguishes successful
  copying from correct rebinding. Copied bounds are also checked when typed
  expectations were recorded by the authoring run.
- Base quantities must be linked through IfcRelDefinesByProperties to each
  checked geometry element; unrelated space quantities cannot earn a pass.
- F6 compares before/after wall bounds for a one-metre horizontal move, then
  checks reopened storeys and valid exports. An axis-aligned existing host also gets independent door-centre/adjacent
  wall rays; rotated hosts report partial rather than an assumed cut pass.

SDK operation passes mean the call completed, not that its geometric feature
passed; separate oracle results decide correctness. A summary records successful
steps, total steps, elapsed milliseconds, exported contained-product count and sampled
peak heap. A timed-out exercise summary fails; completed exercises with oracle
failures are partial.

`--reuse` rechecks existing exported authoring evidence without replaying costly
mutations. It is intended for oracle development, not performance measurement;
summary time then reports the original authoring time. Source commit/dirty state
identify the checker invocation. `baseline/r0.json` contains compact contract
results against main's product code at a6e0a577f8; no product code is changed.
Helper invariants and the real deadline smoke test run with
`node --test tests/modelling-parity/exercises/*.test.mjs`.

Run `PARITY_BASELINE=path pnpm parity:exercises` to capture a fresh full baseline.
