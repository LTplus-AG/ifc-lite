<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-ENT-001: Abstract entity in an entity facet

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| error | static | specification | yes |

IDS 1.0 entity facets match the exact class, never its subtypes. An abstract class such as IfcBuildingElement is never instantiated, so a facet naming it matches no element at all: an applicability selects nothing and a requirement always fails.

## Example

```xml
<entity><name><simpleValue>IFCBUILDINGELEMENT</simpleValue></name></entity>
```

## Quick fix

Replace the abstract class by an enumeration of its concrete subtypes (those concrete in every IFC version of the specification). Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Verified assumptions

- **A-03**: buildingSMART corpus case entity/invalid-subclasses_are_not_considered_as_matching (IFCWALL does not match an IFCWALLSTANDARDCASE instance) and the exact-match entity checker in @ifc-lite/ids (checkEntityFacet), which cites the IDS user manual: "There is no automatic inheritance in IDS entity facet interpretation".

## References

- <https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/entity-facet.md>

## Suppressing

Add a suppression with a reason for `IDSL-ENT-001` (or `IDSL-ENT-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
