# Appendix B — Glossary

| Term | Meaning in this plan |
|---|---|
| **IDS** | buildingSMART Information Delivery Specification (v1.0): an XML format stating which information IFC models must contain |
| **Specification (spec)** | One rule in an IDS: applicability (which elements) + requirements (what they must have) |
| **Facet** | A condition: entity, attribute, property, classification, material, partOf |
| **Restriction / constraint** | The value condition on a facet field (simple, enumeration, pattern, bounds, length, digits) |
| **StudioDocument** | Canonical in-memory document: IDS content + node IDs + sidecar metadata |
| **Op (operation)** | Typed, invertible change to a StudioDocument. The only way anything edits IDS |
| **Grounding gate** | Pre-apply check that every literal standard name exists for the spec's IFC version(s) |
| **Audit** | Conformance check: is the IDS valid per the standard? |
| **Lint** | Meaning check: is the IDS likely to do what the author intends? |
| **Quick fix** | An op batch attached to a diagnostic |
| **Funnel** | Count of matching elements after each applicability facet |
| **Explain / trace** | Per-element record of every facet evaluation with actual values |
| **Infer** | Proposing specs from selected example elements, contrasted with unselected ones |
| **Coverage lens** | 3D colouring by how many specs apply to each element |
| **Proposal** | AI output: grouped op batches with sources, previews and diagnostics, awaiting review |
| **Unresolved requirement** | A source statement IDS can't express, recorded with category and reason |
| **Sidecar** | `studio.json`: Studio metadata outside IDS XML; canonical entry name in an `.idsz` bundle (P-02 `SIDECAR_FILENAME`) |
| **`.idsz` bundle** | Zip of IDS + sidecar + fixtures + appendix |
| **Test suite** | Per-spec fixtures (synthetic or snapshot) with expected verdicts |
| **Corpus** | buildingSMART's official IDS test cases (IDS + IFC + expected result) |
| **E1–E5** | AI evaluation sets (external benchmark, corpus round-trip, gold set, edits, adversarial) |
| **Appetite** | Shape Up fixed time budget for a pitch |
| **Pitch** | Shape Up proposal: problem, appetite, solution, rabbit holes, no-gos |
| **Charter issue** | GitHub issue authorising a bet/sweep, listing its backlog items (AGENTS.md) |
| **BYOK** | Bring your own (LLM API) key |
