# Entity list: each id once, any number of ids (#7537)

`filterByEntityFacet` (and `filterByFacet`, which calls it) returns each id once for an entity
list that names a class more than once. Review asked two things of that change:

1. Keep the previous acceptance domain of the exported filters. A single `Set` throws
   `RangeError: Set maximum size exceeded` on V8 past 2^24 distinct ids, where the filter used to
   return the list.
2. Keep the cost of the de-duplication in the evidence, with the scripts and fixtures, and not
   treat the isolated filter probe as end-to-end performance.

The fix (`packages/ids/src/facets/distinct-ids.ts`) still holds the ids taken in a `Set`. When the
engine refuses an insert, the ids go on in a new `Set`, so the `Set` limit no longer caps the result
(array length and memory still do, as before). Each class's list is read in full before the next is
asked for, as the plain loop did.

## Builds

Three builds of `@ifc-lite/ids`, the same tree except for `src/facets/entity-facet.ts`:

- `main`: `entity-facet.ts` from the merge base ed1c07d4d, which `main` still has (no de-duplication).
- `a2f319158`: `entity-facet.ts` from a2f319158, the single `Set` the first review qualified.
- `head`: this branch.

They are copies of `packages/ids/dist` inside `packages/ids`, so their imports resolve. The copies
are not tracked: delete them before running the repository's checks.

```sh
pnpm install && pnpm --filter @ifc-lite/ids... build   # the parser dist parsed-model-cost.mjs reads
cd packages/ids && mkdir -p .evidence-builds
git show ed1c07d4d:packages/ids/src/facets/entity-facet.ts > src/facets/entity-facet.ts
pnpm run build && cp -r dist .evidence-builds/main
git show a2f319158:packages/ids/src/facets/entity-facet.ts > src/facets/entity-facet.ts
pnpm run build && cp -r dist .evidence-builds/a2f319158
git checkout -- src/facets/entity-facet.ts
pnpm run build && cp -r dist .evidence-builds/head
cd ../..
# run the scripts as in the .txt files, then: rm -rf packages/ids/.evidence-builds
```

## Fixtures

Every fixture is generated inside its script; no model file is read.

- `filter-cost.mjs` and `mock-validate-cost.mjs`: a mock accessor with 300,000 walls (ids 1 to
  300,000) and one door.
- `parsed-model-cost.mjs`: an IFC4 STEP text with N walls, one door and `Pset_WallCommon.IsExternal`
  on every wall through one `IfcRelDefinesByProperties`, parsed with `IfcParser.parseColumnar` and
  read through each build's `createDataAccessor`. Every specification selects the list IFCWALL,
  IFCDOOR and requires `Pset_WallCommon.IsExternal`. Parsing is not timed: each sample is
  `createDataAccessor` plus `validateIDS`, so a whole file-to-report run shows a smaller share.
- `past-set-limit.mjs`: a mock accessor whose IFCWALL and IFCDOOR lists hold 2^24 + 3 distinct ids
  and one repeat.

## Results

Windows 11, Intel Core i9-13900KF, 64 GB, Node 22.20.0, pnpm 10.8.1, on an otherwise idle machine.
The `.txt` beside each script holds its output; the parser's spatial-structure warnings on stderr
are left out.

**Past the `Set` limit** (`past-set-limit.txt`):

| Build | Result | Peak memory |
|---|---|---|
| `main` | 16,777,220 ids (the repeat included), 286 ms | 0.73 GB |
| `a2f319158` | `RangeError: Set maximum size exceeded` after 2,785 ms | 1.06 GB |
| `head` | 16,777,219 distinct ids, 2,829 ms | 1.06 GB |

**`validateIDS` on a parsed model** (`parsed-model-cost.txt`, parse not timed, median of 7, builds
interleaved with the order rotated each round, three runs). The percentage is against `main` in
the same run:

| Walls, specifications | `main` | `a2f319158` | `head` |
|---|---|---|---|
| 130,000, 20 | 2,152 / 2,119 / 2,158 ms | +0.9% / +5.1% / +2.6% | +3.4% / +3.9% / +3.5% |
| 20,000, 20 | 265 / 264 / 268 ms | +4.5% / +6.1% / +4.5% | +3.8% / +4.5% / +3.4% |
| 130,000, 1 | 1,113 / 1,136 / 1,140 ms | +0.2% / -0.9% / +1.0% | -0.8% / -0.7% / +0.9% |

Every build reports the same result for every specification (fail, all walls passed, the door
failed). With 20 specifications over these lists the de-duplication costs 1 to 6% for `a2f319158`
and 3 to 5% for `head`; with one, nothing measurable.

**Mock `validateIDS`** (`mock-validate-cost.txt`, builds interleaved with the order rotated). Each
entity check costs almost nothing here, so this bounds the overhead from above:

| Specifications | `main` | `a2f319158` | `head` |
|---|---|---|---|
| 1 | 145 ms | 155 ms | 150 ms |
| 20 | 1,888 ms | 2,189 ms | 2,207 ms |

**The filter alone** (`filter-cost.txt`, median of 15, builds interleaved in a fixed order). An
isolated probe:

| List | `main` | `a2f319158` | `head` |
|---|---|---|---|
| IFCWALL | 300,000 ids, 2.7 ms | 300,000 ids, 16.1 ms | 300,000 ids, 16.6 ms |
| IFCWALL, IFCDOOR | 300,001 ids, 2.7 ms | 300,001 ids, 16.1 ms | 300,001 ids, 16.6 ms |
| IFCWALL, IFCWALL | 600,000 ids, 5.1 ms | 300,000 ids, 20.0 ms | 300,000 ids, 20.3 ms |

The cost is a hash and a `Set` entry per distinct id, also when no class repeats: about 14 ms
per filter call over 300,000 ids here, and the extra memory in the first table.
