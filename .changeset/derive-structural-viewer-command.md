---
"@ifc-lite/viewer": minor
---

The command palette can derive a structural analysis model from the loaded physical model (#9668). "Derive structural analysis model" opens the structural review step: it derives the plan, shows what it would write (curve and surface members, nodes, supports and the records to create), lists the skipped elements with their reasons, the guessed supports and the member ends left unconnected, and applies only after acknowledgement, as one undo step. Every derived member and node is linked to its physical element, so the Structural Analysis card shows the counterparts. The derivation loads only when the command is used.
