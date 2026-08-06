---
"@ifc-lite/merge": patch
---

Fix `componentKeyForAttribute` silently misclassifying a custom-named (not `Pset_`/`Qto_`-prefixed) property or quantity set, breaking whole-set tombstone lookups for it, and fix a member deletion on such a set being routed to a different component than the value it targets — so the member survived the delete.

`componentKeyForAttribute` bucketed a `bsi::ifc::v5a::<Set>::<Member>` attribute as `pset:<Set>`/`qset:<Set>` only when `<Set>` matched a literal `Pset_`/`Qto_` prefix, falling back to a one-off-per-attribute `attr:<key>` bucket for any other name. `packages/mutations/src/change-set-to-ops.ts` builds `pset:<name>`/`qset:<name>` component keys unconditionally from the mutation type, for any author-chosen name, and `@ifc-lite/collab`'s structured-attribute inflation already disambiguates a custom set name by value shape (typed record -> pset, plain finite number -> quantity) — its own doc comment describes that as a convention "the merge engine's `pset:`/`qset:` component keys... already share", which this package didn't actually hold up.

The observable break: `apps/viewer/src/lib/layers/publish.ts`'s `buildDeltaNodes` resolves a whole-component tombstone (`DELETE_PROPERTY_SET`/`DELETE_QUANTITY_SET`) by looking up the base state's members under `pset:<name>`/`qset:<name>`. For a custom-named set, that lookup found nothing (the members lived under `attr:<key>` instead), so zero attributes were nulled — deleting a custom-named property set silently did nothing at all, no error, no diagnostic.

`componentKeyForAttribute` now takes the attribute's value and disambiguates a custom set name by the same shape rule `@ifc-lite/collab` uses. A `null` value (an in-flight single-member deletion, as opposed to a whole-component tombstone) still carries no shape to go on, so that path is unchanged.
