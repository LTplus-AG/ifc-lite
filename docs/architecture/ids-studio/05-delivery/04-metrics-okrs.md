# Metrics and OKRs

## North star
**Grounded specs shipped per week.** IDS specifications exported from Studio (UI/CLI/MCP) that pass the audit, have zero lint errors, and were previewed with non-zero applicability on a real model *or* carry a passing test suite.

Measured with privacy-preserving counters only: op kinds, counts and booleans. Never names or values (PostHog scrub rule).

## Input metrics (leading indicators)
| Metric | Definition | Target at GA |
|---|---|---|
| Activation | % of new Studio users who export ≥1 audit-clean IDS in their first session | ≥ 40% |
| Model-loop adoption | % of export sessions with ≥1 funnel interaction | ≥ 60% |
| Infer usage | Infer proposals accepted per week | growth MoM |
| AI acceptance | % of AI-proposed specs accepted unchanged / with edits / rejected | ≥ 60% / ≤ 30% / ≤ 10% |
| Lint fix rate | % of lint warnings resolved by quick fix | ≥ 50% |
| Test suites | % of released revisions with passing test suites | ≥ 30% |
| Headless | Weekly CLI/MCP IDS command runs (opt-in telemetry or download stats) | growth MoM |
| Time to first valid IDS | Median minutes from Studio open to the first audit-clean export | ≤ 5 min (new user), ≤ 2 min (template) |

## OKRs

### O1 — Be provably the most correct IDS tool
- **KR1.1** Corpus: 307/307 pass/fail agreement maintained; **27/27** invalid detected (from 6/27).
- **KR1.2** 100% of exported files pass the official audit CLI in CI.
- **KR1.3** Lint precision ≥ 95% on the labelled corpus; ≥ 51 rules at GA.
- **KR1.4** Public conformance dashboard live (C7+).

### O2 — Make the model the authoring superpower
- **KR2.1** Funnel p95 ≤ 300 ms on 100k elements; progressive on 1M.
- **KR2.2** Infer accuracy ≥ 90% on the labelled selection set.
- **KR2.3** ≥ 60% of exporting sessions use the funnel or explain.

### O3 — Own "AI for IDS"
- **KR3.1** E2 executable agreement ≥ 90% at GA (β ≥ 80%).
- **KR3.2** External benchmark (if licensed): audit+content pass ≥ 85% (published baselines: 33% best zero-shot frontier, 65% fine-tuned 8B).
- **KR3.3** Median Draft cost ≤ $0.50 for 20 specs; p50 latency ≤ 60 s.
- **KR3.4** 0 shipped hallucinated standard names (the gate makes this structural; tracked by audit of exported docs).

### O4 — Become the default free IDS editor
- **KR4.1** 1,000 weekly active Studio users within 6 months of GA (to be calibrated against current viewer traffic).
- **KR4.2** ≥ 3 integrations embedding Studio or using the MCP tools (generic segments: CDE, authoring add-in, consultancy tooling).
- **KR4.3** Top result or official mention for "IDS editor" community resources (forums, OSArch wiki, buildingSMART software registry entry).

## Instrumentation plan
- Studio events (kinds only):
  - `studio_open`, `op_applied{kind,count}`, `gate_rejected{code}`, `lint_fixed{code}`
  - `funnel_interaction`, `infer_accepted{n}`, `export{format}`, `test_run{pass}`
  - `ai_run{mode, accepted_ratio, cost_bucket}`
- All events pass the existing `scrubEvent`. Add Studio keys to the scrub tests.
- Eval scores come from `scores.json` per release, not telemetry.
