# Type quantity sets: corrections and cost (#7542)

IDS now reads the quantity sets a type object holds, and an occurrence inherits them. Review of
b00f7dd7f found three things, which the next commit fixes:

1. A correction to an inherited entry with its own `Unit` was converted into that unit. The viewer
   then writes it on the occurrence with no unit. So the session passed and the exported file was
   off by the unit's factor. The same held on `main` for an inherited property, since #7395.
2. The per-store memo of a type's quantity sets also kept an empty entry for every entity with no
   set at all, since such an entity reaches the direct type-object read.
3. The changeset left out some behaviour changes.

This folder holds the scripts behind the PR's claims, their outputs, and how to run them.

## The rule for the unit of a correction

The viewer makes an IDS correction with `propertyValueToRaw`, then writes it through
`MutablePropertyView.setProperty` with no unit. The view edits in place a property that the
entity's own property sets hold, and keeps its `Unit`. For any other entry the view has nothing
to edit, so it writes a new property with no unit. So a correction to such an entry is now written
and read back in the entity's project unit, whatever its own `Unit`. These entries are:

- every quantity: the occurrence's own, an inherited one, and a type object's own;
- every entry the occurrence inherits from its type.

A property the entity holds in its own property set keeps its own `Unit` (#7395). The view edits
it in place and keeps that `Unit`. `StepExporter` then loses it on export: `findUnitId` maps a
unit name back only to a length unit in the project's own `IfcUnitAssignment`. A millimetre
`Unit` in a metre project is not there, so the exporter writes `$`. That is an exporter defect,
outside this change (scenarios F and G below).

## Builds

Three builds of `@ifc-lite/ids`, the same tree except for `src/bridge/properties.ts` and
`src/bridge/property-overlay-resolver.ts`:

- `main`: both files from the merge base 9b05d9374. `upstream/main` (fb5642432 when this was run)
  has the same two files. Under `packages/ids` it changed only `src/facets` since the merge base.
  Nothing under `parser`, `data`, `encoding`, `regex-guard`, `codegen`, `mutations` or `export`
  changed.
- `b00f7dd7f`: both files from b00f7dd7f, the head qualified in #7542.
- `head`: this commit.

They are copies of `packages/ids/dist` inside `packages/ids`, so their imports resolve. The copies
are not tracked: delete them before running the repository's checks.

Build `@ifc-lite/ids`, `@ifc-lite/mutations`, `@ifc-lite/export` and their dependencies first.
Then, from the repository root:

```sh
cd packages/ids && mkdir -p .evidence-builds
pnpm run build && cp -r dist .evidence-builds/head
for f in properties property-overlay-resolver; do git show b00f7dd7f:packages/ids/src/bridge/$f.ts > src/bridge/$f.ts; done
pnpm run build && cp -r dist .evidence-builds/b00f7dd7f
for f in properties property-overlay-resolver; do git show 9b05d9374:packages/ids/src/bridge/$f.ts > src/bridge/$f.ts; done
pnpm run build && cp -r dist .evidence-builds/main
git checkout -- src/bridge && pnpm run build && cd ../..
B="packages/ids/.evidence-builds/main packages/ids/.evidence-builds/b00f7dd7f packages/ids/.evidence-builds/head"
node docs/architecture/evidence/7542-type-quantity-sets/correction-round-trip.mjs $B
node docs/architecture/evidence/7542-type-quantity-sets/correction-paths.mjs $B
node --max-old-space-size=16000 docs/architecture/evidence/7542-type-quantity-sets/acceptance-sweep.mjs $B
node docs/architecture/evidence/7542-type-quantity-sets/run-timings.mjs $B
rm -rf packages/ids/.evidence-builds
```

## Fixtures

Every model is generated inside its script; no model file is read. All are IFC4 STEP text, parsed
with `IfcParser.parseColumnar` (this checkout's `packages/parser/dist`) and read through each
build's `createDataAccessor`. `@ifc-lite/parser`, `data`, `mutations` and `export` are this
checkout's dists, shared by every build.

- `correction-round-trip.mjs` and `correction-paths.mjs`: four walls and a wall type, in a metre
  project unless a case says millimetre. The type holds `Qto_WallBaseQuantities.Length` 5000 and
  `Pset_TypeOwnUnit.Width` 200. The width has a millimetre `Unit`; the length has one where a case
  says so. W1, W2 and W3 are typed by the type:
  - W1 holds no set of its own.
  - W2 holds its own `Qto_WallBaseQuantities` with `Width` 0.2 only.
  - W3 holds `Pset_Own.Span` 5000 with a millimetre `Unit`.
  - W4 is not typed. It holds its own `Qto_WallBaseQuantities.Height` 3000 with a millimetre
    `Unit`.
- `acceptance-sweep.mjs`: every `.ifc` file the repository tracks of at most 5 MB, read from the
  checkout (398 of 399; the one left out is 30 MB). Also 8 generated models with shapes a type's
  quantity sets can take:
  - a type whose quantity and property sets have millimetre `Unit`s, in a metre project;
  - a type that also has a set attached through `IfcRelDefinesByProperties`;
  - an `IfcTaskType`, and an IFC2X3 `IfcDoorStyle`;
  - broken references in the type's sets;
  - a type whose `HasPropertySets` is `$`, beside one whose quantity set has no name;
  - a wall typed twice;
  - a millimetre project.
- `setless-sweep.mjs`: 50,000 walls over 10 wall types; each type holds `Qto_WallBaseQuantities`.
  Each wall has an `IfcLocalPlacement`, an `IfcAxis2Placement3D` and an `IfcCartesianPoint`, which
  hold no set (150,000 entities).
- `parsed-model-cost.mjs`: 50,000 walls over 10 wall types. Each type holds
  `Qto_WallBaseQuantities` (9 quantities) and `Pset_WallCommon`. Every 7th wall holds its own
  `Qto_WallBaseQuantities` with `Length` 9.5 only. Two variants: the types hold no quantity set,
  and every wall holds its own full set with its type's values. 15 specifications.

## Results

Windows 11, Intel Core i9-13900KF, 64 GB, Node 22.20.0, pnpm 10.8.1. The `.txt` beside each
script holds its output; the parser's notes on stderr ("No storeys", "No buildings") are left out.

### Corrections

`correction-round-trip.txt` makes each correction the way `IDSCorrectionDialog.tsx` makes it:

1. `propertyValueToRaw`;
2. `MutablePropertyView.setProperty` with no unit, on a view configured as
   `configureMutationView.ts` does;
3. what the view then holds for that set: a set it created ("new"), or one of the entity's own
   sets it edited ("edited"), each item with its unit;
4. the session, read through the overlay projected from the view as
   `property-overlay-snapshot.ts` does;
5. the export through `StepExporter`, parsed again and checked with the same build.

Each cell below: the raw value; the session; parsed again.

| Scenario | `main` | `b00f7dd7f` | `head` |
|---|---|---|---|
| A. Inherited quantity with its own mm `Unit`, metre project: `Length` to 6 | 6; pass; 6, pass | 6000; pass; 6000, fail | 6; pass; 6, pass |
| B. Inherited property with its own mm `Unit`: `Width` to 0.3 | 300; pass; 300, fail | 300; pass; 300, fail | 0.3; pass; 0.3, pass |
| C. Inherited quantity, no own `Unit`, mm project: `Length` to 6 | 6000; pass; 6, pass | 6000; pass; 6, pass | 6000; pass; 6, pass |
| D. As A, on W2, which holds its own `Qto_WallBaseQuantities` | 6; pass; fail | 6000; pass; fail | 6; pass; fail |
| E. The type checked directly, its quantity with its own mm `Unit`: `Length` to 6 | 6; pass; 6, pass | 6000; pass; 6000, fail | 6; pass; 6, pass |
| F. W3's own property with its own mm `Unit` (#7395): `Span` to 6 | 6000; pass; 6000, fail | the same | the same |
| G. The type checked directly, its own property with its own mm `Unit`: `Width` to 0.3 | 300; pass; 300, fail | the same | the same |
| H. W4's own quantity with its own mm `Unit`: `Height` to 4 | 4000; pass; 4000 beside 3, fail | the same | 4; pass; 4 beside 3, fail |

- On `main`, A and E pass only because `main` does not see the quantity. The correction creates
  a property, in the project unit.
- In D and H the view writes the correction into a new property set beside the wall's quantity
  set. IDS then sees two sets of that name on every build, and one of them fails. In D on `main`
  the quantity set lacks `Length`; on `b00f7dd7f` and `head` it holds the type's `Length` 5. In H
  the quantity set still holds `Height` 3. The value written in H is right only on `head`.
- In F and G the view edits the property in place and keeps its millimetre `Unit` ("edited
  {Span=6000 unit mm}"). `StepExporter` writes `$` for that `Unit`, so the value comes back 1000
  times off on every build. The cause is `findUnitId`, as the rule above says.

`correction-paths.txt` runs each correction claim of the changeset through `propertyValueToRaw`
and `createDataAccessor` with an overlay, on the three builds, without an export.

### Acceptance

`acceptance-sweep.txt` calls `getPropertySets`, `propertyValueToRaw` and an overlay on every
entity of every model, five ids no entity has included, and compares each build with `head`:

- On the 398 tracked files (66,659 ids, 606,213 `propertyValueToRaw` calls per build), the three
  builds give identical results, and nothing throws.
- On the 8 generated models nothing throws on any build. The builds differ only where a type
  holds a quantity set, and in the unit of a correction this change sets.

The script caps the work on a model with more than 20,000 ids. There `propertyValueToRaw` and the
overlay cover only the missing entry and the first two entries of each entity. One swept model is
over the cap: `apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc`, with 44,254 of the 66,659 ids.
`getPropertySets` without an overlay still runs on each of its ids.

### Timings

`run-timings.mjs` runs every timing below and writes their `.txt` files. Before and after each
run it samples the CPU load of all cores five times, 200 ms apart. On Windows that is
`Win32_Processor.LoadPercentage` through PowerShell. Before each run it waits, up to 5 minutes,
until no sample is over 10%. A run with a sample over 10% before or after it is marked "busy, not
used" and run again, at most 3 attempts. The tables use only runs marked "used". The ms values
are compared only within one run, against `main` in that run.

Machine: Intel Core i9-13900KF (24 cores, 32 threads), Windows 11, Node 22.20.0, the High
performance power plan. It was not idle, and no job was stopped. Other sessions ran shell and git
commands, and the Malwarebytes service used about 1 to 1.5 cores throughout. 10 of the 26 runs had
a sample over 10% before or after, and were not used.

`load-samples.txt` is a second record of the load. A PowerShell loop outside this folder read the
same counter through the whole session, about every 3 s. Each line holds the local time and the
percentage: 1,026 readings from 23:58:13 to 00:50:21. They include the load of the timed run. The
table counts them for each used run, from the end of the previous run to the end of this one. So a
window holds the wait before the run, the runner's samples and the timed run. The times are
those of the runner's output lines, to the second.

| Used run | Window | Readings | Over 10% | Highest |
|---|---|---|---|---|
| `setless-sweep.txt` run 1, attempt 1 | 23:58:11 (start) to 00:01:15 | 60 | 31 | 32 |
| `setless-sweep.txt` run 2, attempt 3 | 00:04:17 to 00:07:02 | 54 | 19 | 39 |
| `setless-sweep.txt` run 3, attempt 2 | 00:08:22 to 00:09:40 | 26 | 5 | 13 |
| `parsed-model-cost-validate.txt` primary, run 1, attempt 1 | 00:09:40 to 00:11:16 | 31 | 22 | 99 |
| `parsed-model-cost-validate.txt` primary, run 2, attempt 2 | 00:12:52 to 00:14:46 | 37 | 12 | 91 |
| `parsed-model-cost-validate.txt` primary, run 3, attempt 1 | 00:14:46 to 00:16:17 | 30 | 9 | 20 |
| `parsed-model-cost-validate.txt` no-type-qto, run 1, attempt 1 | 00:16:17 to 00:17:57 | 33 | 22 | 35 |
| `parsed-model-cost-validate.txt` no-type-qto, run 2, attempt 1 | 00:17:57 to 00:19:36 | 32 | 6 | 28 |
| `parsed-model-cost-validate.txt` own-full-set, run 1, attempt 1 | 00:19:36 to 00:22:48 | 63 | 10 | 24 |
| `parsed-model-cost-validate.txt` own-full-set, run 2, attempt 2 | 00:26:02 to 00:30:34 | 89 | 43 | 100 |
| `parsed-model-cost-sweep.txt` primary, run 1, attempt 1 | 00:30:34 to 00:31:27 | 17 | 0 | 6 |
| `parsed-model-cost-sweep.txt` primary, run 2, attempt 1 | 00:31:27 to 00:32:20 | 18 | 0 | 4 |
| `parsed-model-cost-sweep.txt` no-type-qto, run 1, attempt 1 | 00:32:20 to 00:33:28 | 22 | 5 | 65 |
| `parsed-model-cost-sweep.txt` no-type-qto, run 2, attempt 3 | 00:35:08 to 00:35:57 | 16 | 2 | 20 |
| `parsed-model-cost-sweep.txt` own-full-set, run 1, attempt 3 | 00:41:28 to 00:44:54 | 67 | 40 | 100 |
| `parsed-model-cost-sweep.txt` own-full-set, run 2, attempt 2 | 00:47:35 to 00:50:22 | 55 | 16 | 100 |

In 14 of the 16 used runs some readings were over 10%, and in 5 they reached 91% to 100%. The
runner's own samples before and after those runs were all at most 10%. So compare only within a
run: the builds are interleaved there, and each figure is a median of 11.

### The memo of a type's quantity sets

`setless-sweep.txt`: `getPropertySets` over the 150,000 entities that hold no set. This is an
isolated loop over the bridge with a cold JIT, not `validateIDS`, one process per measurement.
Median of 11, three runs:

| Build | Loop, three runs | Heap left behind |
|---|---|---|
| `main` | 225.6, 227.6, 220.4 ms | 0.5 MB in each of the 33 |
| `b00f7dd7f` | 309.0, 311.1, 304.4 ms (+37.0%, +36.7%, +38.1%) | 12.7 MB in each of the 33 |
| `head` | 241.9, 240.1, 230.3 ms (+7.2%, +5.5%, +4.5%) | 0.5 MB in each of the 33 |

`b00f7dd7f` kept an empty memo entry for each of these entities. `head` reads quantity sets on
this path only for an `IfcTypeObject`, without the memo, and keeps no entry. In each run `head`
took 4.5% to 7.2% longer than `main`. `main`'s own medians spread by 3.3% across the three runs
(220.4 to 227.6 ms). The gap is larger than that spread, so `head` likely costs about 5% in this
isolated loop, where `b00f7dd7f` cost about 37%.

### The cost of inheriting the type's quantity sets

`parsed-model-cost-validate.txt`: `createDataAccessor` plus `validateIDS` on a freshly parsed
store; the parse is not timed. Median of 11 after 3 warm-up rounds, builds interleaved and the
order rotated each round. Medians in ms, one per run. The change is against `main` in the same
run:

| Scenario | Runs | `main` | `b00f7dd7f` | `head` |
|---|---|---|---|---|
| Types hold `Qto_WallBaseQuantities`, every 7th wall its own `Length` | 3 | 1,291.2, 1,233.3, 1,250.5 | 1,513.4 (+17.2%), 1,460.2 (+18.4%), 1,460.1 (+16.8%) | 1,451.2 (+12.4%), 1,392.4 (+12.9%), 1,410.4 (+12.8%) |
| Types hold no quantity set (control) | 2 | 1,435.9, 1,434.4 | 1,443.0 (+0.5%), 1,420.9 (-0.9%) | 1,427.7 (-0.6%), 1,416.2 (-1.3%) |
| Every wall holds its own full set with its type's values | 2 | 2,006.6, 2,044.1 | 2,129.6 (+6.1%), 2,113.9 (+3.4%) | 2,114.8 (+5.4%), 2,135.8 (+4.5%) |

`main`'s own medians spread by 4.7% across the three runs of the first scenario, and by 0.1% and
1.9% across the two runs of the others.

Each run checks every build's report against the counts derived from the model. `main` is
checked as a build that does not inherit the types' quantity sets, the other two as builds that
do. Every check held, in all 9 runs, used or not. In the control the three reports matched the
counts, which are the same either way.

`parsed-model-cost-sweep.txt`: the bridge alone, `getPropertySets` over every wall. Medians in ms,
two runs each:

| Scenario | `main` | `b00f7dd7f` | `head` | Sets / properties returned |
|---|---|---|---|---|
| Types hold `Qto_WallBaseQuantities` | 511.7, 512.0 | 578.6 (+13.1%), 582.1 (+13.7%) | 585.4 (+14.4%), 588.9 (+15.0%) | `main` 57,143 / 107,143; the others 100,000 / 550,000 |
| Types hold no quantity set | 489.1, 482.4 | 499.2 (+2.1%), 486.8 (+0.9%) | 492.3 (+0.7%), 488.0 (+1.1%) | 57,143 / 107,143 on every build |
| Every wall holds its own full set | 1,327.6, 1,322.5 | 1,482.3 (+11.7%), 1,457.7 (+10.2%) | 1,466.4 (+10.5%), 1,430.8 (+8.2%) | 100,000 / 550,000 on every build |

`main`'s own medians spread by 0.1%, 1.4% and 0.4% across the two runs of each scenario.

Each wall now carries the type's 9 quantities. The specifications evaluate those values instead
of stopping at `PSET_MISSING`. Where the types hold no quantity set, every build is within 2.1% of
`main`, and `head` within 1.3%, so no cost shows there. Where they do, `head` returns about five
times the properties `main` returns. It takes 14.4% to 15.0% longer in the bridge and 12.4% to
12.9% in `validateIDS`. Where every wall already holds the full set, every build returns the same.
Yet `head` takes 8.2% to 10.5% longer in the bridge and 4.5% to 5.4% in `validateIDS`. That is
the cost of reading the type's set and merging it with the wall's own. In `validateIDS` on the
first model `head` costs less than `b00f7dd7f`: 12.4% to 12.9% against 16.8% to 18.4%. In the
bridge alone on that model `head` took slightly longer than `b00f7dd7f`: 14.4% to 15.0% against
13.1% to 13.7%.
