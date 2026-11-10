# Structural coverage harness

The ruler for the structural domain hill climb: how much of the IFC structural
analysis domain ifc-lite reads, shows, authors and converts. The generated
ledger is `docs/architecture/structural-coverage-ledger.md`.

```bash
node tests/structural-coverage/score.mjs --check tests/structural-coverage/baseline/r0.json
```

This writes `tests/structural-coverage/.out/summary.json` and exits 1 if
anything dropped below the baseline. It needs built packages
(`pnpm turbo build --filter=@ifc-lite/parser... --filter=@ifc-lite/create... --filter=@ifc-lite/export...`)
and the corpus on disk. It runs in about two seconds.

## Rows

`catalogue.mjs` derives one row per concrete entity per schema (IFC2X3, IFC4,
IFC4X3) from the generated tables in `packages/data/src/ifc-schema/generated/`:
every entity whose inheritance reaches a root in `DOMAIN` (IfcStructuralItem,
IfcStructuralActivity, the load and result groups, the analysis model, the
IfcStructuralLoad, IfcBoundaryCondition and IfcStructuralConnectionCondition
resources, IfcConnectionPointEccentricity and the three structural
relationships). Nobody types an entity name. `CAPABILITIES` adds nine rows that
are not entity types (the physical-to-analytical link, the toggle, deriving the
model, four checks, the CLI command, the docs page).

## Levels

| Level | Probe | Passes when |
|---|---|---|
| fixture | `probes/fixture.mjs` | a corpus file declaring the row's schema carries the entity |
| read | `probes/read.mjs` | `extractStructuralOnDemand` returns every sampled record with each own attribute's value equal to the file's; a value the read model has no field for makes the row partial |
| card | not written yet | the viewer properties card shows it |
| render | not written yet | a mesh or glyph is drawn |
| create | `probes/create.mjs` + `create-scene.mjs` | an in-store builder authors it in a blank model of the row's schema, and the STEP export declares that schema, re-parses and carries the given values |
| edit, remove | not written yet | in-store update and removal with sub-graph ownership |
| convert | `probes/convert.mjs` | it survives IFC4 -> IFC2X3 -> IFC4 (or IFC2X3 -> IFC4 -> IFC2X3) with the same values |
| capability | `probes/capabilities.mjs` | per capability row; the link read and the docs page have probes, the rest are not written yet |

Not-applicable cells come only from `notApplicable()` in `catalogue.mjs`, by
family or schema: only items and activities render, relationships have no card
of their own, IFC4X3 rows have no convert level (the hop under test is
IFC4 <-> IFC2X3), and each kind of row uses its own levels. An entity the other
schema lacks keeps its convert level, so the cell shows what the converter does
with it: maps it, refuses the file, or copies it through unconverted. The probe
reports any record in the intermediate file that does not conform to that
schema and gives that file no credit.

## Scoring and the ratchet

A cell earns 1 for pass, 0.5 for partial, 0 for fail, error, skip or a probe not
written yet. A row is met when every applicable cell passes (1), partial when
any cell earns (0.5), missing otherwise. The summary reports `total` (rows),
`cells` and per-level totals. An empty catalogue or denominator is refused.
`--check` fails when the total, the cell score, any row or any cell is below the
baseline, when rows were added or removed, or when the run is offline. The
output is byte-identical between runs on the same tree.

## Fixtures

The corpus is `corpus.json`: paths in `tests/models/manifest.json`, checked by
SHA-256 before use. Following `tests/models/README.md`, a missing or stale file
never passes quietly: the scorer exits 2 and prints the
`node scripts/fixtures/fetch-fixtures.mjs <paths>` command. `--offline` scores
the affected cells as skip instead and marks the summary offline, which
`--check` and the ledger both refuse.

## Registering a probe

1. Write `probes/<name>.mjs` exporting `{ name, level, covers?(row), async run(rows, ctx) }`, where `run` returns a `Map` of row id to `{ status, reason?, evidence? }`.
2. Import it in `probes/index.mjs`, add it to `PROBES` and delete the `unwritten(...)` placeholder for that level.
3. Run the scorer with `--check`, then copy the summary to `baseline/r<N>.json` and run `node scripts/generate-structural-coverage-ledger.mjs`.

A new in-store builder needs no new probe: add a step to `SCENE` in
`probes/create-scene.mjs` naming the entities it emits and the values to expect.
