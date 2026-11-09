# ifc-git revision corpus

This deterministic revision chain starts with the committed IFC4 model
`apps/viewer/public/samples/building-architecture.ifc`, exported by IFC-manager
for SketchUp. Every revision transforms its predecessor. The base stays untouched.
The original chain was contributed by Bruno (@bruadam); #8197 completes the missing
addition, classification and split cases and supplies real geometry evidence.

## Generate and verify

```sh
pnpm install
pnpm build
pnpm tsx tools/ifc-git-corpus/derive-revisions.mts
pnpm tsx tools/ifc-git-corpus/derive-revisions.mts --check
```

The plain run generates the IFC files under the gitignored
`tests/models/local/ifc-git-corpus/` and rewrites `revisions.json` only after all
declarations hold. `IFC_GIT_CORPUS_OUT` overrides the output directory.
`--check` compares a fresh derivation with the committed manifest without
rewriting it. A contradiction fails before the manifest can be updated.

The existing Node guards workflow invokes `--check`. Exit 0 means verified;
exit 1 means disagreement; exit 3 means required build output is absent and
nothing was checked. Both the independent diff WASM and the source-built
geometry WASM are prerequisites. A successful geometry proof never skips.

## Version 2 chain

Version 2 replaces the incomplete version 1 manifest. Revision IDs follow the
agreed change-class table; `r11a` records the required sharing preparation as its
own revision so the later shared-set edit cannot hide a second change.

| Revision | Change | Required evidence |
| --- | --- | --- |
| r00 | Base | Committed source hash |
| r01 | Property value | One element, one pset component |
| r02 | Move | Data unchanged; actual wall geometry moves 250 mm along X; other meshed products unchanged |
| r03 | Add element | Exactly one added product, with its own 4 m partition solid |
| r04 | Delete element | Exact deleted GlobalId |
| r05 | Rename element | One `attr:core` component |
| r06 | Add classification | One `classification` component from a real association |
| r07 | Regenerate GlobalIds | Keyed churn; content matching absorbs all semantic churn |
| r08 | Identical re-save | Identical bytes and empty diff |
| r09 | Type property | One type object's pset component |
| r10 | Split element | One product becomes two adjacent half-solids; data matching abstains on the ambiguous 1-to-2 group |
| r11a | Share pset | One definition, exactly two consumers, unique set names |
| r11 | Edit shared pset | Both consumers change the same pset component |

The addition is an explicit millimetre-space partition in the existing building.
The split replaces that partition with two separate 2 m products whose union
preserves its world bounds and closed-solid volume. These are derived edits,
not purported successive exports from the original authoring tool.

## Geometry and identity

The real `IfcAPI.buildPrePassOnce` / `processGeometryBatch` producer supplies
world geometry hashes, world bounds and closed-solid volumes. Both the mesh
collection and API are freed in `finally`, including failure paths. No mesh or
triangle output is a failure, as is a missing target hash.

The move proof checks the declared product, the measured 250 mm displacement
of both box corners, and unchanged hashes and bounds for every other meshed
product. The split proof requires positive closed-solid evidence for the source
and both halves, conserved volume, adjacent partition bounds, replacement
product identities, and unchanged geometry for unrelated products. The manifest
records these actual measurements alongside the data diffs.

Shared-property preparation replaces the second wall's same-named definition
rather than adding another set of that name. The generator independently verifies
the definition, its exact consumers, `IfcObject.UniquePropertySetNames` and equal
component hashes. Count-only checks would miss two separate same-named copies.

## Limits

This is one small, real base model with deterministic synthetic edits. It checks
these change classes and conservative matching behavior. It does not establish
how arbitrary exporters behave, or substitute for genuine successive exports.
Scale and federation are separate work. Use a current build: the generator reads
workspace `dist` modules and both built WASM engines.
