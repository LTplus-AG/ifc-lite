<!-- SPDX-License-Identifier: MPL-2.0 -->

# Imported upload-mode consistency (#6993)

The timing checker and baseline updater both use the shared
`requireTimingUploads` helper. Previously, `environment.uploadMode: timed`
overrode `loadCounters.uploadMode`, allowing a conflicting count or invalid
legacy declaration into timing comparisons and baseline refreshes.

Each present declaration must now be `timed`. Missing tags retain the legacy
timing default. The actual checker and baseline-import tests reject conflicting
count, unknown and null tags, preserve the previous baseline bytes, and accept
matching timed declarations. No viewer upload policy changes.

The four focused Node suites pass 40 cases with no skips. Reverting the shared
helper to exact base `90c40f410bc0fd5203a55892c013827d796624f9` causes six
assertion failures and 34 passing controls; restoration passes all 40 again.
[inverse.json](inverse.json) pins the helper and exit codes. The adjacent text
logs retain all assertions, with whitespace trimmed. Focused oxlint, module,
license, source-test and generated-documentation gates pass.

The count-cohort README also corrects its aggregate-write statement:
`mutableWriteBytes` repeats in each committed fixture pair. Those measurements
do not establish schedule-independent aggregate writes. This correction makes
no new GPU measurement, timing claim or throughput claim, and does not resolve
the other outstanding worker-post and device-lifetime qualifications in #6993.
