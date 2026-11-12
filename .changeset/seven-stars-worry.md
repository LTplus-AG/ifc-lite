---
"@ifc-lite/export": patch
---

Convert structural boundary stiffness and constant-action slots correctly between IFC2X3 and IFC4. Retain physical-to-analytical links using IFC4 assignments, reuse explicit section directions where the frames agree, and report structural attributes or entity kinds the target schema cannot preserve.
