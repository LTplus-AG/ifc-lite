# RouterConfig behavior oracle (#7781, C2-4)

The whole-change inverse deletes the new `RouterConfig` and `from_config`
APIs while retained `styled_walk_tests.rs` imports them. That compile failure
cannot establish that a geometry assertion observes configuration behavior.

The workflow therefore selects `behaviour.oracle.patch` while
`rust/geometry/src/router/config.rs` is an added file relative to main. The
oracle applies this patch **in reverse**: only the boolean passed to
`set_instancing_batch_local` in `from_config` is negated. All six fields, APIs,
constructors, setters, generation invalidations, test wiring and changed tests
remain present. Earlier workflow selectors keep their precedence; no `--test`
filter narrows the ordinary oracle's changed-test collection.

Existing geometry witnesses in `router::styled_walk_tests` exercise both modes:

- `dont_bake_template_and_placeholder_carry_the_source_identity_and_mapping`
  configures global templates and visits non-minimum occurrence #15 first. It
  requires an empty placeholder, then the #13 template's 36 indices and the
  expected mappings. The mutant instead materializes #15 as a batch template.
- `a_provisional_template_claim_is_kept_only_for_materialized_geometry`
  configures batch-local templates and visits #15 before #13. It requires 36
  actual mesh indices and the translated instance mapping, then an empty #13
  placeholder. The mutant instead uses the global #13 template and emits an
  empty #15 placeholder.

These are assertions on real parsed block geometry and instance payloads, not
configuration readback. The original tests and fixture bytes are unchanged.
The patch is deliberately a narrow behavior mutation, not a claim that one
mutation proves every configuration field or every C2-4 obligation.

Run the complete ordinary oracle in an isolated admitted qualification
checkout, with `BASE` and `HEAD` pinned to the reviewed commits:

```sh
env -u IFC_LITE_FAST_CUT_RATIO node scripts/check-test-revert-oracle.mjs \
  --base "$BASE" --head "$HEAD" --ci --json \
  --mutation tests/evidence/router-config-7781/behaviour.oracle.patch
```

Require a green full baseline, the named geometry assertion witness under the
mutation, and hash-verified restoration followed by green execution of the
same full collection. Retain raw results and exact test inventories; reject
compile/import failures, generic crashes, missing tests and skipped witnesses
as proof. Source review and cheap patch/selector/classifier controls do not
establish compilation or runtime observation. The new exact successor needs
independent review and actual qualification before any such claim.

## Current-main rebuild

The `sweep/c2-4-main-r1` rebuild applies the approved `ed3c6cb4..1103a182`
lane diff onto `ead6f70cee04198dd04e9df4a3c992d61cbaa799`. It retains the
current retained-runtime, F3b readers, opening/cut and georeferencing paths.
The only textual conflict was the geometry module-size digest; it is computed
from main's allowlist with the measured router row lowered.

Configuration ownership decisions:

- The six meshing choices remain on `RouterConfig`. Existing accessors read
  those fields, and all public constructors and setters remain available.
- `schema` stays the router's immutable process-wide `OnceLock` reference.
  It is implementation routing metadata, not a caller-selectable setting;
  putting it in the public value would prevent exhaustive construction.
- `ExecutionPolicy`, `ResourceLimits`, `ProductBudget` and deadline clocks
  remain in the resource/execution domain. They carry request admission,
  cumulative usage and cancellation identity; cloning a meshing config must
  never reset an allowance or restart a deadline. Supervision deadlines and
  retained product controllers/executors likewise keep their existing owners.
- Accounted/shared caches, mapped-cache accounts, material layers and
  instancing plans stay injected runtime data. The execution owner, unit
  refusal, diagnostics and per-element triangle-order toggle stay runtime
  state, as in the approved lane. `config()` is not a state snapshot.
- Equal-value quality/skip calls retain main's no-op semantics. Every
  batch-local setter call invalidates a lease, including an equal-value call;
  the lease regression covers both. Local-frame policy stays construction-only.

Release accounting is additive: the new exhaustive `RouterConfig` type and
`GeometryRouter::{from_config, config}` remove or change no existing public
signature or field. The API snapshot adds only `RouterConfig`. The existing
WASM minor changeset expresses the Rust-only minor release; `majorOffset`
remains 14, and no break #15 or manifest version rewrite is warranted.
Future additions to this exhaustive config will need their own API review.

The source rebuild is not a fresh performance qualification. Exact-head
base/branch worker-pool timing and output identity remain required before a
performance or merge-readiness claim; this local task requests Clippy, package
tests, ratchets and oracle attribution only.
