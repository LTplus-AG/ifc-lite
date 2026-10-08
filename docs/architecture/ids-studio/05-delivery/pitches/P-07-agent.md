# P-07 — AI agent

**Problem.**
- Writing IDS from requirement text needs IFC expertise most authors don't have.
- Existing generators invent names: a 33% content pass zero-shot in the public benchmark, and 65% fine-tuned.
- ifc-lite's assistant has no tool calling.

**Appetite.** 6 weeks (C3: Draft/Edit/Explain/Repair) + 3 weeks (C5: Review/Infer/Translate), Track C.

**Solution.**
- `@ifc-lite/ids-agent`: a tool-use loop over the op vocabulary, with schema/bSDD/model/IDS tools.
- A sandbox fork with gate, diagnostics and preview on each `apply_ops`.
- Structured clarification only on real ambiguity.
- A Proposal review UI with sources and previews.
- Claude-first configuration (`claude-opus-5-5`, adaptive thinking, effort per mode, strict tools, caching, task budgets, refusal fallbacks).
- The JSON-proposal path is superseded.
- See `03-architecture/06-ai-agent.md`.

**Rabbit holes.**
- Prompt bloat. Keep facts in tools, not in the prompt; the orientation card stays under ~2k tokens.
- Tool-call explosion on large drafts. Use task budgets plus batch `apply_ops` (many ops per call).
- Browser-direct BYOK streaming with tools. Validate eager-streamed tool inputs before execution.
- Prompt injection inside PDFs or IFC strings. Treat them as data; E5 tests this.

**No-gos.**
- No auto-save or auto-export.
- No fine-tuning in this pitch.
- No prompts containing lists of IFC names.

**Scopes.** IDS-075 … IDS-086.

**Done means.**
- E2 executable agreement ≥ 80% (β), ≥ 90% (GA).
- Audit pass 100%.
- Cost within NFR-11.
- Every proposal shows sources and live counts.

**Evidence.** Eval report attached to each prompt/model PR (P-08); recordings.
