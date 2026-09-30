<!-- This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Opening work investigation (#6516)

The private model reported in #6516 is unavailable. Public witnesses reproduce
related release-boundary work increases; they do not establish the private
model's complete cause or reported slowdown factor.

## Corrected geometry qualification

The primary distance evidence uses the corrected cross-product barycentric
reproducer (`compare-surfaces-6516.py`, SHA-256
`c02224d8d831974baaa585631ee676523e3b4b0c4f9fd3807c955b99d5f4bce6`). Its
independent known answers cover thin-triangle interiors, outside edges,
degeneracy, unused buffer vertices and BVH/brute-force agreement. The nine
reports under `surface-review-correction/` were freshly generated with that
source and the pinned IfcOpenShell reference data; each retains all six directed
comparisons and all three sample sets, input/reference hashes, metadata,
coordinate adapters and geometry diagnostics. The 14 changed native Revit parts
are recorded in `native-rvt14-changed-parts.json` in the same SiteLocal frame;
they retain closed, coherent edge incidence and a maximum finite-point
difference of about 13.73 µm.

The public 455 witness is IfcOpenShell/files commit
`9fc2267d7f1ff35284c5b0fc28cc97bff7ace8e7`, input
`455--wall--infiniteLoop--augmented.ifc`, SHA-256
`684309f75c09c100b357f8a4d1ddf33c47d8b770b8c2187a77e68813297d6053`. The
corrected 455 base/candidate maximum is about `4.82e-14 m`; that does not prove
continuous surface equality or valid solid topology. The independent reference
still has an approximately 1.25 mm worst reverse sample discrepancy, and the
ISSUE_068 candidate remains slightly farther from its reference in its worst
forward sample. These finite samples do not prove continuous surface bounds or
exclude self-intersections; no topology threshold or oracle expectation was
relaxed.

The pre-correction `current-v3-independent-qualification.json` is superseded and
is not the primary qualification. Its immutable historical copy and the older
rejected outputs remain in the [supporting archive at the original
head](https://github.com/LTplus-AG/ifc-lite/tree/b4c7c530bee14e4ad9277320a7339bc145aca68e/scripts/perf/evidence/opening-work-6516).

## Work and performance evidence

On public 455, release 6 performs one group subtraction and no single cuts;
release 7 repeats two single cuts after discarding an unchanged group result.
The retained candidate keeps the completed conforming group retessellation only
when welded operands exactly match sequential-kernel operands. Uncertain misses,
altered operands, same-count misses, multi-chunk groups, budget rejection and
the existing retention floor keep their prior fallback. Exact surgical-revert
oracle mutations are retained under `revert-oracle-mutations/`.

Source-matched counters show the public 455 feature build reduces CSG
invocations from six to two, removing four repeated single arrangements. This
establishes removed work, not an end-to-end gain. The [primary browser
report](browser-ab-v3-report.json) shows a target worker-stream signal, but the
whole metadata-plus-render comparison is too noisy to qualify speedup or
neutrality. `primary-timing-samples.jsonl` retains 50 primary browser and 50
native paired observations, output counts/fingerprints and runtime identifiers.
The [census verdict](census-verdict.json), [browser output
identities](browser-output-identities.json), and [measurement
provenance](measurement-provenance.json) are part of this PR's qualification.
Native phase results are attribution, not a substitute for browser worker-pool
results. The private reporter's complete slowdown remains unresolved; no
committed benchmark baseline changed.

Raw run logs, process host-load observations, bounded A/A controls, release
comparisons, rejected approaches and older surface outputs remain in the
[supporting archive at the original head](https://github.com/LTplus-AG/ifc-lite/tree/b4c7c530bee14e4ad9277320a7339bc145aca68e/scripts/perf/evidence/opening-work-6516).
The timing projection records source-log hashes; the archive retains full
commands, environments and host observations. The [performance
ledger](../../README.md) carries the same limited verdict.
