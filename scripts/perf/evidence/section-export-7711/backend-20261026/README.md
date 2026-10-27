<!-- SPDX-License-Identifier: MPL-2.0 -->
# Paired native performance verdict for the section-export backend (#7711)

Source `9597ecb45ea648c3f3e2c6cb077dcb7fcfcca7f6` (backend #8006 head) against
main `8e2778ca041f027ab95d59532ce43d18bb42dab6`, measured on Pop with the
reviewed `ab.sh` protocol: exclusive benchmark admission, five balanced paired
rounds, ordered geometry FNV/count identity check before timing, explicit
checksum-freshness preparation. Scope is the native `perf_probe` processing
path only; it is not a WASM, viewer or GPU measurement.

| cohort | fixtures | outcome |
| --- | --- | --- |
| [v3-qualified](v3-qualified) | AC20-FZK-Haus, dental_clinic, ISSUE_053 Holter Tower | **Qualified.** Identity matched; no phase moved beyond the noise floor (TOTAL -1.3% to +1.7%, all within noise); no fingerprint drift, no noise rejection, no inconclusive flag. |
| [v2-inconclusive](v2-inconclusive) | AC20-FZK-Haus, ISSUE_129, ISSUE_053 Holter Tower | **Not qualified, retained.** Identity matched and totals were within noise (-0.4% to +1.6%), but ISSUE_129 `lookup/styles` was 0.0 ms on both sides, below timer resolution, so the protocol refuses to certify. One 3% entity-scan *improvement* on that fixture was flagged. |

v3 is a distinct follow-up, not a retry: v2's outcome was known and complete,
and the only change was replacing the fixture whose phase fell below timer
resolution with one whose phases are measurable. v2's result was neither
overwritten nor discarded. Original job receipts (SHA-256):
v2 `fc4bf798-a57d-4605-ba6d-6dfda7ded2ff` `0693481afd8fb6dc5c5161aa7be802d27454f782553d3b848412ba81959d65fa`,
v3 `ffb60111-ae27-4e3e-b8ed-d6ccc3247e4a` `cc28601de5c646c25e5aa36806b89f04f5d6aeee934efcaf04db6fb8249201c7`.

This supersedes the never-executed `issue7711-checksum-v1` cohort (admission
timed out before it started) for the current backend head. The qualification
does not replace mesh byte-identity qualification, and the identity check
excludes text metadata, materials, UVs, textures and instancing.

## Recompute the v3 report

The v3 packet now retains its own [original receipt](v3-qualified/receipt.json),
[30 raw per-side/per-fixture samples](v3-qualified/measurement/runs.jsonl),
[exact measurement shell command](v3-qualified/measurement/measure.sh.txt), and
[cohort entry point](v3-qualified/cohort.py.txt). The `.txt` suffix marks archived
command text, not a new executable. [SHA-256 values](v3-qualified/reproduction-hashes.json)
verify these bytes. The receipt hash matches the original value above; its
artifact inventory independently pins the raw samples and cohort entry point.
These files belong to v3 job `ffb60111-ae27-4e3e-b8ed-d6ccc3247e4a`, not the
older aggregate archive in the parent directory.

From the repository root, recompute the numerical report without a benchmark:

```sh
node scripts/perf/ab-report.mjs scripts/perf/evidence/section-export-7711/backend-20261026/v3-qualified/measurement/runs.jsonl --base 8e2778ca041f027ab95d59532ce43d18bb42dab6 --branch 9597ecb45ea648c3f3e2c6cb077dcb7fcfcca7f6 --json /tmp/section-export-v3-report.json
```

Use the reporter revision hash pinned in `v3-qualified/plan.json`. Recomputing
samples checks the numerical verdict; it does not recreate historical host
conditions or replace the original qualification receipt.
