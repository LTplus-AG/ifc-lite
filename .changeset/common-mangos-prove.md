---
"@ifc-lite/renderer": patch
---

Treat browser-initiated destruction of the current GPU device as device loss, so recovery and benchmark health reporting run. Suppress intentional teardown by device ownership rather than the browser-reported reason.
