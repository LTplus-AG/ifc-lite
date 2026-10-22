# Current-parent symbolic qualification and approved cost (#7914)

This is evidence for corrected production source `64430aa0ed686671037679aeb51a8ba824f811bb`
against actual parent `46cc72ff79ad88569409f42d9d0ce81171ba771c`.
It does not qualify a later main integration or every intermediate publication layer.
The exact measured sources are publicly retained under the qualification tags below.

The separate [publication-layer checkpoint](publication-layers.md) records T's
completed functional, output-witness and instruction checks. The subsequent
[per-layer wall result remains HOLD](publication-layer-performance.md).

The three measured, identically instrumented source pins are:

| Arm | Source | Meaning |
| --- | --- | --- |
| A | [cf73cfca5566](https://github.com/LTplus-AG/ifc-lite/tree/qualification/bf7d2a91-7914-measured-a) | Actual parent plus common public-symbolic probe |
| B | [35b7a6f53772](https://github.com/LTplus-AG/ifc-lite/tree/qualification/bf7d2a91-7914-measured-b) | Unoptimized terminal/frame correction plus identical probe |
| C | [64430aa0ed68](https://github.com/LTplus-AG/ifc-lite/tree/qualification/bf7d2a91-7914-measured-c) | Corrected source with fresh boolean stop polling |

## Original observations and acceptance

The fixed cohort contains all 840 commands: 288 absent-authority symbolic calls,
72 native calls and 480 active-authority symbolic calls. Native calls have five
inner loads; the process median, not an individual load, is the paired sampling
unit. Symbolic calls each execute once in a fresh process. The protocol, complete
schedule, all rows, original summaries and fixed-seed statistical routine are
retained without replacement samples or retrospective threshold changes.

C versus A on symbolic Holter has paired-median cost **+3.129422%**, with the
marginal 95% block-bootstrap interval **[+2.758395%, +3.709752%]**, and 23/24 blocks
slower. Active source/both comparisons also have adverse observations. These are
real disclosed costs; native phase instruction success does not execute or
qualify this public-symbolic path. Full-output B/C witnesses match across all
fixtures and modes. A/C Haus/Holter match; two near-zero Duplex coordinates and
606 coordinates across eleven corrected ISSUE129 curves differ, with no other
structural/count/metadata changes in that bare symbolic payload.

The maintainer explicitly approved the two reported performance tradeoffs in the
controlling session; [the charter records the exact scope](https://github.com/LTplus-AG/ifc-lite/issues/7779#issuecomment-6336123269).
C's measured correctness cost is **accepted**, not statistically neutral or
regression-free. The original `final-audited-hold-v1.json` is preserved as an
original-time disposition; the separate approval record supplies the later
acceptance decision. The separate #7880 exception is exact-source/phase only.
Other phase limits, parent wall qualification, correctness, review and required
main checks remain applicable. Rejected experimental implementations stay rejected.

## Correctness and consumer scope

The retained audits bind C's full native workspace, strict Clippy, fresh official
WASM and generated types, root Turbo build/typecheck/tests, real-WASM contracts,
excluded native consumers and mutation-sensitive stop controls. Optional native,
fixture/service and historical-fingerprint skips retain their original scope.
The eleven corrected real-model curves also pass the frozen independent authored
curve oracle through actual official WASM at the original 0.1 mm tolerance.

All six canonical browser cases pass with strict GPU handling and zero skips,
unexpected failures, flaky cases or retries. Production C and all 974 frozen
viewer files are unchanged. Harness-only `f51e4674b09f7717f714a0377627840337f42174`
adds optional-call polling for debug-hook readiness, preserving the original
triangle, precision, picking, color and remaining assertions and timeout.
Independent review found no actionable issue. The original five-pass/one-failure
browser attempt remains preserved, along with the failed diagnostic setup.
This is reposition/census/federation coverage; the separate actual-WASM oracle
specifically checks the eleven corrected curves.

## Reproduce the retained arithmetic

Run from the repository root with Python 3:

```sh
python3 -B tests/evidence/f3b-recovered-symbolic-7779/current-parent-64430/replay.py
```

The replay verifies every document's original and compressed SHA256. It separately
replays the historical 840 observations, twenty groups and 36 contrasts, and the
new 360 observations, eight groups and 24 contrasts, using each cohort's original
10,000-draw whole-block bootstrap. It does not pool observations, execute models or manufacture
raw custody. The manifest contains one original document per gzip member; no
runtime, source tree, credentials, build target or dependency tree is bundled.

Raw process stdout/stderr, binaries, tools and Callgrind dumps are separately
retained. This packet therefore supports data/statistics replay, not independent
reconstruction of all compiler-to-binary or raw-instruction derivation claims.
The original 19-document private selection is verified under manifest
`pop-os-bf7d2a91-7914-current-parent-measurements-v1-selected`, SHA256
`8314a87875a2389cc1d8178c3c4f1c925ce754c9271bf6739cad11bac3f3128d`,
with an explicit 30-day pin. Failed publication attempts and raw evidence remain.
Historical packets remain available from the existing public source history;
the original reports are not silently rewritten to qualify this source.
