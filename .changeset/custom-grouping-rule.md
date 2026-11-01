---
"@ifc-lite/rules": minor
"@ifc-lite/viewer": minor
---

A new `customGrouping` filter rule selects elements by their group in a user-authored grouping (#8425). A grouping is an ordered list of named filter groups, and each element belongs to the first one it matches, so groups never overlap. In the viewer, every saved rule-based Lens is a grouping: pick "Custom grouping" in the search filter, a clash set, a list scope, a validation rule or another Lens to reuse its rule names. A reference stores the Lens id and name: an existing id wins, otherwise the name must match exactly one Lens, so a Lens file imported into another project still works. An unknown grouping or group matches nothing and is flagged in the editor, and a grouping that refers to itself is refused.

`@ifc-lite/rules` also adds `evaluateOptionsOf(model)`, the single-model options that give an `EvaluatorModel` its federated meaning, and the synchronous evaluator now reads a model's live edits through `EvaluateOptions.mutationView`. The viewer's SDK filtered export uses it, so a saved `model` rule keyed by the source fingerprint matches there, and live edits count.
