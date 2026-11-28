---
"@ifc-lite/sandbox": major
"@ifc-lite/sdk": major
---

Sandbox arguments, console values, and script results now have a maximum nesting depth of 64. This prevents guest values from exhausting the host stack during decoding. A script that previously transferred a deeper value now raises a script error at that boundary.

When upgrading, flatten deep values or pass smaller subtrees in separate calls, log entries, or results. The root is depth zero. Use `limits.maxDumpDepth` to set a lower limit when creating a sandbox or calling `bim.sandbox.eval`.
