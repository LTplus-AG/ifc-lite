# Rejected owned server mesh batches (#4066)

The candidate transferred non-retained mesh batches into the existing server
channel instead of cloning their owned buffers. It used the same canonical
processing loop and preserved the borrowed API, retained output, batch/progress
boundaries, styling and cancellation. It was rejected by the prespecified actual
HTTP continuation rule. No production implementation or wider corpus run landed.

[screen.json](screen.json) contains every arm of the initial three-model screen,
its exact gates, separate startup/readiness clocks, sampled RSS, continuation
rule, source/artifact/compiler identities and validation limits. The small model
and MEP model were slower in their single pairs; the largest model improved
modestly while its sampled RSS increased. These observations neither establish
precise causal contributions nor justify a general claim that ownership transfer
cannot help. Removing a real copy does not by itself establish an end-to-end win.

All three models passed the declared complete semantic witness, strict raw
geometry/data-model comparisons, actual hash-only cache replay and cleanup gates.
No diagnostic mismatch was waived. The primary clock ends when complete SSE and
data-model receipt both finish; startup is separate. This is HTTP qualification,
not browser readiness or physical-footprint evidence. Every offline decode and
retention operation occurred after both timed arms. The isolated verifier reused
only complete byte-equal inputs with validated witness/version identities;
current completion and transport fields were independently checked.

The workspace tests and strict workspace/all-target Clippy passed on the exact
candidate. Downloaded external fixtures were absent: the preserved test evidence
records ignored tests and fixture-skip messages. Inline/committed-fixture tests
exercise ownership, both APIs, retained output, styling/progress/bootstrap
sequences and cancellation. They complement the actual HTTP cases and are not a
substitute for corpus qualification.

## Reproduce the rejected source

[measured-candidate.patch](measured-candidate.patch) archives the complete local
candidate, including its tests and Rust API documentation. It uses zero-context
full-index Git format so patch-context blank lines do not trigger the repository
whitespace gate. In an isolated checkout at the public base recorded in
[source-archive.json](source-archive.json), run:

```sh
git apply --unidiff-zero /path/to/measured-candidate.patch
```

Temporary-index application reconstructed the **exact measured candidate tree**.
The public base's Rust/server/Cargo source also matches the measured control.
The archive records these identities and the patch digest; applying it is not a
new build or performance measurement. The candidate used the same pinned
compiler, explicit standard-library build configuration, target and release
profile as the control, with no PGO inputs.

Raw captures and complete private logs remain retained; repository evidence
contains sanitized measurements and their hash references, not those large
payloads. Exact duplicate evidence files share APFS extents while retaining
separate paths and inodes. No unique raw evidence was removed.
