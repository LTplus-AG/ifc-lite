# Unit walk: what the read budget charges (#7547)

Review of `8b5c4006f` (13 Oct): `IfcDerivedUnit.Elements` is `SET [1:?]`, and the schemas set no
maximum width. The shared 256-read budget of `8b5c4006f` also refused flat, type-correct units. One
example is 128 elements over metre and second that make a LINEARVELOCITYUNIT at scale 1. Can the
branch keep the flat domain that resolved before, and still bound malformed recursive work and output?
The review also noted that memoizing repeated named-unit leaves helps that example.

## The rule

What a walk is charged for follows the schema. In IFC2X3, IFC4 and IFC4X3,
`IfcDerivedUnitElement.Unit` is an `IfcNamedUnit`, so a real derived unit is flat.

- Free: the reads made before the walk enters a derived unit. These are the top-level unit itself,
  and for a conversion-based one its factor and the factor's unit.
- Free: inside the top-level unit, a read whose target the entity index types as the schema allows
  there. That is the element (`IfcDerivedUnitElement`) and the unit it names (`IfcNamedUnit`: SI,
  conversion-based with or without offset, context-dependent). For a conversion-based unit it is
  also the factor (`IfcMeasureWithUnit`) and that measure's `UnitComponent` (`IfcUnit`).
- Free: a dangling reference, since nothing is read.
- Once per walk: inside the top-level unit, a named unit's resolution, a factor and the factor's
  `UnitComponent` are kept by id. A later reference to the same id gets the first result and reads
  nothing. An element id read a second time is charged instead: `Elements` is a SET, so a real unit
  never lists one twice.
- Charged, before the read is made: every other read. That is a nested derived unit, every read
  below it, and any target the schema does not allow at its place. A nested derived unit is one
  named as the `Unit` of another derived unit's element. It is charged on every visit and never kept.
- One walk may make 256 charged reads, and they may read 64 KiB of records between them. Past
  either, the walk is refused, the refusal is sticky, and the unit is unresolved.
- A composed symbol past the engine's string limit leaves the unit unresolved. Before, the readers
  threw `RangeError: Invalid string length`.

So a flat unit is never charged. It resolves at any width with `main`'s symbol and scale: a unit's
resolution depends on its id alone, so keeping it changes no result. Each element is read once, and
each distinct unit, factor and factor's unit once per walk. A record can be free in two places at
most (a named unit as a `Unit` and as a `UnitComponent`). So the free reads of one walk parse at most
twice the file size, plus the top-level unit's own reads (at most three records). The charged reads
add at most 64 KiB. The path set (cycles) and the sticky refusal are unchanged.

The depth cap of 16 (long chains), the budget and the memo apply to the parsed-source path only. The
native (`readEntity`) path keeps the walk it had on `main`. Its callers' 512-read limit bounds it,
a chain of nested units included, and refuses with their own `exceed the read limit` error.

The code is `packages/parser/src/project-unit-walk.ts` (`FLAT_UNIT`, `chargeRead`, `once`,
`composeWithinLimit`) and its call sites in `packages/parser/src/project-units.ts`.

## Builds

Three builds of `@ifc-lite/parser`, the same tree except `src/project-units.ts` and
`src/project-unit-walk.ts`:

- `main`: `project-units.ts` from `main` at `596c892f1`, and no walk module.
  `packages/parser` there is the same as at the merge base `bb529b359`.
- `8b5c4006f`: both files from `8b5c4006f`, the head the review read. Every read is charged.
- `head`: this commit.

They are copies of `packages/parser/dist` inside `packages/parser`, so their imports resolve. The
copies are not tracked: delete them before running the repository's checks.

