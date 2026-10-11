# P-09 — Ingestion and readable documents

**Problem.**
- Requirements arrive as PDF, DOCX and Excel, and IDS leaves as XML nobody can read.
- Converters use fixed templates and are one-way.
- No tool traces each IDS spec back to the contract sentence it came from.

**Appetite.** 6 weeks, Track C (C4).

**Solution.**
- PDF (native document blocks with citations) and DOCX (structured spans) ingestion into Draft.
- Spreadsheets via an LLM-proposed mapping and a deterministic converter (ADR-012) with saved mappings.
- A traceability UI with an unresolved list and statement coverage.
- A readable appendix (HTML/PDF/DOCX), Excel round trip, a YAML/JSON human format, and translations.

**Rabbit holes.**
- PDF tables. Prefer native PDF handling, with fallback to page images only if needed.
- Merged cells and multi-row headers in Excel. Use header detection plus manual override.
- DOCX library size in the browser. Lazy-load.

**No-gos.** No OCR pipeline of our own. No document editing.

**Scopes.** IDS-093 … IDS-103.

**Done means.**
- A 400-row requirement sheet converts deterministically after one mapping.
- A 60-page PDF yields a proposal with ≥95% statement coverage (covered or unresolved) on the E3 subset.
- The appendix is readable by non-experts (5-person hallway test).

**Evidence.** Recordings; sample outputs (internal docs only, no client data).
