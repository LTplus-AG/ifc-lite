# Saved-filter appearance scopes (#4404)

The real AC20 building was loaded through the normal viewer file picker using
WebGPU and the existing native appearance worker. The saved Search preset was
seeded through `saveFilter`, then selected through Appearance's **Saved filter**
control. Its GlobalId predicate identifies mapped member #35169.

The [preview](preview.png) shows its applied image and copied filter scope.
Compare restores the original instance; Apply materializes exactly one textured
owner; Undo/Redo restore the corresponding representations. The repeated sibling
#35304 keeps identical instance positions throughout.

[Save recipe](recipe-saved.png) writes the exact query and reviewed GlobalId
membership to [the portable logical recipe](query-recipe.json). A fresh page
reloads the original IFC and image, restores the recipe, binds the new runtime
model explicitly, and reports zero added/removed/renumbered members. After
acceptance, Preview all and Apply produce one textured 12-triangle owner with
its original instance suppressed and one Undo entry. The [restored screenshot](restored-applied.png)
shows that owner with its selection overlay; [Scene assertions](restored-geometry.json)
verify the texture and occurrence ownership directly.

[The evidence record](viewer-acceptance.json) pins source, runtime, fixture and
asserted states. The manual harness is
[`accept-query-scope.mjs`](../../../../tools/texture-authoring/accept-query-scope.mjs);
run it against an isolated local viewer with `EVALUATED_URL` and `EVALUATED_OUT`.
It closes its browser in `finally`. This is behavior evidence, not a performance
measurement or a new IFC export interoperability claim.

Automated invariants cover effective unsaved SDK Name edits and stale snapshot
refusal, complete results beyond Search's display limit, model-local candidate
ownership, strict whole-query refusal, frozen preset refresh, and recipe
validation. Exact session-bound storey references are refused; named-storey
queries deliberately retain Search's duplicate-name semantics. Face masks are
still pending under #4404.
