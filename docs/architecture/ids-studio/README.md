# IDS Studio — Master Plan

> Working name: **IDS Studio** (inside ifc-lite). Status: plan v1, 2026-10-08.
> Owner: Louis True. Scope: complete clean-room rewrite of IDS authoring in ifc-lite.

**One sentence:** the only IDS tool that knows your model, the IFC schema and bSDD at the same time, so every requirement you write is grounded, previewed in 3D, explained, tested, and AI-draftable without hallucination.

> **Public subset.** ifc-lite is public (AGENTS.md → "This repository is public"). The tool landscape, launch FAQ and go-to-market material are kept in the owner's private plan package (ADR-014). Everything here names no vendors or clients.
>
> **Taking over?** Start with [`HANDOVER.md`](HANDOVER.md), then [`STATUS.md`](STATUS.md).

---

## Planning framework

This plan combines four well-established frameworks, each used for what it is best at:

| Layer | Framework | Why this one | Where |
|---|---|---|---|
| **Why / what** | **Working Backwards** (Amazon PR/FAQ) | Forces a customer-visible definition of "done" before any architecture. | private plan package |
| **Product** | **Jobs-to-be-Done + PRD** with numbered requirements (FR/NFR) | Every feature traces to a job a real persona has; every requirement traces to a backlog item and a test. | `02-product/` |
| **How** | **arc42-lite + C4 diagrams + ADRs** (Michael Nygard format) | Architecture decisions are recorded once with their reasoning and alternatives, so they are not re-litigated per PR. | `03-architecture/`, `04-decisions/` |
| **When** | **Shape Up** (Basecamp): fixed-time *appetites*, shaped *pitches* with rabbit holes and no-gos, 6-week cycles + 2-week cooldowns | Matches ifc-lite's "one defect class per PR, ≤1,500 lines, issue labelled `ready`" workflow: a pitch becomes a GitHub issue charter; scopes become stacked PRs. | `05-delivery/` |
| **Measure** | **OKRs** with a North-Star metric + **RAID** log | Ambition stated as measurable targets; risks owned. | `05-delivery/04-metrics-okrs.md`, `05-delivery/05-raid.md` |

Traceability chain: **PR/FAQ claim → Job (J-x) → Requirement (FR-x) → Pitch (P-x) → Backlog item (IDS-xxx) → Test / Eval → OKR**.

---

## Reading order

| # | File | What it answers |
|---|---|---|
| 1 | [`01-context/02-ids-llm-service-teardown.md`](01-context/02-ids-llm-service-teardown.md) | Which concepts survive from IDS-LLM-Service, which die |
| 1 | [`01-context/03-ifc-lite-asset-inventory.md`](01-context/03-ifc-lite-asset-inventory.md) | What we already own (a lot) and the gaps |
| 1 | [`01-context/04-ids-flow-harvest.md`](01-context/04-ids-flow-harvest.md) | Canvas dropped; what we still take from ids-flow |
| 2 | [`02-product/01-vision-principles-personas.md`](02-product/01-vision-principles-personas.md) | North star, principles, personas, jobs |
| 2 | [`02-product/02-requirements.md`](02-product/02-requirements.md) | PRD: every functional and non-functional requirement |
| 2 | [`02-product/03-ux-spec.md`](02-product/03-ux-spec.md) | Surfaces, layouts, key flows, keyboard model |
| 3 | [`03-architecture/01-overview.md`](03-architecture/01-overview.md) | C4 context/container/component, package layout |
| 3 | [`03-architecture/02-document-model-and-ops.md`](03-architecture/02-document-model-and-ops.md) | Canonical model + the typed operation vocabulary |
| 3 | [`03-architecture/03-diagnostics-audit-lint.md`](03-architecture/03-diagnostics-audit-lint.md) | Audit (conformance) + Lint (meaning) engines, full rule catalogue |
| 3 | [`03-architecture/04-model-loop.md`](03-architecture/04-model-loop.md) | Live applicability funnel, explain, infer-from-selection, coverage |
| 3 | [`03-architecture/05-bsdd.md`](03-architecture/05-bsdd.md) | bSDD pickers, class→spec, dictionary→IDS |
| 3 | [`03-architecture/06-ai-agent.md`](03-architecture/06-ai-agent.md) | Grounded tool-using agent, modes, ingestion, eval |
| 3 | [`03-architecture/07-interop-versioning-collab.md`](03-architecture/07-interop-versioning-collab.md) | Excel/PDF/DOCX round-trip, diff/merge, revisions, co-authoring, IDS test suites |
| 3 | [`03-architecture/08-cli-mcp-sdk.md`](03-architecture/08-cli-mcp-sdk.md) | Headless surfaces for agents and pipelines |
| 4 | [`04-decisions/`](04-decisions/) | ADR-001 … ADR-014 |
| 5 | [`05-delivery/01-roadmap.md`](05-delivery/01-roadmap.md) | Cycles, appetites, parallel tracks, milestones |
| 5 | [`05-delivery/pitches/`](05-delivery/pitches/) | Shape Up pitches P-01 … P-12 |
| 5 | [`05-delivery/03-backlog.md`](05-delivery/03-backlog.md) | 123 PR-sized items (no issues needed: owner exemption, see HANDOVER) |
| 5 | [`05-delivery/02-test-and-eval-strategy.md`](05-delivery/02-test-and-eval-strategy.md) | Oracles, corpora, AI evals, real-model evidence |
| 5 | [`05-delivery/04-metrics-okrs.md`](05-delivery/04-metrics-okrs.md) | North star, OKRs, targets vs. published baselines |
| 5 | [`05-delivery/05-raid.md`](05-delivery/05-raid.md) | Risks, assumptions, issues, dependencies |
| A | [`appendix/`](appendix/) | Glossary, IDS 1.0 cheat sheet + gotchas, sources |

