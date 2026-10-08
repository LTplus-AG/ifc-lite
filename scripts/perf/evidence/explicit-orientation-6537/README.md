# Known-explicit orientation: rejected, do not ship (#6537 / #6788)

The candidate is rejected. In the fresh integrated default-worker SDK cohort,
**every Holter A/B pair was slower**. Earlier ISSUE129 benefit and mixed native
results do not waive that regression. The PR restores all eight orientation
source/test/guard paths to reviewed main
`515c8892efc07229d0006f4758a0914b26721a8d`, including removing the candidate-only
`predicates_tests.rs`. No orientation implementation, new runtime reader or new
benchmark is shipped by this disposition.

## Immutable cohorts and source attribution

| Cohort | Literal BASE / CAND | Outcome |
| --- | --- | --- |
| Historical SDK [37167109427](https://github.com/LTplus-AG/ifc-lite/actions/runs/37167109427) | `187a72e3302447fc49f2264111501223238a24a7` / `672f1e09c06ce777507244d2f2c4403d7b38c098` | ISSUE129 improves in all five pairs; other families mixed. |
| Historical native [37182263516](https://github.com/LTplus-AG/ifc-lite/actions/runs/37182263516) | same historical subjects | Qualified native phase comparison, small mixed changes. |
| Integrated SDK [37194313221](https://github.com/LTplus-AG/ifc-lite/actions/runs/37194313221) | `8ab47142562a79862df6d14700a39723351f00df` / `89d7976bb9f0ab02b82052468e2d1b052502eb7d` | All five Holter pairs slower: do not ship. ISSUE129 improves in all five; Haus and O-S1 mixed. |

The integrated SDK controller is
`4d47506a23e304ed4b772f7890e27e37843e8914`. Its fresh source builds and 56 fresh
Chrome samples retain all 28 declared pairs: two A/A controls then five alternating
A/B pairs per family. All A/A controls qualify; complete unnormalized diagnostics
and observed flat/instanced CPU channel hashes agree within each family. The
independent receipt audit passes 1,508 checks, and literal Git/retained-closure
verification passes 59,982 checks. Every paired value, including outliers, remains
in the original report and qualification JSON; no cohorts are pooled.

Freshly source-built BASE and CAND WASM artifacts differ. The comparison rejects
the candidate combination; it does not isolate orientation dispatch as the cause
of the Holter slowdown.

Later candidate integration head `4361d08d92c03ea53aaaa940ae6fde8533f7f2f1` is
retained as history, not relabelled as measured `89d`. Source restoration and
archived patch reproduction prove removal of the candidate, not a new performance
measurement. The issue remains open; this record rejects one mechanism.

## Discoverable lossless payloads

- [Original correctness and failures](correctness.tar.gz): unchanged 26-member
  source/correctness packet, including disk refusal and initial compile failure.
- [Historical SDK and native first refusal](sdk-and-native-refusal.tar.gz):
  unchanged original container, including compiler-query refusal and cleanup.
- [Qualified historical native packet](native-qualified/README.md): unchanged
  native container and receipts, including prior summary/controller failures.
- [Historical support](historical-support/README.md): lossless original readers,
  manifests, indices and previous Markdown. These are archived data, not installed
  executables or current-status claims.
- [Integrated SDK rejection and reproducible patch](integrated-sdk-rejection/README.md):
  original official ZIPs, every logical member hash, complete job/run logs, APIs,
  independent audit sources/results and the rejected eight-file source patch.

The original payload archives and gzip QA receipts remain byte-exact at their
published paths. All new gzip headers have mtime zero. Index JSON is compressed
as inert data; no newly added standalone `.py` or `.json` file remains. Data-only
validation uses the previously qualified reader outside the repository and never
executes archived source. Each archive includes its bounded hash manifest.

## Limits and preserved failures

SDK identity covers the observed produced CPU channels, not regenerated meshes,
IFC authored text, metadata, final GPU buffers, pixels or full-viewer readiness.
The pool is the observed default two-worker pool on the hosted four-core runner.
RSS is a sampled owned-process sum, not physical peak or comparative benefit.
Remote compiler/installed closure checks retain producing receipts; the removed
runner cannot be independently rehashed afterward. Native FNV excludes UV,
material, texture, text and instancing channels. Native and SDK diagnostic counts
have different scope and are not a cross-protocol fidelity oracle.

Disk, compiler-query, summary-controller, dependency and provider failures stay
failures. The new package also retains raw collection's initial unqualified
status, historical review bodies and the later successful audits as separate
bytes. No failure is rewritten as success, and no unchanged measurement is rerun.
