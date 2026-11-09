---
"@ifc-lite/flow": patch
---

Reclaim stale checkpoint locks only after the owner PID is confirmed dead; preserve active writers and diagnose ownerless legacy locks.

Owner names now include hostname and process birth/boot identity so reused PIDs do not permanently pin locks. Old live or unverifiable owners emit a diagnostic. Recovery is local to one host/PID namespace; foreign-host records are refused. Old retired local candidates left during lock setup are cleaned without recursive deletion, while unknown and active entries remain protected.