```sh
pnpm install && pnpm --filter @ifc-lite/parser... build
cd packages/parser && mkdir -p .evidence-builds
git show 596c892f1:packages/parser/src/project-units.ts > src/project-units.ts
rm src/project-unit-walk.ts && pnpm run build
cp -r dist .evidence-builds/main && rm -f .evidence-builds/main/project-unit-walk.*
git show 8b5c4006f:packages/parser/src/project-units.ts > src/project-units.ts
git show 8b5c4006f:packages/parser/src/project-unit-walk.ts > src/project-unit-walk.ts
pnpm run build && cp -r dist .evidence-builds/8b5c4006f
git checkout -- src/project-units.ts src/project-unit-walk.ts
pnpm run build && cp -r dist .evidence-builds/head
cd ../..
B="packages/parser/.evidence-builds"
ROUNDS=0 node docs/architecture/evidence/7547-unit-walk-flat-domain/flat-domain.mjs "$B/main" "$B/8b5c4006f" "$B/head"
rm -rf packages/parser/.evidence-builds
```

`ROUNDS=0` prints results and reads only, as in `results.txt`. Without it the script also times
each reader (see Times).

## Fixtures

Every model is generated inside `flat-domain.mjs`; no model file is read. Each is a project whose
`IfcUnitAssignment` lists metre `#2`, second `#5` and the unit under test `#60`. Wall `#10` has a
property `Speed` (`IfcLinearVelocityMeasure` 2.5) whose own `Unit` is `#60`. The models are IFC4
unless named IFC2X3.

