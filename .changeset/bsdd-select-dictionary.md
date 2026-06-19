---
"@ifc-lite/viewer": minor
---

Let the Properties → bSDD card read from dictionaries other than IFC.

- **Dictionary picker** — a searchable field over the entire bSDD catalogue
  (IFC 4.3 pinned first, ~400 dictionaries), browsable by scrolling.
- **Class browser** (for non-IFC dictionaries) — a scrollable, paginated list
  of the dictionary's classes that loads more as you scroll (infinite scroll
  via the bSDD `Dictionary/Classes` `Offset`/`Limit` endpoint, so a 5,000-class
  dictionary is never fetched at once). A filter box narrows the list. Picking
  a class surfaces its property sets through the existing one-click
  add-to-element flow.

The chosen dictionary persists to `localStorage`; IFC behaviour is unchanged
(resolved by entity-type name). Closes #1219.
