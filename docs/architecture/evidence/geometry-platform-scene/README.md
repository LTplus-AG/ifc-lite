<!-- SPDX-License-Identifier: MPL-2.0 -->
# Historical ownership-layer scene qualification

**44/44 native cases matched:** 11 fixtures in four request modes, with one
independent baseline repeat per case. Exact structured semantic records match
between base and candidate, and between the two baseline executions. Positive
feature gates passed. Timing/cache-work differences are retained separately and
supply no performance claim.

These receipts belong exclusively to the **historical 226-source ownership-layer
candidate**, identified by [its frozen manifest](ownership-source226-manifest.json)
and [the pinned libraries](library-pins.json). Subsequent mapping-continuation
source edits are outside this evidence. The shared consumer was statically linked
to the original profiling rlibs; final SHA-256 checks confirmed none changed.
It did not rebuild or modify either numerical implementation.

## Actual cases

Every row ran `full`, `stream`, `instanced`, and `fastfirst`, using the same
request on base, base-repeat and candidate, one native worker per process.
`fastfirst` explicitly disables upfront presentation-layer resolution to exercise
deferred styles; other modes retain normal layer/property extraction.

| Actual source | Request cases |
| --- | ---: |
| `rust/geometry/tests/fixtures/bath_csg_solid.ifc` | 4 |
| `rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc` | 4 |
| `tests/models/ifc5/Georeferencing_georeferenced-bridge-deck.ifc` | 4 |
| `tests/models/buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-blob-texture.ifc` | 4 |
| `tests/models/buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-pixel-texture.ifc` | 4 |
| `tests/models/buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-image-texture.ifc` | 4 |
| `tests/models/buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-individual-colors.ifc` | 4 |
| `tests/models/ara3d/AC20-FZK-Haus.ifc` | 4 |
| `tests/models/ara3d/duplex.ifc` | 4 |
| `tests/models/various/rvt01.ifc` | 4 |
| `tests/models/buildingsmart/wall-with-opening-and-window.ifc` | 4 |

The bridge file actually declares IFC4X3; its folder name is not IFC5 evidence.
These inputs include committed invariant fixtures and real/sample model files;
they are not eleven independent authoring-tool certifications.

## Compared consumer fields

The [shared harness](../../../../tools/smlib-evaluation/scene-comparison/README.md)
collects the real full-pass public consumer outputs: all presented mesh fields,
including serde-skipped instance/local-bound/pose sidecars, UVs, texture pixels or
URL references and wrap flags, model metadata/georeferencing, full frames,
instances/templates, actual streaming events and deferred colors, symbolic/text
output in the returned frame with fill provenance, extracted data-model tables,
and semantic diagnostic aggregates. IEEE bits, option presence, UTF-8 strings,
128-bit identities, vector order and occurrence multiplicity remain distinct.
Source strings cannot impersonate float/identity tags. Map keys are ordered.

Baseline reproducibility and candidate equality compare actual structured records;
digests index them. The consumer checks actual instance-template references.
Required texture/UV, selected mapped-instance, FZK text and deferred-texture-style
witnesses prevent an empty output from qualifying those lanes. Remaining zero
features are disclosed, not promoted to coverage.

[Coverage](coverage.json) totals observations across request modes: 133 instances,
12 UV meshes, eight decoded-pixel textures, four URL textures, 12 type meshes,
260 texts, 5,436 polylines and five deferred color updates. These are not counts
of distinct source objects. [Pose/diagnostic witnesses](pose-and-diagnostic-witnesses.json)
include 776 nonzero mesh origins, 2,759 nonidentity local transforms, 133
nonidentity occurrence transforms, raw and site-local frames, georeferencing,
and 16 CSG failure observations. Exact records match for those outcomes as well
as successful geometry.

## Receipts and reproduction

- [Native summary](native-summary.json): all exact fixture/model digests, modes,
  semantic comparisons, base repeats, feature gates, witnesses and raw-file hashes.
- [Build receipt](consumer-build.json), [library pins](library-pins.json),
  [receipt/hash index](receipt.json): compiler, shared source, executable and
  numerical-library identity, plus final hashes.
- [Commands](commands.json): exact direct-rustc builds, comparison runs, finalizer,
  test commands and standalone clippy-driver invocation with `-D warnings`.
- [Five Rust tests](rust-tests.log): IEEE/sign/NaN payloads, wide identity/order,
  mixed string/float/option collisions, and UV/metadata/serde-skipped frame loss
  over actual IFC production geometry. [Three Python tests](python-tests.log):
  paired UV/order/multiplicity, absence/sign distinction, capability-loss rejection.
  [Clippy](clippy.log) exited zero without warnings; its empty log is intentional.

Raw structured JSONL/manifests are retained under local
`/tmp/ifclite-scene-{small,styles,real}`; executable/build metadata lives under
`/tmp/ifclite-scene-build`. Their exact paths, bytes and SHA-256 are in the
summary. Those large runtime records are **not included in a clean checkout**.
Historical production source IS reconstructible from the
[verified 226-file overlay](../geometry-platform-work/source-overlay.tar.gz) and
[its application metadata](../geometry-platform-work/source-overlay.json), applied
to pinned base `8acd0715a5ad266cd57808b9889f6549fbf93631` with the listed deletion.
Overlay SHA-256 is `8ac6de2769b386eacb8ed538a841329ed82173cd0bbde385471ca9cbbae3173d`.
Every archived source file was checked against the historical manifest. The
archive supplies source reproducibility, not the large raw records or binaries.
Rebuild in a separate checkout rather than substituting the later mapping tree.

## Scope still unqualified

No layer-slice or symbolic-fill output was witnessed. The heavy full-scene corpus
was not run; these runs are correctness measurements without speed claims.
The model-RTC frame variant and nonzero refused-input/prepass counters were not
witnessed in these cases. Failure chronology is not attributed per occurrence:
the full-pass API exposes aggregate diagnostics, not every source report or
per-element hash. Full source material/PBR definitions are not exposed by this
result; extracted associations and all presented appearance fields were compared.
Native external image-reference equality does not establish actual image asset
resolution or GPU sampling. The annex image sample's `texture.png` companion is
absent; archive asset resolution is recorded by the sibling lane.

The [IFCX/USD sibling lane](../../../../tools/smlib-evaluation/scene-comparison/ifcx/)
uses actual importer/export consumers and keeps separate inputs and capabilities.
Native STEP equality is neither unified-format qualification nor proof of that
lane. See the [scene qualification design](../../geometry-platform-scene-qualification.md)
for the shared-IR handoff and remaining all-consumer acceptance scope.
