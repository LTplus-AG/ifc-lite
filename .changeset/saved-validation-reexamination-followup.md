---
"@ifc-lite/viewer": patch
---

Review re-examination of saved validation failures (#7371) follow-ups: a saved failure the current run still reports now reads "Still in the current run" (or "Still in the current run, with different failures" when other requirements or values fail) instead of "Also in the earlier run". Why a saved failure was or was not checked again is shown as a translatable plain sentence rather than an internal reason code, and the no-current-run case reads as one clean sentence. Re-examining many saved rows against a large run no longer rebuilds the run's GlobalId lookup per row.
