---
"@ifc-lite/viewer": patch
---

An active lens keeps working after its panel closes. Lens evaluation and its hides now run from a host that is mounted for the viewer's lifetime, not from the Lens panel. A model federated in or edited while the panel is closed is now coloured and hidden by the lens too. Home and Show all keep the active lens's hides, like they already kept its colours, and remove only the user's own hides.
