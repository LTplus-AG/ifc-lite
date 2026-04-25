---
"@ifc-lite/viewer": patch
---

Address PR #588 review feedback that survived the Filter migration:

- Inline-bar Enter now flushes the 80ms debounce by re-scanning against
  the live `searchQuery`, so committing inside the debounce window
  selects the entity matching what the input shows (not the prior
  query) and records the correct recent.
- The 50ms `frameSelection` timer in the inline bar is tracked via a
  ref and cleared on rapid selection changes / unmount instead of
  leaking orphan callbacks.
- Shift+Enter additive selection in the inline bar and the row-level
  additive path in the Search modal now TOGGLE via `toggleEntitySelection`,
  so the same interaction can deselect a previously-added row.
- New `addEntitiesToSelection` batch action on the selection slice;
  the Search modal's "Select all" path uses it so a 5K-row select-all
  dispatches one Zustand `set` instead of N.
- Tier-0 scoring now keeps the max across name/type/objectType/description
  fields (matching Tier-1's behaviour). Without this, an entity with a
  substring name hit and a type-exact hit ranked lower than it should
  on Tier-0, breaking the comparable-ordering guarantee when results
  came from a mix of Tier-0 and Tier-1 models.
