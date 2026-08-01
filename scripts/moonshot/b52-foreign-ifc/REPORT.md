# B5.2 Foreign IFC

**The first bet in this program measured on data the program did not author.**

Instrument 6 says a result that has not survived contact with foreign data is
reported at half strength. This is the run that decides how much of the World
Gym benchmark's result survives.

Nothing under `tools/world-gym/` was modified. Every check below is the
committed function, imported and handed input it was never tuned on:
`heuristicPrediction` and `oraclePrediction` from `benchmark/baselines.mjs`,
`parseStore` / `schemaCheckInProcess` / `clashCheckInProcess` /
`extractQuantityTotals` from `lib/checks.mjs`. The synthetic scores are read
from the committed `benchmark/results/`, never recomputed.

## The two foreign models

Both are real delivered client work, so they are named only by a truncated
sha256 of their bytes, an operator-supplied alias and a coarse authoring-tool
family. Nothing identifying about the project, the firm, the file name or the
filesystem is recorded anywhere in this directory. `lib/model-id.mjs` is the
filter that enforces it, and `build-scorecard.mjs` asserts it again over the
finished artifact before writing it.

The measurements themselves are published exactly. What is excluded is names:
the source file names, any `.ifc` / `.ifcZIP` basename, and authored
person/organisation/storey/site strings. A byte count is evidence; a file name
is an identifier.

| | model-a | model-b |
| --- | --- | --- |
| sha256 prefix | `1eac13348753` | `90ddf9c3403a` |
| schema | IFC4 | IFC4 |
| authoring tool family | IfcOpenShell | Archicad |
| bytes | 75,511,560 | 90,264,955 |
| entities | 1,083,664 | 1,040,356 |
| distinct entity types | 97 | 122 |
| character | structural: beams, slabs, columns | architectural: windows, walls, doors, spaces, furniture |
| meshed elements | 20,809 | 77,290 |
| triangles | 1,027,657 | 1,200,133 |

The synthetic corpus these are being compared against has a median of 649
entities and a maximum of 4,749 over the whole 1,000-model dev split. The
foreign models are 1,669.7x and 1,603.0x the median entity count.

## The delta table

| measure | synthetic dev split | model-a | model-b |
| --- | --- | --- | --- |
| defect-detection macro-F1 | 1 (heuristic-text), 0.857143 (oracle-kernel) | **not scorable** | **not scorable** |
| positive defect verdicts | 1,222 of 14,000 | 3 of 14 | 3 of 14 |
| adjudicated false positives | 0 | 2 | 3 |
| label precision on positives | 100% | **0%** | **0%** |
| `ifc-lite validate` errors | (by construction, per planted defect) | 0 | 0 |
| `ifc-lite validate` warnings | | 0 | 0 |
| clash engine, total clashes | | 0 | 0 |
| quantity agreement | 0.977655 (task score) | 0.993931 mean per element, 0.999431 model total | 0.984277 mean per element, 0.999116 model total |
| benchmark quantity keys predicted | 5 of 5 | **0 of 5** | **0 of 5** |
| openings, non-rectangular | 0 | 317 | 544 |
| openings, diagonal | 0 | 238 | 0 |
| CSG boolean failures | 0 | 0 | 108 |
| silent no-op cuts | 0 | 1 | 39 |
| oracle wall clock | 2.846 ms median | 29,754.1 ms | 16,535.3 ms |
| oracle RSS at pass exit | | 1,106.8 MB | 1,348.8 MB |

Two cells need reading carefully.

*"Not scorable"* is not a dodge. `defect-detection` is macro-F1 against planted
ground truth, and `validity-triage` is a concordance index against planted
severity. A delivered file has no plant time, so neither metric exists for it.
Reporting a number there would be fabricating the truth column. What replaces
them is the per-verdict adjudication below, which is the strongest claim two
files support.

*The synthetic false-positive count of 0* is the committed dev row over 1,000
models (7 defect types x 2 detectors x 1,000 models = 14,000 boolean verdicts,
of which 1,222 are positive and **not one** is a false positive). It was
re-derived in this session over a 200-model deterministic subsample: 0 false
positives again, 0 of 139 clean models firing anything, for either detector.
So the synthetic baseline for this comparison is not merely good, it is exact.

