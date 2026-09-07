---
"@ifc-lite/viewer": patch
---

Split `CommandPalette.tsx`'s fuzzy search/ranking and recent-usage helpers into a new `commandPaletteSearch.ts` module. This is a pure internal refactor to bring the file back under the repo's module-size budget (it had grown to 852 lines against an 849-line budget after two same-day PRs each added a command entry) — no command was renamed, removed, or behaviorally changed.
