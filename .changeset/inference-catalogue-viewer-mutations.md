---
'@ifc-lite/extensions': patch
---

Fix the "Promote to tool" capability inference under-granting three real `bim.viewer` mutations.

`INFERENCE_CATALOGUE` in `src/inference/catalogue.ts` documents itself as kept in sync with `@ifc-lite/sandbox`'s `NAMESPACE_SCHEMAS` (`bridge-viewer.ts`), and `inferCapabilities`'s own design rules say to never under-grant: if the inferred capability is wrong, an extension should fail to run rather than run with a capability it was never reviewed for. Three real, state-mutating bridge methods — `colorizeAll`, `resetColors`, `resetVisibility` — had no entry in the `viewer` namespace's `methods` overrides, so a script calling them inferred only the namespace default `viewer.read` instead of `viewer.colorize`/`viewer.isolate`. A script whose only viewer call was `bim.viewer.resetColors()` would have its capability grant pre-filled as read-only on the promote review screen while actually able to mutate colors/visibility at runtime.

`colorizeAll`/`resetColors` now map to `viewer.colorize` and `resetVisibility` now maps to `viewer.isolate`, matching the existing `colorize`/`isolate`/`hide`/`show` entries for the same real methods.
