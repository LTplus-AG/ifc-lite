# Recording checker integration V6

This prospective successor fixes two integration errors in the V5 supplemental
join. It also enforces the preserved policy's cohort-wide video timebase gate,
which V5 omitted. It does not launch a benchmark or revise any historical cohort verdict.

The cadence and optical marker joins now share the reviewed first-frame rule:
every timestamp is finite, nonnegative and at or before probe completion; only
the first may precede registration. Later callbacks retain the registration
lower bound and strict ordering. All 59 cadence intervals still require
30 Hz ±3%. Focus, visibility, deadlines and every other V5 gate remain required.
This frame rule matches `native-recording-history-v6/validate-first-frame-class.py`
(SHA256 `e8a9da44acdbcd2987c32387a87130d2dd45499e6018fbcb46588a33ba8bfc79`).

The join reads each finalizer output directly at
`COHORT/case-NN/SAMPLE_ID.recording-frame-class-reviewed.json`, where NN is the
zero-based position in the immutable plan. There is no staging/copy step and no
fallback to an older sidecar. Missing or mismatched receipts fail admission.

Every admitted video's raw ffprobe stream timebase must be a positive rational,
equal its inspected timebase, and match the first admitted video's timebase.
Optical detection already binds its timebase to that inspection. A differing
timebase anywhere in the 30-row cohort fails admission, even when each video's
individual inspection and optical receipts agree.

For a future complete cohort, run:

```sh
node join.mjs PLAN.json COHORT ORIGINAL-STRICT-SUMMARY.json NEW-OUTPUT.json
```

Before capture, the new plan must freeze this `join.mjs` as `checkerSha256`,
`anchors.mjs` as `anchorJoinSha256`, `contracts.mjs` as `contractsSha256`, and
this README as `policySha256`, along with all existing V5 policy/helper refs.
Pin the actual first-frame reviewer above as `nativeHistoryValidator` for both
Holter feasibility and timed lifecycle reports. Keep original collector,
reporter, source, full 30-row, host, media, output and noise gates unchanged.
The complete V5 policy remains preserved in
[policy-v5.md](policy-v5.md); V6 changes only the two
integration contracts and the omitted timebase enforcement described here.
Do not repin old plans to obtain a pass.

Focused verification (no browser or new timings):

```sh
node --test contracts.test.mjs
node verify-retained.mjs /absolute/path/to/retained/cohort
```

The latter checks real retained sidecar discovery and frame contracts, reporting
missing rows explicitly. It never grants recording or performance acceptance.
It does not repeat historical media decoding or geometry verification.

Retained diagnostic: all 17 finalized rows from the October 16 06:00 Zürich
cohort are discovered in place and pass the shared frame rule and unchanged
59-interval/focus checks. The other 13 rows have no finalized recording (one
failed admission, twelve unlaunched). This is integration evidence only; the
original cohort remains failed. No new capture is scheduled. The JSON report
retains original paths and SHA256s; those local recordings are not republished.

The initial independent bounded review of V6 against V5 found no blocking defect. It
confirmed that the original 34 helper-freeze files and all 17 referenced
sidecars retain their hashes, and that the original plan and failed verdict
remain unchanged. No browser, build or benchmark ran during that review.
Subsequent PR review identified the missing cohort-wide timebase check; the
shared contract now enforces it with a focused mixed-timebase rejection test.
