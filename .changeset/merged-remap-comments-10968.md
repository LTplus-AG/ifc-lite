---
"@ifc-lite/export": patch
---

A merged STEP export remaps every reference after a STEP comment. An apostrophe inside a `/* ... */` comment was read as the start of a string, so the `#id` references after it kept their source ids and pointed at the wrong entities. Comments are now copied as they are.
