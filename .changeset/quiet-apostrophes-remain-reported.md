---
"@ifc-lite/parser": minor
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": patch
"@ifc-lite/cache": minor
---

Report malformed apostrophe record boundaries and recover conservatively without dropping valid intervening records or promoting later quoted record-like text to entities. Preserve legal PAGE and doubled-quote operands; ambiguous recovery remains an explicitly incomplete-source refusal.

Retain reported scanner omissions through parsed stores and worker transport. Cache admission refuses known partial indexes; absence of scan provenance remains unobserved, and a zero omission flag is not a complete STEP syntax verdict.

Carry actual serial prepass omissions and all classified-shard malformed offsets through authoritative stitch attribution. Preserve existing Rust classified-scan return tuples and the serial WASM boolean event.
