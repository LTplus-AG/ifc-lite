---
"@ifc-lite/viewer": patch
---

Fix the AI chat's code-block extractor silently dropping every fenced code block in a CRLF-authored assistant message.

`extractCodeBlocks`'s fence regex required a literal `\n` right after the opening fence's language tag. A message with `\r\n` line endings (pasted or Windows-authored content) has `\r` there instead, so the regex never matched the block at all — it rendered as plain text with no "Run" affordance, and a script referencing `bim.` silently lost its executability rather than surfacing an error. The regex now tolerates an optional `\r` before the newline.
