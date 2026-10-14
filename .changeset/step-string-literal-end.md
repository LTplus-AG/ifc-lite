---
"@ifc-lite/encoding": minor
---

Add `stepStringLiteralEnd` and `isStepPageQuoteOperand`: the one rule for where a STEP string literal ends (a doubled `''` is an escaped quote, and the operand of a `\S\` PAGE directive is text even when it is an apostrophe), for every walker that splits, rewrites or scans STEP text.
