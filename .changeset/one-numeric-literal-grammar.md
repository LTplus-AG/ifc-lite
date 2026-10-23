---
'@ifc-lite/parser': patch
'@ifc-lite/data': patch
---

The cost-lexeme reader now uses `isCompleteStepNumericLiteral` (the one STEP numeric grammar) instead of its own regex copy, and that grammar is pinned by the shared vector file `rust/core/tests/fixtures/step_numeric_vectors.json`, which the Rust tokenizer and byte readers read too (F4-1, #7778).
