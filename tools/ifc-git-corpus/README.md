# ifc-git revision corpus

A deterministic **revision chain** of one model, for testing version-control
flows. Issue [#8128](https://github.com/LTplus-AG/ifc-lite/issues/8128); part of
the [ifc-git spec set](../../docs/architecture/ifc-git/index.md).

## Why

`tests/models/manifest.json` catalogues 182 models and no version history. Every
entry is standalone, so nothing in the repo can exercise `log`, `rebase`,
compare-and-swap, or the GUID-agnostic claim. The only base/head pair is the
demo kit's `building-architecture-rev-b.ifc`, built for the tours walkthrough.

## Usage

```sh
pnpm install          # the chain needs @ifc-lite/wasm linked into packages/diff
pnpm build            # or at least --filter "@ifc-lite/cli..."
pnpm tsx tools/ifc-git-corpus/derive-revisions.mts            # derive + rewrite
pnpm tsx tools/ifc-git-corpus/derive-revisions.mts --check    # derive + compare
```

Writes the chain to `tests/models/local/ifc-git-corpus/` (gitignored —
`tests/models/local` is reserved for files the manifest never manages) and
rewrites `revisions.json`. Override the output directory with
`IFC_GIT_CORPUS_OUT`.

**The generator is the verification.** Each revision declares what it should
change — the counts, the `GlobalId`s touched, the component keys — and the
script measures the real diff between consecutive revisions and **fails**, before
writing anything, if the measurement contradicts the declaration.

Two claims, kept apart because they are not the same claim:

- A plain run proves **self-consistency**: these bytes, measured by *this*
  build, do what the declarations say. It then rewrites `revisions.json`, so it
  cannot also tell you the committed manifest was already right.
- `--check` proves the committed manifest **is still current**: same derivation,
  compared byte-for-byte against the committed file, nothing written. This is
  the mode worth automating; a plain run in CI would let a drifting engine
  rewrite its own expectations.

## The chain

Derived from the committed `apps/viewer/public/samples/building-architecture.ifc`
(226 KB, IFC4, IFC-manager for SketchUp). The base is never modified. Each
revision applies to the **previous** one, which is what a history is — not a
star of variants off one base.

| Rev | Change | Exercises |
| --- | --- | --- |
| `r00` | base | first commit, `parents: []` |
| `r01` | one property value in one property set | localisation: exactly `pset:Pset_WallCommon` on one element |
| `r02` | the first wall's own placement point moved | geometric change; data scope sees nothing, by design |
| `r03` | one element renamed | `attr:core` only |
| `r04` | one element deleted, with its orphaned relationships | `deleted` |
| `r05` | a type object's own property set edited | types tracked, not only occurrences (#8040) |
| `r06` | a property set shared with a second wall | a relationship gains a related object |
| `r07` | that shared property set edited | **one node change, two element markers** |
| `r08` | re-export: all 114 GlobalIds regenerated, header clock and owner-history dates moved | **GUID-agnostic identity** |
| `r09` | byte-identical re-save | empty diff ⇒ no commit |

## The two measurements, and why there are two

Every pair is measured twice and both readings are recorded:

- **`keyed`** — the default. Entities pair by `GlobalId`.
- **`contentMatched`** — adds `matchUnpairedByContent`, which pairs leftovers by
  data hash.

The gap between them *is* the GUID-agnostic story. Measured on `r08`:

| Reading | Result |
| --- | --- |
| `keyed` | **+39 / −39** — a total rewrite |
| `contentMatched` | **0 / 0 / 0**, with 39 `renamed` claims |

39, not 114, because the regenerated ids span every `IfcRoot` in the file while
data scope diffs the elements and type objects — 39 of them at `r08`. Every one
of those 39 changes address.

A re-exported model with nothing semantically changed reads as complete churn
when paired by `GlobalId`, and as unchanged once content matching runs. That is
the whole argument for treating `GlobalId` as evidence rather than identity, and
it is why ifc-git computes a commit from the diff rather than from the bytes.

It is also the case that would catch the defect recorded in
[index §6.1](../../docs/architecture/ifc-git/index.md): node-hash v0 folds the
entity `key` into the `element` node, so a re-GUID moves every element address.

## Verification scope

`data`, deliberately — it needs no geometry pipeline and so **executes** no
WASM. That is not the same as needing nothing: `pnpm install` must have linked
`@ifc-lite/wasm` for `packages/diff` to load at all, and the measurement is only
as current as `packages/*/dist`. `r02` carries a real geometric change that data
scope cannot see; it is flagged `geometryScopeRequired` in the manifest rather
than quietly recorded as a no-op.

## Limits, stated rather than implied

- **A derived chain tests ifc-git against our own idea of a revision.** It proves
  the machinery handles these change classes. It does not prove real exporters
  only produce these classes. `r08` narrows the gap, because regenerated GUIDs
  and a moved header clock are what real tools actually do on a from-scratch
  export — but the gap does not close without a chain of genuine successive
  exports from one authoring tool, which cannot be fabricated.
- **One small model.** Scale behaviour belongs with the performance work, against
  `ara3d/ISSUE_053_20181220Holter_Tower_10.ifc` (177 MB) and
  `various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc` (343 MB).
- **One repository.** Federation chains across several repositories are out of
  scope here.
- **Measure with a current build.** The generator reads `packages/*/dist`, so a
  stale build silently measures an old engine. Both times this corpus appeared
  to find a defect during development, the cause was stale local state — once a
  `dist/` predating the #8040 fix, once a missing `pnpm install` after a fetch.
  Run `pnpm install && pnpm build` before trusting a surprising result.