## The answer to the question this bet exists to ask

**Does the defect detector, tuned on a synthetic corpus whose corruptions the
same program authored, produce meaningful signal on real files?**

No, not as specified. Six positive verdicts across the two models. Five are
false positives. The sixth points at something real in the file but names the
wrong defect. Label precision falls from 100% on the corpus to 0% here, and
83.3333% of every positive verdict is an outright false alarm.

It does not *drown* in false positives - the verdict space is only seven
booleans per model, so the absolute count is 2.5 false positives per model, not
thousands. That is the more uncomfortable failure mode: the output stays small
and confident-looking while being wrong.

Two of the seven defect types cannot be right on foreign data, structurally:

- **`missing-quantities` (oracle-kernel)** is computed over quantities re-read
  from a property set *literally named `GymQuantities`*. No file authored
  outside this program carries that name, so `elementsWithQuantities` is 0 on
  every foreign model and the verdict fires whenever the model has more
  quantifiable elements than unmeshed columns. It fired on both models, which
  in fact carry authored `IfcElementQuantity` on 99.0507% and 98.892% of their
  quantifiable elements.
- **`clash-pair` (heuristic-text)** is `IFCFOOTING count > 0`. The corpus emits
  footings *only* as an injected defect, so the rule is perfect there and
  unconditional on any real building with foundations. Model-b has 16 footings
  and 0 footing self-clashes by the clash engine.

A third type, **`dangling-ref`**, is hardcoded to `false` in `oraclePrediction`.
See the instrument finding below - that concession is now wrong.

The one non-trivial signal that did cross over came from geometry, and it
crossed over mislabelled. `degenerate-geometry` fired on model-a because 29 of
its 2,597 IfcColumns produced no mesh. All 29 declare a Representation, but the
entire set of representations they declare is `Axis/MappedRepresentation` - no
Body at all. The kernel is right to produce nothing, the file really does ship
1.1167% of its columns without solid geometry, and that is worth knowing. It is
not, however, the planted defect the label names (a zero-depth extrusion). It is
recorded as `true-signal-wrong-label`, in its own class, because folding it into
either bucket would overstate the result in one direction or the other.

## Per-verdict adjudication

Every positive verdict, with the artifact field that decides it. Any single row
can be overturned by a reviewer without re-running anything.

| model | detector | defect | verdict | why |
| --- | --- | --- | --- | --- |
| model-a | heuristic-text | `missing-quantities` | false positive | The baseline's `IfcRelDefinesByProperties` regex matched **0 of 104,409** relationship lines in this exporter's formatting, so every quantity set looked unbound. All 15,872 element quantity sets are in fact bound; 0 are orphans. |
| model-a | oracle-kernel | `missing-quantities` | false positive | `GymQuantities` coverage 0 against authored coverage 99.0507%. |
| model-a | oracle-kernel | `degenerate-geometry` | true signal, wrong label | 29 of 2,597 columns unmeshed; all declare only `Axis/MappedRepresentation`. |
| model-b | heuristic-text | `clash-pair` | false positive | 16 footings exist; the clash engine finds 0 footing self-clashes and 0 clashes of any kind. |
| model-b | heuristic-text | `duplicate-globalid` | false positive | 1 duplicate group, 725 entities, **all** `IFCPROPERTYSINGLEVALUE` - a repeated property *name* on a non-rooted entity, not a GlobalId. The kernel reports 0 duplicate-GlobalId errors and is right. |
| model-b | oracle-kernel | `missing-quantities` | false positive | `GymQuantities` coverage 0 against authored coverage 98.892%. |

The model-a heuristic failure has a detail worth keeping. The same regex matched
**100%** of model-b's 48,559 relationship lines. Whether the `heuristic-text`
baseline - the one that scores a perfect 1 on the corpus - reports a quantity
defect on a real file is decided entirely by which exporter wrote the line
breaks.

## What did work: the kernel checks themselves

The benchmark's *verdict mapping* is what fails on foreign data. The kernel
underneath it does not.

