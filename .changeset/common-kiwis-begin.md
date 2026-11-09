---
"@ifc-lite/flow": minor
---

Reclaim stale checkpoint locks only after the owner PID is confirmed dead; preserve active writers and diagnose ownerless legacy locks.

Owner names now include hostname and process birth/boot identity so reused PIDs do not permanently pin locks. Old live or unverifiable owners emit a diagnostic. Recovery is local to one host/PID namespace; foreign-host records are refused. Old retired local candidates left during lock setup are cleaned without recursive deletion, while unknown and active entries remain protected.

The checkpoint lock protocol changes from an exclusive file to an owner-tagged directory. All writers sharing a checkpoint directory must be upgraded together; do not mix old and new writers. Old writers do not understand the new directory ownership/recovery protocol. New writers refuse legacy lock files with an actionable error and never remove them automatically. Stop and verify all writers before manually removing a legacy lock. This protocol/behavior change is a minor release for the 0.x package.
