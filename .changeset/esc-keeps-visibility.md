---
"@ifc-lite/viewer": patch
---

Esc no longer throws away your isolation, hidden elements or basket (#5595). Each press now does one step: it cancels the gesture in progress, otherwise leaves the active tool (back to Select), otherwise clears the selection. Only Show All (A) and Home reset visibility; Esc Esc still closes all panels but keeps what is shown.
