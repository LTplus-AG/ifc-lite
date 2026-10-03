<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Standalone symbolic buffer-input qualification (#6537)

[Hosted run 37157226416](https://github.com/LTplus-AG/ifc-lite/actions/runs/37157226416)
completed at source `88e26da7f9bc02eb0add8aabb010af98f380b3c2`.
The independent audit passed all 73 checks without findings. This is a
standalone diagnostic qualification, not a benchmark or renderer verdict.

Six actual GPU readbacks match independently reconstructed varied seeds and
partial-write destinations, plus recorder shadows. Original vertex/uniform
usages remain 40/72. The real source mutation and changed-byte refusals,
complete shader diagnostics, intentional final destruction, prototype
restoration, raw log drain and owned process cleanup are retained.
Ordinary DBus stderr remains present; the raw graphics-backend scan found no
errors. No raw artifact or failed predecessor receipt was rewritten.

The authored-text refusal remains unchanged. IFC annotation/parser/renderer
completeness, atlas texels, screenshot/pixel fidelity, timed comparator
integration and performance remain **UNQUALIFIED**. Remote executable hashes
and PID/start witnesses were observed during the run, not independently
rehashed after termination. Declared source/Node inputs are not a complete
machine or dependency closure. Strict post-freeze continuation remains unimplemented.

`retained-hosted.tar.gz` preserves all seven artifact files, complete job-v2.log,
run metadata, original independent audit/outputs, exact qualified source bytes,
source-freeze-v3 proposal/command receipts and initial prerequisite refusals.
Its proposal UNRUN statements are historical, not the current qualified scope.
No IFC files, binaries or installed packages are included. `manifest.json`
records every original member size/SHA256 and the compressed archive hash.
Gzip and tar timestamps are zero; safe regular-file extraction and lossless
roundtrip were verified. `verification.json` and `replay.stdout` retain results.

Replay without browser/model/build work from a Git repository containing the
qualified commit:

```bash
python3 scripts/perf/evidence/symbolic-upload-gpu-6537/replay-audit.py
```

The adapter changes only the original audit's checkout location through its
parsed assignment, verifies all archived member hashes and requires byte-identical
qualification output. Original audit bytes stay inside the lossless archive.