- `ifc-lite validate` ran clean on both models through the shipped CLI:
  0 errors, 0 warnings, exit code 0, in 2,100.2 ms and 1,920.1 ms wall,
  reporting 1,083,664 and 1,040,356 entities. The only issues raised are
  informational (`quantity-completeness` on both, `named-elements` on model-b).
  No dangling references, no duplicate GlobalIds, no missing spatial entities.
- `ifc-lite clash --matrix` ran clean on both: 0 clashes, 29,051.8 ms and
  16,496.7 ms.
- Nothing crashed, nothing ran out of memory, no check needed a special flag.
  RSS at the end of the oracle pass was 1,106.8 MB and 1,348.8 MB against 16 GB
  of machine memory. Nothing samples RSS during the parse or geometry stage, so
  that is a reading at exit and not a high-water mark; it bounds nothing from
  below except itself.

## Quantity estimation, the one task that transfers

The benchmark's quantity task cannot run on foreign data, because it predicts
five totals over the `GymQuantities` vocabulary. Both detectors predicted 0 of 5
keys on both models, which under the benchmark's own formula would score 0.

But a real file carries something the corpus does not: quantities *someone else
authored*. Model-a labels 15,443 quantity sets, all under the standard name
`BaseQuantities`; model-b labels 9,818 across 10 standard `Qto_*BaseQuantities`
sets. That is a genuine external reference, so the substitute measurement is:
authored `NetVolume` as truth, the volume of the mesh ifc-lite's geometry kernel
produced for the same element as prediction, scored with the identical
`score.mjs` expression `max(0, 1 - |pred - truth| / truth)`.

| | model-a | model-b |
| --- | --- | --- |
| paired elements | 15,409 | 2,387 |
| mean per-element score | 0.993931 | 0.984277 |
| median per-element score | 0.999999 | 1 |
| within 1% | 96.3658% | 97.3607% |
| within 5% | 97.0277% | 97.7377% |
| model-total score | 0.999431 | 0.999116 |
| elements scoring exactly 0 | 0 | 23 |

Both beat the committed synthetic quantity-estimation score of 0.977655, by
0.016276 and 0.006622 on the per-element mean.

That comparison flatters nothing, because the foreign version is the *harder*
measurement. On the corpus, the quantity task compares numbers the generator
embedded against the same numbers the generator computed - a round trip of
literals through a file, with no geometry in the loop. Here the geometry kernel
has to reproduce, from a boolean-cut triangle mesh, a volume an unrelated
authoring tool computed from its own solid model, and it lands inside 1% on
about 96% of elements. This is the single result in this bet that transfers
intact.

Caveats on this number, all emitted in `results/qto-model-*.json`: the model
total is taken over the paired subset only, because charging the kernel for
elements it was never handed would be measuring mesh coverage instead; mesh
coverage is reported separately per element group and is 100% for model-a's
walls, slabs and beams but 22.7181% for model-b's slabs and 2.7431% for its
members, where the body geometry lives on `IfcBuildingElementPart` children
instead (3,209 and 4,093 of them, every one of which meshed).

## What the corpus never exercises

The sharpest finding in this bet is not a score. It is the geometry kernel's own
typed diagnostics contract, which no benchmark task consumes.

| | synthetic (200 models) | model-a | model-b |
| --- | --- | --- | --- |
| openings classified | 848 | 674 | 2,252 |
| rectangular | 848 | 119 | 1,708 |
| diagonal | 0 | 238 | 0 |
| non-rectangular | 0 | 317 | 544 |
| openings cut by the `rect_fast` path | 848 | 111 | 0 |
| `rect_fast` deferrals | 0 | 30 | 552 |
| CSG boolean failures | 0 | 0 | 108 |
| silent no-op cuts | 0 | 1 | 39 |

100% of the corpus's openings are rectangular through-cuts on box hosts, and the
`rect_fast` fast path takes every single one of them, with zero deferrals. The
general CSG path - the exact-arithmetic boolean kernel that is the most
expensive and most failure-prone thing ifc-lite owns - **is never entered by the
benchmark at all**. Every foreign failure lives there: model-b's 108 failures
are all `OperandTooLarge`, concentrated on 2 `IfcBuildingElementPart` hosts
carrying 91 and 17 openings each.

