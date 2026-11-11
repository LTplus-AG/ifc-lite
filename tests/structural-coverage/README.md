# Structural coverage harness

The ruler for the structural domain hill climb ([#9668](https://github.com/LTplus-AG/ifc-lite/issues/9668)): how much of the IFC structural
analysis domain ifc-lite reads, shows, authors and converts. The generated
ledger is `docs/architecture/structural-coverage-ledger.md`.

```bash
node tests/structural-coverage/score.mjs --check tests/structural-coverage/baseline/r1.json
```

This writes `tests/structural-coverage/.out/summary.json` and exits 1 if
anything dropped below the baseline. It needs the corpus on disk. Before
importing packages, the scorer runs
`pnpm turbo build --filter=@ifc-lite/parser... --filter=@ifc-lite/create... --filter=@ifc-lite/export...`
so Turbo rebuilds or restores outputs that match the source. A failed build is
a harness error, never a product score. Without wasm-pack, `build-wasm.sh`
keeps the wasm runtime already on disk, so scoring a Rust change needs the
wasm toolchain. The probes run in about two seconds after building.

CI runs the ratchet against the frozen `r1.json` in the shared **Build packages +
WASM** job, after fixture verification and the package build. This job runs in
both fast and full PR lanes for package, harness and manifest changes, and in
merge-queue batches. The ledger check alone does not run the product probes.

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
checks every record of the row's entity in the intermediate file against that
schema's typed registry (the parser's generated `SchemaRegistry`): the entity
exists, the attribute count matches, a required slot is not `$`, a reference
resolves to an entity the slot admits, a typed value sits only in a SELECT with
value members, and a bare value only in a defined-type, enum or primitive slot.
A file that fails gets no credit for the row. Not checked yet, so a convert pass
can still overstate (tracked on #9668): aggregate shape and bounds (a
scalar in a LIST slot), the kind of a bare value (an enum in a REAL slot), `*`
outside derived slots, which select member a typed value is, enum values, and
records of other entities. The registry is
generated from the same EXPRESS as the product uses, so a codegen error there
would be shared by the oracle and the converter.

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

## Harness correction baseline

`r0.json` is retained as the original measurement. [R1 measurement notes](baseline/r1-notes.md) list every changed cell and the per-fixture link counts. `r1.json` corrects two
under-credits without changing product code: physical links are verified by
resolving every `physicalElementIds` express id in the parsed store to an
IfcElement subtype and comparing its GlobalId to the fixture relationship
(an id the file does not link to that item fails the link);
rooted fields try the exact EXPRESS name before camelCase and renamed fields,
with the same fixture-value comparison. Link evidence records checked/held
counts for every fixture, without the former 25-link sampling limit.

To freeze a reviewed correction, run the scorer against the previous baseline,
review every changed cell, copy `.out/summary.json` to `baseline/r<N>.json`,
update the frozen CI/README baseline path, and regenerate the ledger. Keep old
baseline files. `r1` here is a measurement revision, not a product climb round.

## Registering a probe

1. Write `probes/<name>.mjs` exporting `{ name, level, covers?(row), async run(rows, ctx) }`, where `run` returns a `Map` of row id to `{ status, reason?, evidence? }`.
2. Import it in `probes/index.mjs`, add it to `PROBES` and delete the `unwritten(...)` placeholder for that level.
3. Run the scorer with `--check`, then copy the summary to `baseline/r<N>.json` and run `node scripts/generate-structural-coverage-ledger.mjs`.

A new in-store builder needs no new probe: add a step to `SCENE` in
`probes/create-scene.mjs` naming the entities it emits and the values to expect.