- Flat: the review's shape. `pairs` cancelling metre (+1, -1) pairs, then metre +1 and second -1,
  each element its own entity: 2, 128 (63 pairs, the review's example), 300, 10,000 and 100,000
  elements. Also 10,000 elements over a conversion-based length unit of 1 m with a 255-character
  name (`IfcLabel` is `STRING(255)` in IFC4), and 1,000 elements named by 1,000 properties.
- Flat, IFC4, over a factor of any size: `IfcMeasureWithUnit.ValueComponent` is an `IfcValue`,
  which includes `IfcText`, and `IfcText` has no length limit. The velocity shape of 2,000 elements
  over one foot whose factor holds a 65,536-character `IfcText`. Then the same 2,000 elements with
  each length element over its own foot, the 1,999 feet sharing that factor. A text is not a
  number, so every build uses FOOT's known factor, 0.3048.
- Flat, IFC2X3, where `IfcLabel` has no length limit: 2,700 elements over one conversion-based unit
  with a 200,000-character name. The symbol would have 540,002,699 characters, past V8's
  536,870,888, in one `Array.prototype.join`. The velocity shape over the same name (2,702
  elements) passes the limit only in the final concatenation of numerator and denominator.
- Malformed: `#60` lists one element 20,000 times, and the metre it names carries 16,000 extra `$`
  attributes.
- Nested, outside the schema: a fan-out of 10 levels by 4. A unit whose 10,000 (or 1,000)
  elements all name one derived unit of 4 (or 1,000) metre elements. Also 300 elements naming one
  derived unit whose 20,000 elements are all `$`, so it holds no reference.
- Not a unit, outside the schema: 1,000 elements whose `Unit` is one `IfcCartesianPointList3D` of
  3,000 points.

## Results

`results.txt` holds one run with `ROUNDS=0`; a second run printed the same text. Each cell is the
first call of one reader on a parsed model, with the entity reads it made. A read is one
`EntityExtractor.extractEntity` call; KB counts the records it read. The cells show
`extractProjectUnits(store.source, store.entityIndex)`. `extractPropertiesOnDemand(store, 10)`
gives the same results with two reads fewer, except in the 1,000-property row, which shows it.

| Case (file) | `main` | `8b5c4006f` | `head` |
|---|---|---|---|
| Flat, 2 elements, the control (1 KB) | `m/s`, scale 1; 9 reads, 0.4 KB | the same | the same |
| Flat, 128, the review's example (6 KB) | 257-character symbol, scale 1; 261 reads, 10 KB | unresolved (1); 260 reads, 10 KB | as `main`; 135 reads, 5.3 KB |
| Flat, 300 (13 KB) | 601 characters, scale 1; 605 reads, 24 KB | unresolved (1); 260 reads, 11 KB | as `main`; 307 reads, 12 KB |
| Flat, 10,000 (408 KB) | 20,001 characters, scale 1; 20,005 reads, 779 KB | unresolved (1); 260 reads, 69 KB | as `main`; 10,007 reads, 398 KB |
| Flat, 100,000 (4,233 KB) | 200,001 characters, scale 1; 200,005 reads, 7,944 KB | unresolved (1); 260 reads, 685 KB | as `main`; 100,007 reads, 4,135 KB |
| Flat, 10,000 over a 255-character name (408 KB) | 2,559,747 characters, scale 1; 40,003 reads, 4,206 KB | unresolved (1); 260 reads, 86 KB | as `main`; 10,009 reads, 398 KB |
| Flat, 1,000, named by 1,000 properties (129 KB), own `Unit` | each 2,001 characters; 2,002,001 reads, 77,767 KB | each unresolved; 257,001 reads, 15,140 KB | as `main`; 1,004,001 reads, 39,757 KB |
| Flat, IFC4, 2,000 over one foot whose factor holds 65,536 characters of `IfcText` (146 KB) | 6,000 characters, scale 0.30479999999999996; 6,004 reads, 128,193 KB | unresolved (1); 260 reads, 5,462 KB | as `main`; 2,008 reads, 143 KB |
| Flat, IFC4, the same over 1,999 feet that share that factor (267 KB) | the same symbol and scale; 6,004 reads, 128,209 KB | unresolved (1); 260 reads, 5,463 KB | as `main`; 4,006 reads, 262 KB |
| Flat, IFC2X3, 2,700 over a 200,000-character name, one join (305 KB) | throws `RangeError: Invalid string length`; 10,805 reads, 527,805 KB | unresolved (1); 260 reads, 12,527 KB | unresolved (1); 2,708 reads, 301 KB |
| Flat, IFC2X3, velocity shape over that name, final concatenation (306 KB) | throws the same; 10,811 reads, 528,002 KB | unresolved (1); 260 reads, 12,527 KB | unresolved (1); 2,711 reads, 303 KB |
| Malformed, one element listed 20,000 times over a padded metre (149 KB) | 39,999 characters, scale 1; 40,005 reads, 626,543 KB | unresolved (1); 260 reads, 4,095 KB | unresolved (1); 263 reads, 157 KB |
| Nested, fan-out of 10 levels by 4 (3 KB) | 2,097,151 characters; 2,796,205 reads, 112,298 KB | unresolved (2); 260 reads, 11 KB | unresolved (2); 265 reads, 11 KB |
| Nested, 10,000 elements over one unit of 4 metres (413 KB) | 79,999 characters; 100,005 reads, 4,084 KB | unresolved (1); 260 reads, 70 KB | unresolved (1); 10,261 reads, 413 KB |
| Nested, 1,000 elements over one unit of 1,000 metres (86 KB) | 1,999,999 characters; 2,002,005 reads, 81,139 KB | unresolved (2); 260 reads, 23 KB | unresolved (2); 1,261 reads, 57 KB |
| Nested, 300 elements over one unit of 20,000 `$` (52 KB) | unresolved (2); 605 reads, 11,744 KB | unresolved (2); 260 reads, 4,973 KB | unresolved (2); 306 reads, 51 KB |
| Not a unit, 1,000 elements over one point list of 3,000 points (82 KB) | unresolved (2); 2,005 reads, 40,002 KB | unresolved (2); 260 reads, 5,086 KB | unresolved (2); 1,006 reads, 80 KB |

(1) The property's own `Unit` reads as `#60` with no scale. In the assignment the unit stays
declared without a scale, so it shows no unit.

(2) The same for the property. In the assignment the unit is skipped, since no element composed, so
the SI default `m/s` shows. This is the existing "incomplete" rule (#4833).

What the reads show:

- On the flat rows `head` returns `main`'s symbols and scales (the sha256 prefixes in `results.txt`
  match), with fewer reads. It reads each element once, and each distinct unit once per walk: the
  review's example reads 135 records where `main` reads 261.
- The two `IfcText` rows are schema-valid IFC4 (see Schema check). `main` parses the 64 KiB factor
  once per foot reference, 128 MB per call. `head` parses it once: 143 KB and 262 KB in all, each
  under its file's size.
- In the IFC2X3 rows `head` reads the 200,000-character name once, then returns the unit unresolved
  where `main` threw.
- In the malformed row the repeated element is charged from its second read, so `head` stops after
  256 charged reads. Most of its 157 KB is `#60` itself, a list of 20,000 references read once at
  the top level, and the padded metre, read once. `main` parsed 626,543 KB.
- On the nested and not-a-unit rows, `head` reads each top-level element once (free), and the
  charged reads stop at 256 or 64 KiB. A nested unit is charged on every visit, before it is read.
  In the 1,000-metre row the first visit spends the budget, so `head` reads the nested unit once,
  not once per element. In the 4-metre row each visit costs 9 charged reads, so it is read 29 times.
- The `$` row is the case the byte cap is for. Each visit is one charged read of a 39 KB record, so
  the read count alone would allow 256 of them; `head` reads it once.

The whole run, all three builds and every row, peaked at 1,421 MiB resident memory, the highest of
three `ROUNDS=0` runs (1,349, 1,421 and 1,313 MiB). So the IFC2X3 rows stay in the script. The
figure is Node's `process.resourceUsage().maxRSS`, printed in those runs by an exit hook outside the
script. The script now prints the same value to stderr at the end, as `maxRSS <n> MiB`. To measure
it again, run the `ROUNDS=0` command under Builds and read that line. The 1,421 MiB was not measured
again with it. The committed outputs predate that line, which goes to stderr and changes no other
output.

The native read path is not in the script; the tests pin it. Through a native reader, a chain of 16
nested units resolves as on `main` (`extractProjectUnits` and `extractTypeEntityOwnQuantities`).
A chain of 256 runs into the caller's 512-read limit, and so do 300 elements over one metre.

Real parsed-model control: `packages/parser/test/project-unit-walk.parsed-model.test.ts` parses the
committed exporter file `rust/geometry/tests/fixtures/issue_098_wall_V5C.ifc`. Its assignment
holds nine derived units of up to four elements. Each of the eight unit types they declare
resolves to its SI scale on `head`, as on `main`.

## Times

`flat-domain.txt` holds three runs of `flat-domain.mjs` without `ROUNDS=0`, from the builds above.
`flat-domain-other-runs.txt` holds the other six, in the same form. Each time is the median of 5
calls of one reader on one build, after the counted call. Each call is timed alone, with the counter
removed. The model is parsed before; the parse is not timed. The builds are interleaved, and the
order rotates each round. `assignment` is `extractProjectUnits`, own `Unit` is
`extractPropertiesOnDemand(store, 10)`. The two IFC2X3 rows and the malformed row are never timed.

Machine: Intel Core i9-13900KF (24 cores, 32 threads), 64 GB, Windows 11 Pro, Node 22.20.0, the
High performance power plan. It was not idle. The load of all cores came in bursts of up to 100%.
It did so between runs too, when no run was going (the held-back samples in `load-samples.txt`).

Load: `Win32_Processor.LoadPercentage`, 5 samples about 1 s apart before and after each run, and one
about every 3 s during it. A run started once the 5 samples before it were all 10% or less; until
then a new set was taken after a 20 s pause. These are the commands, in Git Bash on Windows;
`load.ps1` and `sampler.ps1` hold the two PowerShell lines.

```sh
# load.ps1: $s = 1..5 | ForEach-Object { (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; if ($_ -lt 5) { Start-Sleep -Seconds 1 } }; ($s | ForEach-Object { "$_%" }) -join ', '
# sampler.ps1: param([string]$Out, [string]$Stop); while (-not (Test-Path $Stop)) { $l = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; Add-Content -Path $Out -Value ('{0} {1}' -f (Get-Date -Format HH:mm:ss), $l); Start-Sleep -Seconds 2 }
B="packages/parser/.evidence-builds"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File load.ps1 > before.txt
powershell.exe -NoProfile -ExecutionPolicy Bypass -File sampler.ps1 -Out samples.log -Stop stop &
node docs/architecture/evidence/7547-unit-walk-flat-domain/flat-domain.mjs "$B/main" "$B/8b5c4006f" "$B/head" > run.txt
touch stop; wait
powershell.exe -NoProfile -ExecutionPolicy Bypass -File load.ps1 > after.txt
```

Nine runs were made, and in none did every sample stay at 10% or less. The file holds the three
with the fewest samples over 10% during the run: 11, 9 and 14 of 72 to 77 (runs 3, 4 and 5). After
runs 4 and 5 some samples were over 10% too, up to 74%. The other six runs are listed at the end of
the file with their load, and their timed lines are in `flat-domain-other-runs.txt`. Every sample of
all nine is in `load-samples.txt`. All nine printed the results and reads of `results.txt`.

Lowest and highest median of the three runs, in ms. The last two columns compare `head` with `main`
within each run, and give `main`'s own spread between the runs (highest minus lowest median), the
noise floor.

| Case | Reader | `main` | `8b5c4006f` | `head` | `head` against `main`, in each run | `main` between runs |
|---|---|---|---|---|---|---|
| Flat, 2 elements, the control | assignment | 0.09 to 0.18 | 0.09 to 0.21 | 0.12 to 0.29 | slower in all 3: 33 to 89%, 0.03 to 0.11 ms | 0.09 ms (100%) |
|  | own `Unit` | 0.07 | 0.05 to 0.06 | 0.06 | faster in all 3: 14%, 0.01 ms | none at 0.01 ms |
| Flat, 128, the review's example | assignment | 0.59 to 0.63 | 0.60 to 0.70 | 0.44 to 0.53 | faster in all 3: 13 to 30%, 0.08 to 0.19 ms | 0.04 ms (7%) |
|  | own `Unit` | 0.42 to 0.45 | 0.45 to 0.46 | 0.29 to 0.34 | faster in all 3: 23 to 31%, 0.10 to 0.13 ms | 0.03 ms (7%) |
| Flat, 300 | assignment | 0.86 to 0.87 | 0.40 to 0.46 | 0.60 to 0.68 | faster in all 3: 22 to 30%, 0.19 to 0.26 ms | 0.01 ms (1%) |
|  | own `Unit` | 0.76 to 0.83 | 0.36 to 0.40 | 0.48 to 0.50 | faster in all 3: 37 to 40%, 0.28 to 0.33 ms | 0.07 ms (9%) |
| Flat, 10,000 | assignment | 22.0 to 23.4 | 1.67 to 1.79 | 14.5 to 15.9 | faster in all 3: 32 to 34%, 7.5 to 7.6 ms | 1.4 ms (6%) |
|  | own `Unit` | 22.3 to 23.3 | 1.64 to 1.74 | 14.6 to 15.3 | faster in all 3: 34 to 35%, 7.7 to 8.0 ms | 1.0 ms (4%) |
| Flat, 100,000 | assignment | 233.9 to 250.2 | 29.8 to 31.2 | 163.0 to 177.1 | faster in all 3: 29 to 30%, 70.9 to 73.1 ms | 16.3 ms (7%) |
|  | own `Unit` | 231.5 to 243.5 | 28.1 to 31.1 | 162.0 to 164.1 | faster in all 3: 30 to 33%, 69.5 to 79.5 ms | 12.0 ms (5%) |
| Flat, 10,000 over a 255-character name | assignment | 79.8 to 85.6 | 1.95 to 2.26 | 13.9 to 16.0 | faster in all 3: 81 to 83%, 65.9 to 69.6 ms | 5.8 ms (7%) |
|  | own `Unit` | 77.0 to 83.1 | 2.28 to 2.37 | 14.0 to 14.9 | faster in all 3: 82%, 63.0 to 68.2 ms | 6.1 ms (8%) |
| Flat, 1,000, named by 1,000 properties | assignment | 1.97 to 2.10 | 0.35 to 0.36 | 1.25 to 1.34 | faster in all 3: 36 to 37%, 0.71 to 0.76 ms | 0.13 ms (7%) |
|  | own `Unit` | 2,053.0 to 2,156.8 | 395.7 to 412.9 | 1,298.0 to 1,359.6 | faster in all 3: 36 to 39%, 755.0 to 838.8 ms | 103.8 ms (5%) |
| Flat, IFC4, 2,000 over one foot whose factor holds 65,536 characters of `IfcText` | assignment | 1,637.9 to 1,749.8 | 69.8 to 75.2 | 3.51 to 4.20 | faster in all 3: over 99%, 1,634.4 to 1,745.6 ms | 111.9 ms (7%) |
|  | own `Unit` | 1,635.8 to 1,813.3 | 69.3 to 77.2 | 3.30 to 4.14 | faster in all 3: over 99%, 1,632.5 to 1,809.2 ms | 177.5 ms (11%) |
| Flat, IFC4, the same over 1,999 feet that share that factor | assignment | 1,637.1 to 1,690.4 | 68.2 to 73.4 | 6.97 to 7.13 | faster in all 3: over 99%, 1,630.0 to 1,683.4 ms | 53.3 ms (3%) |
|  | own `Unit` | 1,662.9 to 1,712.9 | 71.2 to 73.4 | 6.93 to 7.26 | faster in all 3: over 99%, 1,655.6 to 1,706.0 ms | 50.0 ms (3%) |
| Nested, fan-out of 10 levels by 4 | assignment | 2,330.4 to 2,383.3 | 0.27 to 0.29 | 0.36 to 0.39 | faster in all 3: over 99%, 2,330.0 to 2,382.9 ms | 52.9 ms (2%) |
|  | own `Unit` | 2,336.7 to 2,375.6 | 0.28 to 0.30 | 0.37 to 0.38 | faster in all 3: over 99%, 2,336.3 to 2,375.2 ms | 38.9 ms (2%) |
| Nested, 10,000 over one unit of 4 metres | assignment | 101.0 to 102.9 | 1.62 to 1.68 | 22.4 to 23.0 | faster in all 3: 77 to 78%, 78.0 to 80.1 ms | 1.9 ms (2%) |
|  | own `Unit` | 101.6 to 103.5 | 1.62 to 1.98 | 22.2 to 23.1 | faster in all 3: 78 to 79%, 79.1 to 81.2 ms | 1.9 ms (2%) |
| Nested, 1,000 over one unit of 1,000 metres | assignment | 1,993.2 to 2,038.2 | 0.52 to 0.55 | 2.61 to 2.73 | faster in all 3: over 99%, 1,990.6 to 2,035.5 ms | 45.0 ms (2%) |
|  | own `Unit` | 2,008.3 to 2,043.0 | 0.54 to 0.56 | 2.50 to 2.69 | faster in all 3: over 99%, 2,005.8 to 2,040.4 ms | 34.7 ms (2%) |
| Nested, 300 over one unit of 20,000 `$` | assignment | 234.2 to 249.9 | 101.4 to 106.3 | 1.35 to 1.61 | faster in all 3: 99%, 232.9 to 248.3 ms | 15.7 ms (7%) |
|  | own `Unit` | 233.6 to 250.8 | 100.8 to 104.6 | 1.34 to 1.38 | faster in all 3: 99%, 232.3 to 249.4 ms | 17.2 ms (7%) |
| Not a unit, 1,000 over one point list | assignment | 1,504.3 to 1,524.1 | 189.2 to 194.8 | 3.68 to 4.00 | faster in all 3: over 99%, 1,500.4 to 1,520.1 ms | 19.8 ms (1%) |
|  | own `Unit` | 1,542.4 to 1,591.4 | 192.8 to 202.7 | 3.85 to 4.02 | faster in all 3: over 99%, 1,538.6 to 1,587.4 ms | 49.0 ms (3%) |

Read within each run, against `main` in that run:

- One row was slower on `head` in all three runs: the 2-element control, `assignment`. The gap was
  0.03 to 0.11 ms (33% to 89%), where `main`'s own spread was 0.09 ms. It was slower in the six
  other runs too, by 0.01 to 0.08 ms (8% to 89%). Its cause was not measured. The same unit read
  through its own `Unit` was 0.01 ms faster in all three runs.
- The 128-element row (the review's example) was faster on `head` in all three runs: 13% to 31%,
  0.08 to 0.19 ms. `main`'s spread there was 0.03 to 0.04 ms. `head` reads 135 records where `main`
  reads 261.
- The 300-element row was faster on `head` in all three runs: 22% to 40%, 0.19 to 0.33 ms. `main`'s
  spread there was 0.01 to 0.07 ms. `head` reads 307 records where `main` reads 605.
- Flat rows of 10,000 and 100,000 elements and the 1,000-property row: `head` was 29% to 39% faster
  in all three runs, above `main`'s spread of 4% to 7%. Over the 255-character name it was 81% to
  83% faster.
- The two `IfcText` rows: `main` took 1.6 to 1.8 s per call, `head` 3.3 to 7.3 ms.
- Nested and not-a-unit rows: `head` took 0.36 to 23 ms, where `main` took 101 to 2,383 ms.
- In the six other runs (`flat-domain-other-runs.txt`) the signs were the same on every row. The
  one exception was the 2-element own `Unit`, equal on both builds in run 1 (0.07 ms).
- `8b5c4006f` is faster than `main` on the wide flat rows only because it refused them after 260
  reads.

## Schema check

`schema-check.txt`: IfcOpenShell 0.8.4 `python -I -m ifcopenshell.validate --rules` on the files
that `node flat-domain.mjs --write <dir>` writes. The 2-, 128- and 10,000-element models have no
issue, and neither have the IFC2X3 model past the string limit or the two IFC4 models over the
`IfcText` factor. Three controls fail as they should. In two, an element's `Unit` is a derived unit
or a point list (attribute type errors). The third is a USERDEFINED unit with no `UserDefinedType`
(`IfcDerivedUnit.WR2`).

## What stays as on main, and differences from Rust

- Nothing is kept between walks, as on `main` and in Rust. N references to one flat unit cost N
  walks (the 1,000-property row). Within one walk, each element is read once and each distinct unit,
  factor and factor's unit once.
- A flat unit's symbol joins one named unit's symbol per element, as on `main`, up to the engine's
  string limit. Past it the unit is now unresolved, where `main` threw.
- The native read path keeps `main`'s walk, as above.
- The Rust resolver still charges every decode (`MAX_UNIT_RESOLVE_DECODES = 256` in
  `rust/core/src/project_units/mod.rs`). `an_over_budget_unit_graph_is_refused_not_truncated` in
  `tests.rs` asserts that a flat unit of 300 SI elements is refused. So for a flat unit of 128 or
  more elements the TypeScript and Rust resolvers now differ. Rust also has no byte cap and no memo.
  This is read from the source; Rust was not built or run here. Rust is left as it is: whether it
  should follow is a question for review.
