---
"@ifc-lite/parser": patch
---

Keep structural support and load stations and face markers outside face openings. Normalize a multi-group action against the first assigned IfcStructuralLoadCase when present, otherwise its first assigned load group; ungrouped actions scale independently. The viewer excludes hidden and isolated-out actions before normalization, follows entity visibility, and exposes glyph buttons and scene Pins to assistive technology.
