# ADR-012: Spreadsheets — the LLM proposes a mapping, deterministic code converts rows

## Context
- Requirement spreadsheets have hundreds of rows in idiosyncratic layouts.
- Having an LLM emit one spec per row is slow and costly, and it fails silently (IDS-LLM-Service showed the LLM only 3 sample rows, yet expected output for every row).

## Decision
- The LLM sees headers, samples and column stats, and proposes a `SpreadsheetMapping`: columns → fields, value-parsing rules, row grouping.
- The user previews and confirms.
- A deterministic converter applies the mapping to all rows through the gate. Failing rows become diagnostics.
- Mappings are saved and reused without AI.

## Consequences
- **+** Linear cost, reproducible, auditable, works offline after the first mapping.
- **−** Exotic layouts may need manual mapping tweaks. The mapping UI must be good.
