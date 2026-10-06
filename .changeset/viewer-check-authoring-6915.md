---
"@ifc-lite/viewer": minor
---

Assistant drafts IDS specifications, information rules and report outlines for review (#6915). Each draft is checked natively (IDS audit, rule-set parser, document validator) and dry-run on the loaded models with the panel's own engines, showing per-check counts and failing elements in the model. It is saved only after review, into the IDS or rule library or the Documents library, with an `.ids` export and a handoff to the native editor. Requirements no engine can check are kept as explicit unsupported items in the review and in the saved draft.
