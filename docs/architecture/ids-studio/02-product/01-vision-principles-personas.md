# Vision, principles, personas, jobs

## Vision
**Make information requirements as precise, testable and pleasant to write as good code.** An IDS written in IDS Studio is valid by construction. It is explained in plain language, proven against real models and generated fixtures, traceable to the contract text it came from, and versioned like software.

## North-star metric
**Grounded specs shipped per week.** Count IDS specifications exported from Studio (UI, CLI or MCP) that
(a) pass the audit,
(b) have zero lint errors, and
(c) were previewed with a non-zero applicability count on at least one real model, *or* carry a passing generated test suite.

It rewards correctness and grounding, not just volume.

## Product principles (tie-breakers for every design decision)

1. **Valid by construction.** Invalid IDS cannot be exported. Every authored change goes through the grounding gate; user export goes through the conformance-tested writer and export audit. Internal serialization for import/round-trip diagnostics does not authorize export of an invalid document (FR-A01/FR-A06). Warnings are allowed; schema errors are not.
2. **Show, don't tell.** Every specification shows what it matches *now*: counts, funnel, 3D. Every facet shows its plain-language meaning beside its technical form.
3. **One document, one vocabulary.** UI, AI, import, CLI and MCP all change the document through the same typed operations. There is no second path.
4. **AI proposes, humans dispose.** The assistant produces reviewable op batches with sources and previews. It never saves on its own, and never invents names (the gate makes that structural).
5. **Model-optional, model-superpowered.** Everything works without a model. With a model, everything gets better.
6. **Local-first and private.** Models never leave the browser. Only the minimum context goes to an LLM, and only when the user invokes AI.
7. **Standard, not dialect.** Output is plain IDS 1.0. Studio metadata (IDs, provenance, comments, test suites) lives in a sidecar, never in a proprietary XML extension. Exception: the XML-comment fingerprint, which is optional.
8. **Explain the standard's sharp edges.** Where IDS is ambiguous (cardinality, PROHIBITED, subtypes, units, regex anchors), Studio says so at the point of use and links to the issue.
9. **Headless parity.** Anything the UI can do, the CLI/MCP/SDK can do (the reverse is not required).
10. **Repo house rules apply.** Exact EXPRESS names, ≤400-line modules, tests and evidence per PR, supersede-means-delete.

## Personas

| ID | Persona | Context | Primary goals | Pain today |
|---|---|---|---|---|
| **PA** | **Information manager / BIM manager (client side)** | Writes the EIR/AIA for a public or private client; owns the IDS as a contract appendix | Turn requirement docs into a correct IDS fast; sign off with confidence; version per project phase | Must know IFC by heart; can't tell whether a spec will match anything; Excel ↔ IDS drift |
| **PB** | **BIM coordinator (contractor/design side)** | Receives an IDS and must deliver compliant models; runs checks weekly | Understand what's required in plain language; find failures and fix them; push issues to authors | IDS is unreadable; tools disagree; failures without explanations |
| **PC** | **Modeller / discipline author** | Works in a desktop authoring tool; gets BCF issues | Know exactly which property, on which elements, with what value | Requirements arrive as XML or a 40-page PDF |
| **PD** | **Standards author / public authority** | Publishes national or organisational IDS templates and bSDD dictionaries | Consistent, reusable, translated IDS sets aligned to bSDD; release management | No dictionary→IDS path that handles inheritance, datatypes and values; no diffing |
| **PE** | **Developer / automation engineer / AI agent** | Builds CDE integrations, CI pipelines, agents | Script authoring, auditing, diffing and checking; MCP tools for agents | Only ifctester (Python) or early MCP servers |
| **PF** | **Consultant / trainer** | Teaches IDS, audits clients' IDS | Explain why an IDS is wrong; demo live | No tool explains meaning |

## Jobs-to-be-done

Format: *When [situation], I want to [motivation], so I can [outcome].* Each job maps to requirements in `02-requirements.md`.

| Job | Persona | Statement |
|---|---|---|
| **J1** | PA | When I receive a requirements PDF/Excel from my client, I want a draft IDS that covers every statement and tells me what it couldn't express, so I can deliver a contract-ready IDS in hours, not weeks. |
| **J2** | PA | When I write a requirement, I want to see immediately which elements it applies to in a reference model, so I know it isn't vacuous or over-broad. |
| **J3** | PA, PD | When I pick classes, psets, properties and values, I want only valid choices for my IFC version (and bSDD), so I never ship a typo or a non-existent pset. |
| **J4** | PA, PF | When an IDS behaves unexpectedly, I want to know *why* an element passed, failed or was skipped, so I can fix the spec rather than guess. |
| **J5** | PA | When a reference model already looks the way I want, I want to derive requirements from it by selecting examples, so I don't have to transcribe what I can see. |
| **J6** | PA | When I'm about to sign off, I want proof that each spec passes on compliant data and fails on non-compliant data, so I can defend the IDS contractually. |
| **J7** | PB, PC | When I receive an IDS, I want it in plain language in my language, with the affected elements highlighted, so I know exactly what to model. |
| **J8** | PB | When my model fails, I want to fix values in place (or generate BCF for authors), so failures turn into fixes quickly. |
| **J9** | PA, PD | When an IDS evolves across project phases, I want semantic diffs, revisions and sign-off, so everyone knows what changed and what's binding. |
| **J10** | PD | When I maintain a bSDD dictionary, I want to generate a complete IDS from it (inheritance, datatypes, allowed values), so the dictionary and IDS never drift. |
| **J11** | PA | When my team co-authors an IDS, I want comments, live editing and roles, so review happens in the tool, not in email. |
| **J12** | PE | When I automate delivery checks, I want CLI/MCP/SDK access to audit, lint, diff, convert, draft and test, so IDS lives in CI like code. |
| **J13** | PA, PB | When I want to know what my IDS *doesn't* govern, I want a coverage view of the model, so blind spots are visible before handover. |
| **J14** | PA | When I'm unsure how to express something in IDS, I want to ask in natural language and get a grounded proposal, so I don't need to be an IFC expert. |
| **J15** | PF | When teaching IDS, I want a learn mode with explanations of sharp edges, so newcomers avoid the classic traps. |
| **J16** | PA | When I already have an IDS from another tool, I want it audited, linted, explained and upgraded, so I can trust or fix legacy files. |
