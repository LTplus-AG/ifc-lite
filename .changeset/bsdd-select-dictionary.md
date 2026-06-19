---
"@ifc-lite/viewer": minor
---

Let the Properties → bSDD card read from dictionaries other than IFC. A
source-dictionary picker now sits at the top of the card: it offers IFC 4.3
(the default) plus every other bSDD that maps classes to the selected entity
type — Uniclass, ETIM, NL-SfB, or an organisation's own published dictionary.
Picking a non-IFC dictionary fetches that dictionary's related class(es),
merges their property sets (deduped by `propertySet:name`), and exposes them
through the existing one-click add-to-element flow. The choice persists to
`localStorage`, and a dictionary with no definitions for the current type
shows a clear empty state with a one-click "Back to IFC 4.3". Closes #1219.
