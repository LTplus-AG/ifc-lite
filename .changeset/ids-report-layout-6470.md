---
"@ifc-lite/ids": patch
"@ifc-lite/rules": patch
"@ifc-lite/viewer": minor
---

IDS report block: fixed pass percentage and two layouts ([#6470](https://github.com/LTplus-AG/ifc-lite/issues/6470)). A pass rate was floored, so 70 of 7,972 entities passing read `0%` (and 9,999 of 10,000 would read `100%`), which said "nothing passes" when something did. `@ifc-lite/ids` now exports `boundedPassRate`, which keeps a partial result between 1% and 99%; the validator, rule engine, IDS panel, HTML export and document block all use it. The documentation page's IDS report block gets a Layout setting: Compact (one row per check and requirement, a coloured percent bar and only the attribute or property name) and Long (the full requirement text, wrapped rather than cut off, in both the preview and the PDF). Existing saved documents keep their current layout until you pick one; newly added blocks start Compact.
