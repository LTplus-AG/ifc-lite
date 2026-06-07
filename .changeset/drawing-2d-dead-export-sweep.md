---
"@ifc-lite/drawing-2d": patch
---

Remove 12 never-consumed exports flagged by `knip` (opening query helpers, the
`createX` style/layer factory functions, and `buildOpeningRelationshipsFromData`).
They had zero consumers anywhere in the repo, so this is internal cleanup with no
behavioural change. The architectural-symbol generators (`generateNorthArrow`,
`generateSectionMark`, `generateLevelMark`, the door/window `…At` variants,
`generateOpeningSymbols`, `generateSimpleWindowLines`) are kept as intended
public API and marked `@public`; the used classes, constants, and the
`OpeningFilterOptions` type are untouched.
