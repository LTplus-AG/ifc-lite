<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Direct packing verdict and interrupted admission comparison (#6537)

**Decision: do not ship the current packing candidate as a performance
improvement.** The candidate's eligible-batch allocation reduction is real,
but the real-model timings do not establish a general speed win. This commit
records evidence; it does not change the renderer or scheduler. #6537 stays
open, including the scheduling comparison and remaining feasibility work.

## Source and runtime identity

Both experiments use frozen main `9400cb6c952ba200e165c1dadbd95f9d28fca927`.
Packing uses candidate `6e9cb8da4cb9ee995121ba9a7d051e25b2ca62a3`; scheduling
uses `982da209b3a07da924d4c0af566aebbe7fe749e9`. Both were built normally
through the root Turbo dependency graph. The served WASM asset on all three
builds is SHA-256
`039415545e2448ce8b1e40b14306524ee60cff29dabd97448080ac0d9e170610`;
the unchanged Rust tree is `14b997e32f528eb3a916b6c320c9cebb901bafbe`.
No artifacts were copied between builds. These observations apply to those
frozen sources, not later main commits.

`source-correctness/source-qualification.json.gz` is the historical premeasurement
receipt. It records four genuine staging-allocation assertion failures on the
test-only baseline, the candidate's thirteen passing new cases, eight frozen
baseline GPU-byte SHA controls, full root build and typecheck, and unchanged
API surface. Two skips are existing optional renderer cases. A full root lint
run was not completed for the unshipped candidate. The archived patch contains
the entire baseline-to-candidate change; it is not applied by this PR.

## Native observations and their limits

Windows Chrome 154 used a nonfallback NVIDIA adapter with foreground visibility
and frame cadence recorded for each sample. Every model was the first load in
a fresh browser context and tab through the canonical file input. Each planned
family has five alternating base/branch pairs, preceded by five house A/A
pairs. Every sample has a Linux graph/dev-server CPU check before and after;
idle Linux observations do not prove an otherwise idle Windows operating
system. The timestamps measure input to observed metadata/stream completion
and renderer finalization, followed by a GPU color-frame artifact.

Packing v3 preserved 49 of its declared 50 rows. Row 48, the final Snowdon
baseline, failed the sample-end host guard. The fifth Snowdon candidate was
never loaded. The first 48 rows passed the recorded checks: five complete A/A
pairs, five A/B pairs for each of house, Holter and O-S1, and four Snowdon A/B
pairs. The complete family groups can be inspected separately, but the overall
four-model cohort is **unqualified and incomplete**.

| Group | Qualified pairs | Median paired full-ready delta | Paired range |
| --- | ---: | ---: | ---: |
| House A/A control | 5 | -0.970% | -1.855% to +1.180% |
| House packing A/B | 5 | +0.474% | +0.069% to +0.832% |
| Holter packing A/B | 5 | +2.731% | -0.229% to +7.690% |
| O-S1 packing A/B | 5 | -1.225% | -5.573% to +1.410% |
| Snowdon packing A/B | 4 of 5 | incomplete; no five-pair verdict | incomplete |

Positive values mean slower. These are descriptive paired observations, not
confidence intervals or a proof that a small delta is significant. Holter is
slower in four of five observed pairs. The unchanged output counts and FNV-32
of sorted complete CPU positions, normals, indices and appearance are recorded
per sample and compared per pair; all completed packing pairs match. House GPU
frames match byte for byte. Heavy-scene GPU batch sizes/LOD and frame hashes
vary even among baseline samples, so heavy-scene GPU/pixel identity is not
established. A possible extra float-fallback scan remains a hypothesis, not a
measured cause of Holter's timing.

Heap is the maximum rAF-sampled Chrome `usedJSHeapSize` before first readiness,
not physical RSS, WASM linear-memory peak or an unsampled allocation peak.
Worker WASM response URL/status is observed during the load. Asset bytes are
fetched and hashed from the same immutable no-store server after the timed
snapshot; those hashes are served-resource witnesses, not captured original
worker response bodies. Primary `loadState` becomes complete while per-model
geometry/metadata phase fields still say opening/idle; those fields are
disclosed, and the actual global completion milestones determine readiness.

Admission v1 preserved ten valid A/A rows followed by one invalid baseline
A/B row. Another session's viewer build appeared at the sample-end host check.
No admission candidate A/B sample ran, so this attempt has **no scheduling
performance verdict**. Its A/A data is not pooled with packing.

## Preserved exclusions and independent derivation

The archive includes packing v1 (incorrect launch after a failed preflight and
an unavailable worker response body), packing v2 (foreign E2E activity detected
after its first sample), packing v3 (incomplete final pair), and admission v1
(foreign build detected after the first A/B baseline). Their original schedules,
rows, logs, exclusions, screenshots and harnesses remain intact. Nothing was
substituted or pooled across attempts. The exclusively owned browser context
was closed on each terminal outcome; no foreign session was stopped.

`raw-cohorts.tar.gz` stores identical PNGs once by content hash. Its
`raw-file-index.json` maps every original path to the stored bytes, length and
SHA-256. To reconstruct in an empty scratch directory after extracting:

```python
import hashlib, json, shutil
from pathlib import Path
for name, info in json.loads(Path('raw-file-index.json').read_text()).items():
    original, stored = Path(name), Path(info['stored'])
    data = stored.read_bytes()
    assert len(data) == info['bytes']
    assert hashlib.sha256(data).hexdigest() == info['sha256']
    if original != stored:
        original.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(stored, original)
```

Run the independent analyzer against reconstructed packing v3:

```bash
gzip -dc /path/to/evidence/analyze.py.gz > /tmp/packing-analyze.py
python /tmp/packing-analyze.py cohorts/packing-v3 \
  6e9cb8da4cb9ee995121ba9a7d051e25b2ca62a3 > packing-derived.json
```

**Exit 1 is expected:** it reports the interrupted cohort rather than silently
dropping the invalid row. The analogous admission command uses
`cohorts/affinity-v1` and `982da209b3a07da924d4c0af566aebbe7fe749e9` and also
exits 1. The committed derived JSON archives retain the original capture paths.
The `.json.gz` files expose the
recorded results after decompression. All executable diagnostic helpers and raw
JSON are archives, consistent with the existing evidence-only file contract;
none is installed, imported or executed by the application or CI.
`artifact-manifest.md` verifies committed evidence files; the archive index
verifies reconstructed originals. Harnesses contain the original local paths,
ports and CDP endpoint, so a new machine must configure its own builds, fixture
server and browser before attempting new measurements.

## What would justify another experiment

Measure eligible packed vertex volume and actual receiver/finalization cost
before modifying packing again. For admission, finish a separate fresh paired
cohort and inspect idle gaps and held jobs; existing key ownership can still
leave one heavy key as the tail. Do not trade bounded buffers for unmeasured
retention or slower renderer completion.

The bounded Astra source review recommended measuring discarded relationship
attribute construction before a checked reference-pair projection, and proving
complete source access/dependency closure before compact worker packets. The
remaining-mechanisms JSON is explicitly a source-only plan: there is no
instrumentation or result yet. Original-offset decoding, setup/style scans,
recovery, malformed-input validation and peak memory must all be accounted for.
Observed access unions alone cannot prove a safe partial-source closure.
