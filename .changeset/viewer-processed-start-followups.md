---
"@ifc-lite/viewer": patch
---

Defer browser engine prewarm while a processed start model is queued or loading, then resume at idle even when local file worker prewarm is disabled. Accept explicitly configured HTTPS and HTTP loopback processing servers, including IPv6 loopback, and refuse remote HTTP servers on HTTPS pages. Report a missing processing server in the console when the host config selects a start model.
