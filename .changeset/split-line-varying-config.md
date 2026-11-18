---
"@ifc-lite/export": patch
---

Convert STEP entity records that span multiple lines. IFC4 to IFC2X3 export now converts split-line varying actions and their load configurations without leaving dangling references. The conversion loss preview accounts for the values carried by those actions (#10715).
