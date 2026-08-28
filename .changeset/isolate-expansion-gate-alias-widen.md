---
'@ifc-lite/viewer': patch
'@ifc-lite/viewer-embed': patch
---

Dev-tooling change only, no runtime behaviour change: widens `scripts/check-isolate-expansion-routing.mjs` (issue #3338's gate against a new isolate/highlight channel skipping assembly expansion) to catch two more ways a channel can rebind the store's raw isolation actions without ever writing the literal call the gate previously looked for — a destructuring rename in function-parameter position or via a keyword-less reassignment (`ALIAS_DESTRUCTURE_PATTERN`, previously anchored to `const { ... } =` only), and a plain member-access rebinding with no destructuring syntax at all (`const apply = state.isolateEntities; apply(ids)`), now caught by the new `PROPERTY_ALIAS_PATTERN`. Both shapes previously passed the gate silently; a planted fixture using the member-access form is included as a live proof in `scripts/check-isolate-expansion-routing.test.mjs`.
