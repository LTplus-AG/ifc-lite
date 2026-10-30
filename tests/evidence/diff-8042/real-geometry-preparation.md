# Real geometry parity preparation (#8042)

Status: prepared, **not executed**. No new result or performance claim is made.

`scripts/diff-real-fixture-parity.mjs` is already invoked by the shard-4
"Rust diff real IFC parity (#8042)" step in `.github/workflows/test.yml`.
That step now has a five-minute timeout. This extends that acceptance path;
it does not add a separate, unwired gate.

The committed SketchUp architecture demo and its revision are loaded through
the existing CLI loader and fingerprint adapter. Haus, when available, adds a
self-comparison. Geometry enrichment runs the canonical Rust
`buildPrePassOnce` / `processGeometryBatch` path with geometry hashing enabled,
joins results by express id, and reads the actual world Y-up AABB, geometry
hash, and producer-proved closed volume through the production
`extractGeometryFingerprints` reader. An absent volume stays absent; no
authored quantity is substituted. Each file is limited to 16 MiB and 4096
geometry jobs. Collections, pre-pass caches, and API handles are freed in
`finally` blocks. Missing fixtures produce named skips directing the operator
to `pnpm fixtures`; they do not count as passing comparisons. A present fixture
without real hashes or proved closed solids fails.

Every comparison calls the public Rust-backed `diffModels` facade and compares
the complete result (including Maps, counts, component evidence and claims)
with the private pre-cutover TypeScript oracle. Separate identity assertions
cover `byKey`, entries, content matches, split/merge participants and successors.
Derived refs contain callbacks, so serialization/cloning cannot satisfy those
identity checks.

## Reproducible derived revisions and limits

The first real closed source solid with three positive AABB extents supplies
these explicitly derived **fingerprint projections**, not edited IFC files:

- Split and reverse merge: translate a copy by exactly the source's largest
  AABB extent. The two AABB interiors are disjoint, so the solids' union volume
  is exactly twice the measured source volume. Represent that exact union as
  one derived group on one side and the two solids on the other. Require one
  `verified` claim in each direction, two pieces, equal reported whole/pieces
  volumes, zero residual, and all original add/delete entries retained.
- Successor: scale that source by 1.1 along its largest axis about its AABB
  minimum and change its explicit derived name and key. AABB and volume follow
  the affine transform and determinant. Require changed data and geometry,
  one `footprint` successor with IoU `1 / 1.1`, no content retirement and no
  split/merge claim, in both default and geometry-only scope.

Derived geometry tokens are SHA-256 descriptors of the measured source hash
and affine operation or exact union members. They are labeled `derived:` and
are **not** claimed to be mesher-produced hashes. The whole is a known union
group, **not** a claim that the producer emitted a single closed-component
whole. Its volume is justified by disjointness. No arbitrary AABB is sliced
and assigned a guessed fraction of a source volume.

The log records fixture and both WASM binary SHA-256 digests, real geometry
counts, selected source key/id/hash/AABB/volume, transform parameters, derived
claim results and comparison/skip totals. Preserve that output with the source
commit in the parent evidence receipt when executing.

This establishes algorithm/facade parity on real measured geometry plus
controlled transformations. It does **not** establish a real authoring tool's
split/merge or successor revision ground truth, validate re-meshing of edited
IFC, or prove the production viewer's fingerprint adapter. These are limits of this parity evidence, not independently required
authored revision pairs in #8042. Production consumer behavior still needs
its own integration validation. Displaced/extent split profiles, position successors,
interloper exclusion and cross-class claims are not added by this preparation.

## Execution needs (parent integration)

1. Integrate the preparation commit into the parent checkout. Use its clean
   committed source through `~/build-workers/ifc-fleet`, the current resource
   guards, and one owning `--storage-task` for related commands. Do not run a
   heavy job directly in an agent checkout.
2. Require the repository-pinned Node/pnpm and Rust nightly/wasm-pack setup.
   Install locked dependencies through the admitted root workflow. Build the
   geometry **and independent diff** bundles from the integrated Rust source
   with the existing root build workflow. Prebuilt older geometry alone is
   insufficient. Root `pnpm build --filter=@ifc-lite/cli... --concurrency=1`
   builds the CLI and its dependency graph; ensure the WASM build actually ran
   for this source (use the existing root `pnpm build:wasm` preparation when
   needed). Check bundle freshness after Turbo restores outputs.
3. The committed demo needs no fixture download. To include Haus, prepare
   `tests/models/ara3d/AC20-FZK-Haus.ifc` via root `pnpm fixtures` before the
   acceptance run; otherwise record its named skip.
4. From the prepared repository root, execute
   `timeout 300s node scripts/diff-real-fixture-parity.mjs` through the admitted
   launcher. This is the same root script CI invokes. Require both pairs:
   fourteen comparisons (five option shapes per pair plus four derived
   revisions) and zero skips. A missing Haus fixture is a named skip and the
   run exits 2 as incomplete. A timeout is a failure.
5. Preserve compact logs and their receipt, reconcile outcomes, and close the
   owning storage task. Do not report parity until this execution succeeds.

No build, test, typecheck, benchmark, fixture fetch or WASM execution was
performed while preparing this change. JavaScript syntax and whitespace may
be checked without importing or executing the acceptance modules.
