---
"@ifc-lite/data": patch
---

Build a hydrated string table's reverse index only when a value lookup or intern needs it. Reuse CSR count/offset maps during construction and read target IDs without allocating full relationship-edge objects. Preserve string positions and first-occurrence lookup, ascending CSR keys, per-key edge order and shadowed relationship IDs.