A benchmark that cannot enter the code path where the failures are is not
measuring that code path. That is a bigger result than the score delta.

## Two findings about the instrument

**1. `oracle-kernel`'s conceded gap no longer exists, and both anchors now
saturate.** `baselines.mjs` hardcodes `dangling-ref: false` with the comment
"The kernel's validate has no reference-integrity rule", and pays 94 false
negatives and an F1 of 0 for it - which is the whole reason the oracle scores
0.857143 rather than 1 and the leaderboard can describe its upper bound as
"deliberately not perfect". `computeValidationIssues` in `packages/cli` *does*
have a `reference-integrity` rule. Asked directly, on the corpus's own planted
dangling references, it fires on 17 of 17 - 100%. Wiring the existing rule in
would take `oracle-kernel` to 1 on defect-detection, level with `heuristic-text`,
at which point **both** leaderboard anchors saturate the task and the benchmark's
headline metric has no headroom left to measure anything with. Not fixed here:
changing the instrument to fit the input is exactly what this bet must not do.

**2. A regex baseline with no kernel scores a perfect 1 on the corpus.** That was
already visible in the committed leaderboard - `heuristic-text` beats
`oracle-kernel` on aggregate, 0.992552 to 0.931312 - and it is usually read as
"the corpus's corruptions are pattern-matchable". Foreign data sharpens it into
something worse: the same baseline's verdicts on real files are decided by
exporter line formatting (0% versus 100% regex coverage on the two models) and by
the presence of ordinary building elements (`IFCFOOTING > 0`). It is not a weak
detector that generalizes poorly. It is a corpus-artifact detector.

## Cost and scale

| | synthetic median | model-a | model-b |
| --- | --- | --- | --- |
| entities | 649 | 1,083,664 | 1,040,356 |
| file bytes | 33,134.5 | 75,511,560 | 90,264,955 |
| `oracle-kernel` wall clock | 2.846 ms | 29,754.1 ms | 16,535.3 ms |
| `heuristic-text` wall clock | 0.305 ms | 565.6 ms | 527.4 ms |
| oracle microseconds per entity | 4.385 | 27.457 | 15.894 |

The instrument scales, but not linearly: 1,669.7x the entities cost 10,454.7x
the time on model-a, i.e. 6.3x worse per entity. Model-b is 15.894 microseconds
per entity against the synthetic 4.385, 3.6x worse. The gap is geometry - a
corpus model is a handful of box extrusions with rectangular through-cuts, and
per-entity cost is dominated by the meshing and boolean work that the corpus
barely has.

<!-- numeral-ok: 6.3x, 3.6x :: the two per-entity cost ratios, computed in the
     sentence from scale.foreign[].oracleUsPerEntity (27.457 and 15.894) over
     scale.syntheticOracleUsPerEntity (4.385). Emitting them would mean adding
     a derived field whose only consumer is this sentence; the inputs are all
     backed and the division is stated. -->

## What could not be measured, and why

1. **`defect-detection` as macro-F1, and `validity-triage` at all.** Both score
   against plant-time ground truth. A delivered file has none. The per-verdict
   adjudication replaces the first; nothing replaces the second, and no triage
   number is reported.
2. **The benchmark's `roomNetFloorArea` key.** The kernel geometry output has no
   mesh-side floor-area estimator, so the fifth quantity key is left unmeasured
   rather than approximated with something invented for this document.
3. **Anything with a sample size.** Two models is a case study. The only variance
   estimate in this bet is the spread between model-a and model-b, and on the
   central question they disagree on which types misfire while agreeing on the
   conclusion.
4. **The plan's Revit-or-Tekla clause.** B5.2 as written asks for "at least one
   file exported from Revit or Tekla that nobody in this program has seen".
   Neither model is one; they are IfcOpenShell and Archicad. That clause of the
   exam is **not satisfied** by this run.
5. **`tests/models` and the IfcOpenShell parity corpus**, also named in the bet,
   were not run here. This run is the two large delivered files only.
