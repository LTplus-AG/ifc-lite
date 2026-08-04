---
"@ifc-lite/mcp": patch
---

`ViewerManager` now warns once per session when an SSE frame from the viewer fails to parse as JSON, or when GlobalId enrichment fails for a picked selection (#2100 follow-up). Both paths still degrade the same way as before — a bad frame is dropped, a selection without a GlobalId is still reported — but they no longer swallow the failure with no diagnostic at all. Both triggers are viewer-client controlled and can repeat at high frequency (once per frame, once per pick), so the warning is a once-per-session latch rather than a per-occurrence log, reset the next time `open()` starts a session.
