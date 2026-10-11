# P-08 — Evaluation and public benchmark

**Problem.** Without measurement, prompt and model changes are guesses, and our "best AI" claim is marketing without proof.

**Appetite.** 2 weeks in C1 (datasets E2 and E4 seed), then ongoing as a standing track responsibility.

**Solution.**
- Five eval sets (E1–E5; see `03-architecture/06-ai-agent.md` §9).
- An executable oracle (pass/fail verdict agreement on the paired IFC).
- CI replay of recorded responses (the existing ai-eval pattern).
- Nightly live runs through the Batch API with a budget.
- A per-release full run and a public benchmark page.

**Rabbit holes.**
- Licence of the external benchmark (D4).
- Corpus files are CC BY-ND and must not be modified. We reference them and write our own descriptions.
- Human review time for NL descriptions. Budget 1 person-week.

**No-gos.** No LLM-as-judge for correctness where an executable oracle exists. A judge is only for prose quality (Explain mode).

**Scopes.** IDS-087 … IDS-092.

**Done means.**
- Scores are produced automatically.
- Ship gates are enforced in CI for prompt/model changes.
- A public page exists.

**Evidence.** `scores.json` history.