---

## The plan on one page

**Starting position.** ifc-lite already has the hardest parts most IDS tools lack:
- An IDS 1.0 checker that agrees with all 307 pass/fail cases in buildingSMART's official test files.
- A WebGPU 3D viewer with isolate, ghost and colour.
- Schema tables for IFC2X3, IFC4 and IFC4X3, with which elements each property set applies to.
- A bSDD client.
- BCF, CLI, MCP, an assistant framework, a Yjs collaboration package and a programmatic IFC creator.

What's missing is the authoring product.

**Shape of the product** (no node canvas — decided):
1. **Authoring core** (headless package): one canonical IDS document; every change is a typed, invertible *operation*; every operation passes a **grounding gate** against schema + bSDD before it applies.
2. **Diagnostics**: *Audit* (is it valid IDS? target 27/27 invalid corpus cases detected) + *Lint* (does it mean what you think? 51 semantic rules with one-click fixes, e.g. "abstract entity matches nothing", "`^`/`$` are literal in XSD patterns", "2400 looks like mm, IDS is SI").
3. **Studio UI** in the viewer: outline + inspector + spreadsheet grid + live 3D. Schema/bSDD/model-aware pickers. Plain-language rendering of every facet.
4. **Model loop** (the moat): live **applicability funnel** per spec ("812 walls → 640 with Pset_WallCommon → 212 external"), per-element **explain**, **infer-from-selection** ("require what these have", with contrast learning against unselected elements), **coverage lens** (which elements no requirement governs), value suggestions from the real model.
5. **bSDD**: class/property pickers, class → specification, whole dictionary → IDS, URI health checks.
6. **AI agent**: Claude tool-use loop over the *same* operation vocabulary + schema/bSDD/model tools. Hallucinated names are structurally rejected by the gate. Modes: draft, edit, explain, review, repair, infer, translate. Ingests NL, PDF, DOCX, Excel (LLM maps columns, code converts rows). Full source traceability + "unresolved requirements" list. Benchmarked publicly (target ≥ 85% audit+content pass on Ishigaki-IDS-Bench vs. 33% best zero-shot frontier / 65% fine-tuned 8B).
7. **Trust layer**: **IDS test suites** (auto-generated pass/fail IFC fixtures per spec, CI-runnable), semantic diff/merge, revisions with sign-off, comments, live co-authoring.
8. **Everywhere**: CLI (`ids audit|lint|fmt|diff|convert|explain|draft|infer|coverage|test`), MCP tools, SDK namespace, embeddable studio.

**Timeline:** Shape Up cycles of 6 weeks build + 2 weeks cooldown, run as 3–4 parallel tracks. **Public beta at the end of cycle 3 (~month 6)**, **GA at the end of cycle 6 (~month 12)**, standards-leadership work from cycle 7.

## Decisions (resolved by the owner, 2026-10-08)

| # | Decision | Resolution |
|---|---|---|
| D1 | idsedit.com / ids-flow future | Keep running with an "Open in ifc-lite IDS Studio" link now; redirect at Studio launch |
| D2 | AI provider policy | Claude-first (`claude-opus-5-5`), provider-neutral seam kept; other providers only if they pass the eval gate |
| D3 | Free-tier AI budget | Same quotas and proxy path as the existing viewer chat/assistant (`lib/llm/usage-quota.ts`) |
| D4 | External IDS benchmark licence | Unknown. Treat as unusable for publishing until clarified; build our own gold set (IDS-088) regardless |
| D5 | Template library sources | Public national IDS sets allowed **after a per-source licence check** (record licence per template) |
| D6 | bSDD write-back | Later (post-GA); export bSDD import JSON only when we get there |
| D7 | Brand | "IDS Studio" as a named workspace inside ifc-lite |
| D8 | Issue-queue rule | Campaign is exempt from the `ready`-issue rule (owner decision). PRs reference backlog IDs instead of issues |
