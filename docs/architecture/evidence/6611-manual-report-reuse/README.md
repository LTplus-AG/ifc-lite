<!-- This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Saved manual report reuse (#6611)

Browser source: `fb2626532fce115e8ecc9df273c7159e0177f9f4`, actual main base
`bd0d02782b92581ed8e007effc9d00e37a09476e`. This archive adds evidence only.

[Browser capture](browser-capture.cjs) loads the real public
`building-architecture.ifc` (444 entities), and its real Rev B peer (474 entities)
through canonical file/demo inputs in independent fresh one- and two-model profiles.
A declared human checklist and initial answers are seeded through canonical store
actions; these verdicts are not inferred from IFC geometry. The two-model case
explicitly sets the peer active through the canonical action before recovery:
adding Rev B itself retains the original active model.

Actual UI actions save the original report, delete its live checklist, reload the
page to history only, reload the source with a new runtime UUID, choose **Edit a
copy**, edit the warning to pass and change its comment, then save a second report.
The copy defaults to the recorded fingerprint even while its peer is active.
The original full serialized saved report remains unchanged. The unanswered item
retains its comment. Snapshot recording time is only a fallback answer timestamp;
the original snapshot does not record each answer's edit time.

See [one-model original](1-original.png), [edited copy](1-edited-copy.png),
[two-model original](2-original.png) and [edited copy](2-edited-copy.png).
The original and edited snapshots are then chosen through the actual saved-report
source picker. See their actual [one-model original preview](1-original-pdf-preview.png),
[edited preview](1-edited-pdf-preview.png), [two-model original preview](2-original-pdf-preview.png)
and [edited preview](2-edited-pdf-preview.png).

The four completed browser downloads are [one-model original](1-original.pdf),
[edited](1-edited.pdf), [two-model original](2-original.pdf), and [edited](2-edited.pdf).
[Independent PyMuPDF inspection](pdf-inspection.json), produced by
[read-pdfs.py](read-pdfs.py), verifies the actual downloaded bytes: the original
has one pass, one warning and one unchecked answer; the edited report has two
passes and one unchecked answer. Guidance, original/edited comments and the
unchecked item's note are present. Download completion is checked in the capture.

Linux Chrome 153.0.8010.36 used software WebGPU. Fragment-shader/device-loss
warnings and the Rev B federation alignment warning were observed and are visible
in screenshots. This proves the data/document flow; it makes no hardware 3D,
GPU output identity or performance claim. Browser WASM witness SHA-256 is
`039415545e2448ce8b1e40b14306524ee60cff29dabd97448080ac0d9e170610`
(9,472,263 bytes), obtained from a separate HTTP fetch after operations. It is a
served-resource byte witness, not a hash of the original worker response body.
The legitimate normal root dev Turbo cache restored this runtime; historical
baseline runtime `a52aa07f…` differs, so no baseline runtime parity is claimed.
Rust source tree is `14b997e32f528eb3a916b6c320c9cebb901bafbe`.

[Complete raw browser facts](facts.json.gz) are losslessly archived, with original
byte length and SHA-256 in [artifact-manifest.json](artifact-manifest.json).
Read them with `gzip -dc facts.json.gz`. Both excluded harness attempts remain
outside this qualified cohort: an ambiguous duplicate preview locator, then an
incorrect active-peer assumption. Both closed their owned contexts; qualification
records their paths and reasons. No failed sample was substituted into this cohort.

[Qualification and exact log hashes](qualification.json) retain genuine baseline
seven assertion failures, final 14 new plus 75 existing passing cases, and the
meaningful existing model-picker regression caught and fixed without changing its
old assertion. The official production-revert oracle changes 14 pass to 14
assertion failures and verifies restoration. Plain root typecheck covers all 3,249
test files; full build runs 61 tasks, and root lint reports 8,139 files and no errors.
The ordinary full viewer suite remains required in fresh PR CI.


## Source readiness followup

[Readiness qualification](readiness-qualification.json) records the valid review
finding and exact source `086418ac845bffb1be376b407d8c4c163d351a55`. Recovery,
automatic recorded-model defaults and bound document Refresh share one readiness
predicate: a matching model must be complete, or a legacy model with no load
state. A completed identical-file instance wins over an earlier failed/loading
instance. Explicit selections and ordinary unbound defaults retain their policy.

Real mounted one-/two-model controls cover pending, streaming, hydrating, error,
complete and legacy states, plus duplicate-file selection and actual Refresh.
All 105 focused cases pass; the readiness production-revert oracle changes 30
passes to 18 passes and 12 assertion failures, with restoration verified.
The browser/PDF archive above remains attributed to its original `fb2626532`
source. Those original facts, images, downloads and PDF inspection bytes are
unchanged; this followup does not claim a new browser capture.
