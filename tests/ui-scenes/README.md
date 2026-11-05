# UI scenes and design council (#8802)

Tools for running the viewer UI overhaul as a measured hill climb. Each round
captures a fixed scene set from a build, pairs it blind against a reference
capture, collects independent model reviews, and tallies them into numbers.

| file | role |
|---|---|
| `scenes.mjs` | the fixed scene set (13 states, captured in light and dark) |
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

# 4. Give each reviewer the packet directory and an output path only.
#    Fresh context per reviewer, no previous scores, no target.

# 5. Tally.
node tests/ui-scenes/tally.mjs --key <round>/key-vs-base.json --out <round>/tally-vs-base.md <round>/verdicts/*.json
```

A round is accepted when the candidate wins against the previous accepted
round (pooled win rate of at least 0.5, with reviewers who fail their controls
weighted down), has no vetoes, and `pnpm ui-drift` did not go up. The
overhaul is done when the win rate against the frozen baseline holds at 0.85
or more.

Capture tuning: one build captures pixel-identically twice in a row, except
for measured timings such as the properties panel's parse time. Scenes use
only bundled public samples, so captures can be posted on PRs.
