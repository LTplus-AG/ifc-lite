---
"@ifc-lite/viewer": minor
---

Let the Properties → bSDD card read from dictionaries other than IFC. Two
searchable pickers now sit at the top of the card:

- **Dictionary search** — a searchable field over the *entire* bSDD catalogue
  (IFC 4.3 pinned first, every other published dictionary below), not a
  hardcoded shortlist.
- **Class search** (for non-IFC dictionaries) — search that dictionary's
  classes directly (server-side), seeded with classes related to the current
  IFC entity type as suggestions. Picking a class surfaces its property sets
  through the existing one-click add-to-element flow.

The chosen dictionary persists to `localStorage`. Empty/missing states are
handled with a one-click "Back to IFC 4.3". Closes #1219.
