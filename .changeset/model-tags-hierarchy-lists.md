---
"@ifc-lite/viewer": minor
"@ifc-lite/lists": minor
---

Model tags for federations (#4215, part 2): the hierarchy's Models section gains a "By tag" grouping (one group per tag plus an explicit Untagged group; a model under several tags is listed under each but stays one model — counts, visibility and selection deduplicate by model), tag chips that filter the listed rows without touching the viewport, and a separate explicit "Isolate matching models" action that shows the listed models and hides the rest in one store write. Lists gain a model tag scope (`ListDefinition.modelTagScope`, the same `has any` / `has all` / `has none` / `untagged` predicates as search and clash): the list runs only over the models in scope, and a scope naming a deleted tag — or one no loaded model satisfies — is refused with a visible reason instead of running over every model.
