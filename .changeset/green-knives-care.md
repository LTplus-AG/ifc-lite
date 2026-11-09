---
"@ifc-lite/cli": patch
---

When saving a Flow review checkpoint encounters a legacy lock file, explain that an older writer left it, require upgrading all writers sharing the directory together, and instruct users to stop and verify all writers before manually removing only that lock file. Preserve unrelated write errors and leave the legacy lock untouched.
