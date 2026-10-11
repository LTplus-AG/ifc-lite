---
"@ifc-lite/rules": patch
---

Exporting a rule's `matches` regex to an IDS pattern now writes JavaScript `.` as `[^\n\r\p{Zl}\p{Zp}]`, since XSD `.` also matches U+2028 and U+2029, which JavaScript `.` does not.
