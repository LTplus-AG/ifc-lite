# ADR-007: No node canvas — outline + inspector + grid + 3D

## Status
Accepted (owner decision, 2026-10-08).

## Context
- ids-flow proved a node-graph IDS editor is possible, but the graph adds layout and connection overhead without adding meaning.
- IDS is a list of specs, each with two facet lists. The real "visual" value is seeing affected elements in 3D.

## Decision
- Studio's surfaces are:
  - **outline** (tree)
  - **inspector** (form + plain language)
  - **grid** (spreadsheet power mode)
  - **XML preview**
  - **live 3D** (funnel/isolate/coverage)
- No canvas. ids-flow is not integrated. Ideas are harvested (`01-context/04-ids-flow-harvest.md`).

## Consequences
- **+** Smaller scope; faster to excellent; familiar to Excel-native users.
- **−** Users who liked the graph metaphor lose it. The existing editor remains separate; its migration and launch strategy are private (D1, ADR-014).
