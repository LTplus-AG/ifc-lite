---
"@ifc-lite/mutations": minor
"@ifc-lite/export": patch
---

Retain previous quantity class and unit metadata in edit history, and distinguish explicit unit removal from inherited source units. Preserve quantity classes through viewer Undo and Redo, including native Room cuts, while keeping value-only replay compatible with older histories. Generated quantity export now uses the existing property unit resolver for supported units.
