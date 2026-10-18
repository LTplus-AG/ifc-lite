<!-- SPDX-License-Identifier: MPL-2.0 -->
# Holter: completed comparisons, final audit pending

Four actual native Holter cases passed the existing structured comparator:
`full`, `stream`, `instanced` and `fastfirst`. Each candidate matched pinned
baseline, and an independent baseline repeat matched, across all semantic
records. This is **partial qualification**: final raw-file rehash and the
supplemental execution-record audit were not admitted and did not run.

The input is the actual
`ISSUE_053_20181220Holter_Tower_10.ifc`, SHA-256
`d8cc92c00ba634d9f25f3d00185136cbc34f3b14f2cc552634551997ddc148f8`.
The [prelaunch checks](input-verification.json) verified all 288 frozen source
hashes, fixture hash, linked libraries and executable hashes. The
[post-run source check](source-after.json) again verified the same source bytes
against [the final manifest](../source-manifest-ratchet-corrected.json).
The original build receipt in the support archive retains its earlier manifest
identity; only subsequent test-allowance metadata changed. No numerical library
or executable was rebuilt for this witness.

## What actually matched

[Actual comparison results](comparisons.json) retain candidate and baseline
witnesses, semantic differences, repeat outcomes and capabilities. The comparator
read structured records, preserving IEEE bits, options, ordered vectors and
occurrence multiplicity. Compared channels include presented mesh fields and
frame/instance sidecars, streaming event order, deferred colors, model metadata,
properties, material associations, text/symbolic output and semantic diagnostic
aggregates. This is broader than mesh-hash equality, and remains limited to the
exposed public full-pass result.

Full, stream and fastfirst each returned 109,514 meshes, 2,895,362 triangles and
4,515,161 vertices. Instanced mode returned 103,885 materialized meshes and
5,629 actual instances. Every mode witnessed 11,760 text observations,
3,568 polylines, 80,155 property sets and 69,819 material associations.
Fastfirst also witnessed one deferred color update. Counts describe each
requested output, not distinct objects summed across modes.

UV meshes, pixel/URL textures, layer meshes, type meshes and symbolic fills
were zero in these cases and are unqualified here. Per-element hashes and
per-occurrence refusal chronology are unavailable at this public boundary.
Full source material-definition graphs and external image resolution are not
established. Native output equality is not viewer, IFCX/USD, GPU or all-scene
qualification.

## Admission and pending checks

The numerical runs and their existing comparator chains started before the
fleet policy update and were allowed to finish as existing legacy work. They
were **not fleet-admitted runs**. Each used one worker and a 600-second timeout
per numerical subprocess. The first full-mode pilot completed before expansion
within its recorded resource envelope. This observation justified feasibility;
it is not a speed comparison or performance verdict. Remaining modes ran concurrently.
Exact resource logs and commands are retained in [support](support.json).

The subsequent finalizer/audit chain was submitted through `ifc-fleet` and
[refused](fleet-refusal.json) because available disk was below the required reserve.
No bypass, retry, replacement audit or raw cleanup was performed. Consequently:

- Raw records, libraries and executables have no independent post-run finalizer
  rehash assertion in this receipt.
- The shared comparator excludes the `execution` channel. Its one recorded
  execution difference per candidate case was not independently audited here.
- CSG census multiset equality and statistics differences restricted to the ten
  documented timing/cache fields remain pending; no chronology claim is made.

[Support archive](support.tar.gz) retains exact small terminal summaries,
comparisons, logs, producer/comparator sources, original build receipt and the
**unrun** finalizer/audit chain. [Raw inventory](raw-inventory.json) records sizes
and local paths only; the large immutable raw output remains in `/tmp`
and is absent in a clean checkout. No enormous raw output is committed.
