---
"@ifc-lite/parser": patch
---

Resolve single-element type quantities, materials, classifications and documents through incident relationships without model-wide selection or publication work. Cache narrow relationship edits and decoded rows per revision so pending property edits and bulk reads remain fast. Exclude unrelated attribute edits before decoding, index edited relationship endpoints once per revision, and retain native refusal ordering.

Keep domain refusals cached per revision and reuse source records for type-relationship edits. Check unchanged definition coverage lazily when its upper bound crosses the reference budget.