6. **Root cause of model-b's 108 CSG failures.** They are counted, classified
   (`OperandTooLarge`) and localized to 2 hosts. Fixing or explaining them is a
   geometry bet, not this one.

## Caveats

- The adjudication table is a judgement. It is encoded as data in
  `scorecard.json` with the deciding artifact field on every row, so it can be
  audited or overturned line by line, but it is not a measurement.
- Mesh volume assumes each submesh is a closed solid. Both aggregations
  (sum-of-absolute and absolute-of-sum) were computed and disagree on 0 of
  model-a's elements and 2 of model-b's, so the assumption holds here; it is not
  guaranteed to hold on another file.
- The synthetic per-model timings are a 200-model deterministic subsample of the
  dev split measured in this session, not the committed run. The committed
  *scores* are quoted unchanged and were not recomputed.
- Both foreign models are IFC4. Nothing here says anything about IFC2X3 or
  IFC4X3 input.
- The `Unknown` entries in the unmeshed-column representation-item histogram are
  mapped-representation targets the probe did not follow; the
  `Axis/MappedRepresentation` identifier is what carries the conclusion, and it
  is unambiguous.
- Every figure in this document emits from `scorecard.json` or from
  `results/*.json`.
- `results/*.json` is the record of a single run against files that are not in
  this repository and cannot be re-run from it. So three fields added to the
  pass scripts after that run (`meshes.nonFiniteMeshVolumes` in the QTO pass,
  plus `distinctAuthoredQsetNames` and `distinctAuthoredQuantityNames` in the
  kernel pass) are absent from the committed artifacts rather than filled in
  with a value nobody measured.
- The synthetic anchor's `entityCount` and `fileBytes` medians were re-derived
  with the corrected even-length rule (the mean of the two middle values of
  200, not the upper one) and verified against a regeneration of the same
  seeds. Its two wall-clock medians could not be: the timing arrays belong to a
  session that cannot be re-timed, so they remain the pre-fix upper-middle
  value, as `results/synthetic-anchor-dev.json` records.

## Reproducing

The models are never copied into the repository. Each script takes the path at
run time and reads it in place.

```shell
node scripts/moonshot/b52-foreign-ifc/run-text-pass.mjs         --model <path> --alias model-a --tool ifcopenshell --out <dir>
node scripts/moonshot/b52-foreign-ifc/run-kernel-pass.mjs       --model <path> --alias model-a --out <dir>
node scripts/moonshot/b52-foreign-ifc/run-oracle-pass.mjs       --model <path> --alias model-a --out <dir>
node scripts/moonshot/b52-foreign-ifc/run-qto-pass.mjs          --model <path> --alias model-a --out <dir>
node scripts/moonshot/b52-foreign-ifc/run-diagnostics-pass.mjs  --model <path> --alias model-a --out <dir>
node scripts/moonshot/b52-foreign-ifc/run-adjudication-pass.mjs --model <path> --alias model-a --out <dir>
node scripts/moonshot/b52-foreign-ifc/run-cli-pass.mjs          --model <path> --alias model-a --out <dir>
node scripts/moonshot/b52-foreign-ifc/run-synthetic-anchor.mjs  --split dev --sample 200 --out <dir>
node scripts/moonshot/b52-foreign-ifc/run-diagnostics-pass.mjs  --synthetic --sample 200 --out <dir>
node scripts/moonshot/b52-foreign-ifc/build-scorecard.mjs --runs <dir>
```

`build-scorecard.mjs` writes nothing until its identifier guard has passed over
the scorecard and over every pass artifact it copies. The guard rejects model
and CAD file names, filesystem paths, and authored map keys outside a closed
vocabulary, all by shape. For the names shape cannot know - the client, the
firm, the project, the source file names - pass them at run time with
`--forbid <name>` (repeatable) or `--forbid-file <path>`, read from outside
this repository. Nothing about a measurement is rejected: exact byte counts,
entity counts and histograms are the evidence this bet exists to publish.

The passes that touch geometry need `--max-old-space-size=10240` at this file
size, and the workspace must be built (`pnpm build` plus staged WASM).
