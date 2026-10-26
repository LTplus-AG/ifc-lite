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
| [v3-qualified](v3-qualified) | AC20-FZK-Haus, dental_clinic, ISSUE_053 Holter Tower | **Qualified.** Identity matched; no phase moved beyond the noise floor (TOTAL -0.4% to +1.7%, all within noise); no fingerprint drift, no noise rejection, no inconclusive flag. |
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
