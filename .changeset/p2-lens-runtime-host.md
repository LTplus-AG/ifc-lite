---
"@ifc-lite/viewer": patch
---

An active lens keeps working after its panel closes. Lens evaluation and its hides now run from a host that is mounted for the viewer's lifetime, not from the Lens panel. A model federated in or edited while the panel is closed is now coloured and hidden by the lens too. Every Show all / Home control in the viewer (toolbar, ribbon, context menu, mobile toolbar, `A` key, command palette) keeps the active lens's hides, the same way it already kept the lens's colours, and removes only the user's own hides. The scripting and embed `reset()` still calls the slice-level `showAllInAllModels` and is unchanged.
