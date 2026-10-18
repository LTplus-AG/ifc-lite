<!-- SPDX-License-Identifier: MPL-2.0 -->
# Shared native scene comparison consumer

This qualification tool links **the same Rust consumer source** against pinned
base and candidate libraries. It changes no production numerical code. Its
structured receipts extend the performance probe's geometry fingerprint with
UVs, textures, metadata, poses, instances/templates, symbolic data, streaming
updates and extracted data-model associations.

`src/main.rs` invokes the real public `process` entry in four modes: `full`,
`stream`, `instanced`, and `fastfirst`. The last deliberately disables upfront
presentation-layer resolution to reach the existing deferred-style path; it is
a separate request, compared only against the same request on the other build.
Every actual resolved request and relevant thread/instancing environment is
recorded. Properties and layer metadata remain enabled in the other modes.

Every mesh is emitted as a separate JSONL record. Production serde-skipped
instance/local-bound/transform fields are explicitly included. Floats retain
IEEE bits, wide identities retain all bits, source strings cannot impersonate
numeric tags, and optional presence is preserved. Symbolic NaN fields receive
raw-bit sidecars in addition to their consumer wire shape. Vector/triangle/UV
order and duplicate occurrences are retained; maps use ordered keys.

Scene comparison excludes only the explicitly separate `execution` channel:
wall times, cache/work counters and the process-global CSG workload multiset.
Semantic refusal/opening/CSG statistics remain in scene diagnostics. These are
public full-pass aggregates, not invented occurrence-attributed event traces.
The collector records all returned meshes, frames, instances and model metadata,
full symbolic/provenance output in the returned frame, all sink events, and the
public extracted data model. A capability manifest marks missing per-element
hashes, full source material definitions and per-occurrence refusal attribution.
External image URL preservation does **not** prove asset resolution. See the
[qualification design](../../../docs/architecture/geometry-platform-scene-qualification.md).

No complete-platform or rendering-fidelity claim follows from a matching digest.
The `ifcx/` sibling uses the actual importer/export consumer paths; the native
STEP executable rejects other input formats. Hardware/browser upload and image
resolution still need their own evidence. A fixture with no text does not
qualify text; actual positive witnesses are in every manifest and `coverage.json`.

## Build and compare

Provide a JSON pin file containing `libraries.base` and `libraries.candidate`,
each mapping `ifc_lite_core`, `ifc_lite_geometry`, `ifc_lite_processing`, `serde`,
`serde_json`, `sha2` to `{path,sha256}` for matching existing rlibs. Both sets
must use the same pinned compiler and profiling features. The build checks every
pinned library and records source/compiler pins and executable hashes. It uses
`rustc` directly, so it neither rebuilds the workspace nor mutates its artifacts.

```sh
python3 tools/smlib-evaluation/scene-comparison/run.py build \
  --pins /tmp/ifclite-scene-library-pins.json --output /tmp/ifclite-scene-build
python3 tools/smlib-evaluation/scene-comparison/run.py run \
  --bin-dir /tmp/ifclite-scene-build --output /tmp/ifclite-scene-results \
  rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc
```

Each case runs base, base-repeat, candidate in separate processes with the same
worker count (default one). Exact field differences, base reproducibility,
capability agreement and positive required witnesses determine `qualified`.
Missing fixtures are explicitly unavailable, with the usual `pnpm fixtures`
message. Actual downloaded texture lanes require UV and image/pixel reference
witnesses; selected mapped-instance modes require real instances. Output records
and manifests are retained for inspection; SHA-256 is an index, not a replacement
for field comparison. Runs emit no performance claims and must not compete with
performance measurements. Heavy scenes may produce large disk receipts; this
is deliberately independent of performance timing, and the heavy full-scene
lane may remain explicitly pending rather than exhaust memory/disk.

`run.py` is a manually invoked measurement tool, not a CI gate. Run comparator
policy tests with:

```sh
python3 -m unittest discover -s tools/smlib-evaluation/scene-comparison -p 'test_*.py'
```

Rust tests in `bits.rs` and `collector_tests.rs` cover numeric/string/option
collisions, IEEE payloads, ordering and coverage of omitted UV/metadata/frame
fields over actual IFC production geometry. Compile `src/main.rs` with the same
library arguments plus `--test -Z panic_abort_tests` to match profiling rlibs.
No product golden pins are introduced by this harness.

The reusable command for those Rust invariants is:

```sh
python3 tools/smlib-evaluation/scene-comparison/run.py tests --build-dir /tmp/ifclite-scene-build
```

`finalize.py` rechecks retained records, positive witness gates, executable/source
pins and final library hashes. Supply `--scope` to identify the exact historical
candidate; do not reinterpret old library receipts as a later source tree.
The field inventory was audited against that candidate's public structs. Future
API additions, especially serde-skipped fields, require a fresh coverage audit.

The first [persisted native receipt](../../../docs/architecture/evidence/geometry-platform-scene/README.md)
records 44 matching cases for the historical ownership-layer candidate. Its
verified source overlay reconstructs that source over the pinned base. The raw
large JSONL/artifact files remain local and their availability limits are stated
in the receipt. This evidence is separate from subsequent continuation changes.
