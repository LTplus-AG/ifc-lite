---
"@ifc-lite/cli": patch
---

Avoid the Node 24 V8 WASM code-reclamation crash during retained exports by disabling code GC in the short-lived export process. Contain retained OBJ export crashes in a child process and publish staged output only after successful termination. Report process failures with their signal or exit code while preserving existing destination files.
