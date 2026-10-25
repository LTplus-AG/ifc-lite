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
writing anything, if the measurement contradicts the declaration. Revisions
whose point is a *shared* definition declare that too — see below.

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
| `r06` | the second wall's `Pset_WallCommon` replaced by the first wall's, so one definition has two consumers | one definition, two consumers; `pset:Pset_WallCommon` on the second wall only |
| `r07` | that shared property set edited | **one node change, two element markers** |
| `r08` | re-export: all 113 GlobalIds regenerated, header clock and owner-history dates moved | **GUID-agnostic identity** |
| `r09` | byte-identical re-save | empty diff ⇒ no commit |

## The shared property set (`r06`/`r07`), and why it replaces rather than adds

Both of the base model's first two walls carry their own `Pset_WallCommon`.
`r06` therefore cannot simply add the second wall to the relationship that
defines the first: that leaves the second wall with **two** sets of that name,
which violates `IfcObject.UniquePropertySetNames` (bundled
`IFC4_ADD2_TC1.exp`, via `IfcUniqueDefinitionNames`) in `r06` and — because
each revision is applied to the previous text — in every revision after it.

It also destroys the measurement the revision exists to make.
`buildComponentFingerprints` assigns `components['pset:' + set.name]` in a
loop, so a second same-named set *overwrites* the first. The duplicate reads as
a moved whole-entity `dataHash` with an **empty** `changedComponents`, and the
`r07` edit then lands on whichever copy happened to win.

So `r06` **replaces**: the second wall is detached from its own same-named
association (which leaves that relationship relating nothing, so it is dropped,
`RelatedObjects` being `SET [1:?]`) and attached to the first wall's. The
superseded set stays in the file referenced by nothing, which is what a real
detach leaves behind and is schema-valid. Resolution is by set *name*, never by
express id.

Measured, per entry rather than unioned:

| Pair | Construction | `1AQAupaRP1txwK1AGiN61V` | `3wdauVJT5Fx9drrREiDqA$` |
| --- | --- | --- | --- |
| `r05`→`r06` | add (duplicate) | unchanged | `modified`, components **`[]`** |
| `r05`→`r06` | replace | unchanged | `modified`, `pset:Pset_WallCommon` |
| `r06`→`r07` | add (duplicate) | `modified`, `pset:Pset_WallCommon` | `modified`, components **`[]`** |
| `r06`→`r07` | replace | `modified`, `pset:Pset_WallCommon` | `modified`, `pset:Pset_WallCommon` |

`r07`'s headline counts are the same either way — `+0 ~2 -0` — which is exactly
why counts alone were not enough to notice. Under the duplicate construction
only *one* of the two markers was attributable to the property set; the other
was blob churn from carrying a second copy.

So `r06` and `r07` also declare the sharing itself — the definition's
`GlobalId` and `Name`, and every consumer's `GlobalId` — recorded as
`sharedDefinition` in the manifest and checked three ways against the model the
transform produced:

1. **Structure** — exactly which elements reach that one definition record.
2. **Schema** — each consumer carries exactly one set of that name.
3. **Engine** — the `pset:<name>` sub-hash is present and **identical** on every
   consumer. One definition cannot hash two ways.

A regression that silently un-shared the set, by giving each element its own
copy again, would leave `touchedGlobalIds` and the counts intact and fails all
three.

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

39, not 113, because the regenerated ids span every `IfcRoot` in the file while
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
