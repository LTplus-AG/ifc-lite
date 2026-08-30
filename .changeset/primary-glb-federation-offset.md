---
"@ifc-lite/viewer": patch
---

Fix: loading a `.glb` as the first (primary) model, then adding another model, no longer overlaps their entity ids.

The primary GLB path never registered itself in the federation registry (a GLB carries no IFC entities, so the registration guard skipped it), so `idOffset` for a subsequently-added model started back at the primary GLB's own range instead of past it. A test now pins that a federated add after a primary GLB gets a disjoint `idOffset`.
