# UI scenes and design council (#8802)

Tools for running the viewer UI overhaul as a measured hill climb. Each round
captures a fixed scene set from a build, pairs it blind against a reference
capture, collects independent model reviews, and tallies them into numbers.

| file | role |
|---|---|
| `scenes.mjs` | the fixed scene set (17 states, captured in light and dark) |
| `capture.mjs` | serves a built `dist/`, drives Windows Chrome on the real GPU, writes PNGs and `manifest.json` with layout metrics |
| `pair.mjs` | builds a blind packet: per-item random X/Y labels, identical-image controls, and a key kept outside the packet |
| `COUNCIL.md` | the reviewer brief, rubric, output schema and hard constraints |
| `tally.mjs` | turns verdicts and the key into win rates, scores, vetoes and a ranked defect list |

## One round

```sh
# 1. Build the candidate and keep a copy (the checkout's dist/ is overwritten by later builds).
pnpm build:e2e && cp -r apps/viewer/dist ~/ui-overhaul/builds/<label>

# 2. Capture. Needs Windows Chrome (WSL's bundled Chromium has no WebGPU adapter).
node tests/ui-scenes/capture.mjs --dist ~/ui-overhaul/builds/<label> --out ~/ui-overhaul/rounds/<round>/capture --label <label>

# 3. Pair against the frozen baseline and against the previous accepted round.
node tests/ui-scenes/pair.mjs --a <round>/capture --b R0-base --out <round>/packet-vs-base --key <round>/key-vs-base.json
node tests/ui-scenes/pair.mjs --a <round>/capture --b <previous-accepted>/capture --out <round>/packet-vs-prev --key <round>/key-vs-prev.json

# 4. Give each reviewer the packet directory and an output path only.
#    Fresh context per reviewer and pairing, no previous scores, no target.
#    Keep verdicts in separate verdicts-vs-base/ and verdicts-vs-prev/ directories.

# 5. Run and record behaviour checks as <round>/behaviour.json (see below), then tally both.
node tests/ui-scenes/tally.mjs --key <round>/key-vs-base.json --behaviour <round>/behaviour.json --out <round>/tally-vs-base.md <round>/verdicts-vs-base/*.json
node tests/ui-scenes/tally.mjs --key <round>/key-vs-prev.json --behaviour <round>/behaviour.json --out <round>/tally-vs-prev.md <round>/verdicts-vs-prev/*.json
```

A round is accepted when the vs-prev weighted pooled win rate is at least
0.5, both tallies are eligible and have no vetoes, the vs-base tally shows
no regressions, and `node scripts/check-ui-drift.mjs` passes (drift did not go up;
the gate lands with #8803). `pooledWin` is the weighted
mean of complete reviewers' win rates: weight = controlAccuracy (weight 1
when the packet has no controls); reviewers with controlAccuracy < 0.5 get
weight 0 and are excluded. Incomplete reviewers are excluded from all pooled
metrics; duplicate item verdicts are errors. The unweighted mean of complete
reviewers is printed alongside for comparison. The overhaul is done when the
weighted win rate against the frozen baseline holds at 0.85 or more.

Pair mode requires equal candidate/reference item-id sets. `--partial`
allows their intersection for diagnostics, records `partial: true` in the
key, and makes the tally ineligible for round acceptance.

## Behaviour evidence

Run the full viewer unit suite through root Turbo, e2e (the viewer-e2e
project, or both focused specs below), i18n and UI drift on the candidate:

```sh
pnpm test --filter=@ifc-lite/viewer
pnpm test:e2e --project=viewer-e2e
# Alternatively to the full e2e project:
pnpm test:e2e --project=viewer-e2e ribbon-reachability-5874.e2e.spec.ts viewer-smoke.e2e.spec.ts
# viewer-smoke includes the axe-baseline assertion.
node scripts/check-i18n-literals.mjs
node scripts/check-ui-drift.mjs
```

Record actual results in `behaviour.json`, with an entry for every command
run (use `passed: false` for failures):

```json
{
  "checks": [
    { "name": "viewer units", "command": "pnpm test --filter=@ifc-lite/viewer", "passed": true },
    { "name": "viewer e2e", "command": "pnpm test:e2e --project=viewer-e2e", "passed": true },
    { "name": "i18n", "command": "node scripts/check-i18n-literals.mjs", "passed": true },
    { "name": "UI drift", "command": "node scripts/check-ui-drift.mjs", "passed": true }
  ]
}
```

Pass that file with `--behaviour`. Each failed check becomes a veto. Without
it the report says `behaviour checks: NOT RECORDED` and `eligible` is false.
Eligibility requires a complete packet, recorded behaviour with no failures,
no vetoes, and at least one reviewer with positive weight. It does not itself
certify the acceptance win threshold or the vs-base regression review.

Capture tuning: one build captures pixel-identically twice in a row, except
for measured timings such as the properties panel's parse time. Scenes use
only bundled public samples, so captures can be posted on PRs.
