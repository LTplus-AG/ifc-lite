# IDS-LLM-Service teardown: what to keep and what to drop

Source: `louistrue/IDS-LLM-Service`, single squashed commit cd68fe8 (2025-12-17). Next.js 15 + Vercel AI SDK v5 + OpenAI. The code was read in full. **No code is ported.** Only concepts carry over.

## Concepts that survive (in a new form)

| # | Concept in IDS-LLM-Service | Why it's right | New form in IDS Studio |
|---|---|---|---|
| C1 | **JSON-first intermediate representation**, deterministic XML rendering | LLMs should never write XML | The canonical `StudioDocument`. The model never sees or writes XML (ADR-001) |
| C2 | **Patch-op vocabulary** (`ids-patch-applier.ts`, ~27 ops): the LLM proposes typed edits instead of regenerating | Small diffs are reviewable, cheap and composable | The **operation vocabulary**, shared by UI, AI, import, CLI and MCP (ADR-002). ~45 ops, invertible, provenance-tagged |
| C3 | **Validator in the loop**, with no-progress and budget stop conditions | Self-correction works when the feedback is precise | The agent calls `ids.apply_ops`, which returns gate errors with candidates, audit and lint results, and dry-run counts *synchronously*. No external service |
| C4 | **Error classifier** mapping validator errors to fix families | Structured errors produce better repairs | Audit and lint diagnostics with **stable codes** and attached **quick-fix ops**. The agent consumes the same quick fixes |
| C5 | **Ambiguity choices**, each carrying a concrete facet | Clarifying is better than guessing | `ask_user` tool returning 2–4 choices, each a **ready op batch with live counts**. Only triggered when a lookup returns several real candidates (ADR-008) |
| C6 | **Prompt-coverage scoring** (does the output cover the request?) | Catches silent omissions | **Requirement traceability**: every source statement maps to ops or to an *unresolved* entry. Coverage = covered / total statements |
| C7 | **Schema dictionary to check pset/property pairs** | Grounding | Replaced by ifc-lite's full per-version tables (`@ifc-lite/data/ifc-schema`) with `applicableEntities`, enumerations and data types, plus bSDD |
| C8 | **Rule-based fallback** when the LLM fails | Graceful degradation | Deterministic paths that don't need AI at all: the Excel mapper, the bSDD class→spec generator, infer-from-selection |
| C9 | **Excel input** | Requirements live in spreadsheets | LLM maps columns once; deterministic code converts every row (P-09) |

## What dies, and why (each item is a defect class we must not reintroduce)

| Defect | Evidence | Guard in the new design |
|---|---|---|
| Prompts teach hallucinated psets | `Pset_WallCommonThermal`, `Pset_SlabThermal`, `Pset_BeamReinforcement` in the system prompt; none exist | No schema facts in prompts at all. Facts come only from tools. The grounding gate rejects unknown standard names (ADR-003) |
| `minExclusive` silently becomes `simpleValue` (">" written as "=") | `lib/ids-xml.ts` L51–56 | XML comes only from the conformance-tested `writeIdsXml`. Writer oracle tests (`ids-export-oracle.test.ts`) extended to every restriction kind |
| No cardinality, no spec necessity, wrong `partOf` shape | `lib/ids-xml.ts` | Same as above, plus the round-trip invariant: `parse(write(doc)) ≡ doc` property test |
| Wrong `predefinedType` (`EXTERNAL` on IfcWall) | RAG examples | Gate checks the enumeration per entity per version. Lint rule `IDSL-PDT-001` |
| Quantity set used as a property set | `IfcSpace → Qto_SpaceBaseQuantities` | Gate distinguishes Pset/Qto kinds. Lint `IDSL-QTO-001` |
| `IFCTEXT` forced onto numeric values | `baseline-patches.ts` | dataType inferred from the schema property definition, never defaulted |
| Property facets forcibly moved out of applicability | `relocatePropertyFacetsFromApplicabilityToRequirements` | No silent structural rewrites. Lint *suggests*, the user decides |
| One spec per request, ≤3 requirements | zod schemas | No artificial caps. Budget is enforced per run, not per spec |
| Ambiguity forced on almost every input | `AMBIGUITY_SYSTEM_PROMPT` | Clarify only when tools return several real candidates *and* the counts differ materially |
| Validation silently skipped when the env var is unset | `external-validator.ts`; README names the wrong env var | Validation is local, in-process and always on. No network dependency |
| In-memory state on serverless (cache, metrics, embeddings) | `simple-cache.ts`, `rag-service.ts` | Agent is stateless per run. State lives in the document and op log |
| Tests hit live OpenAI on localhost | `tests/*.js` | Recorded-response replay in CI (the existing `ai-eval-replay` pattern) plus a nightly live eval with a budget |
| Type errors ignored at build | `ignoreBuildErrors: true` | ifc-lite strict TS, house rules, module-size ratchet |
| 4–9 LLM calls per spec, length cutoffs | Pipeline design | One agent loop per request with a task budget. Tools do the lookups. Streaming. Prompt caching of the stable prefix |
| Excel: naive `split(",")`; LLM sees 3 sample rows but must emit every row | `process-excel/route.ts` | Real CSV/XLSX parser. The LLM sees headers + samples and emits a *mapping*. Code converts every row |
