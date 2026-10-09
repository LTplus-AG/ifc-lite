<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDS lint rules

The IDS audit answers "is this a valid IDS 1.0 file?". Lint answers "does this IDS mean what the author intends, and will it behave well?": abstract entities that match nothing, `^` in XSD patterns, millimetres where metres are expected, requirements that can never fail or never pass. Lint runs on a `StudioDocument` from `@ifc-lite/ids-authoring` and returns diagnostics with stable codes.

```ts
import { createLintContext, createLinter, fromIdsDocument } from '@ifc-lite/ids-authoring';
import { parseIDS } from '@ifc-lite/ids';

declare const xml: string;
const linter = createLinter(await createLintContext());
const { diagnostics } = linter.lint(fromIdsDocument(parseIDS(xml)));
for (const d of diagnostics) console.log(d.code, d.severity, d.message, d.fixes?.map((f) => f.label));
```

Keep one linter per open document: specification-level findings are cached and only changed specifications are re-checked. A quick fix is a batch of Studio ops; check it with `checkQuickFix` (the grounding gate) and commit it like any other edit. A suppression in the sidecar (`meta.suppressions`, with a reason) silences a rule on a node and everything below it.

Rules that depend on an IDS semantic the standard leaves open ship at `info` until the semantic is verified against the buildingSMART test cases; each rule page lists what was verified.

## Entities

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-ENT-001](idsl-ent-001.md) | error | Abstract entity in an entity facet | yes |
| [IDSL-ENT-002](idsl-ent-002.md) | info | Entity removed in IFC4X3 | yes |
| [IDSL-ENT-003](idsl-ent-003.md) | info | Entity has subtypes the author may also mean | yes |
| [IDSL-ENT-004](idsl-ent-004.md) | warning | Type entity where an occurrence is meant | yes |
| [IDSL-ENT-005](idsl-ent-005.md) | warning | Entity name not in upper case | yes |

## Predefined types

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-PDT-001](idsl-pdt-001.md) | error | Predefined type not in the entity enumeration | yes |
| [IDSL-PDT-002](idsl-pdt-002.md) | info | USERDEFINED predefined type without an ObjectType requirement | yes |
| [IDSL-PDT-003](idsl-pdt-003.md) | info | Undeclared user-defined predefined type | yes |

## Attributes

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-ATT-001](idsl-att-001.md) | error | Attribute not defined on the entity | yes |
| [IDSL-ATT-002](idsl-att-002.md) | warning | Value check on an entity-typed attribute | yes |

## Property sets

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-PSET-001](idsl-pset-001.md) | warning | Standard property set not applicable to the entity | yes |
| [IDSL-PSET-002](idsl-pset-002.md) | error | Custom property set with a reserved prefix | yes |
| [IDSL-PSET-003](idsl-pset-003.md) | warning | Quantity set with a non-measure data type or value | yes |

## Properties

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-PROP-001](idsl-prop-001.md) | error | Property not in the standard property set | yes |
| [IDSL-PROP-002](idsl-prop-002.md) | warning | Data type differs from the standard property | yes |
| [IDSL-PROP-003](idsl-prop-003.md) | info | Numeric constraint without a data type | yes |

## Values

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-VAL-001](idsl-val-001.md) | error | Value not in the standard enumeration | yes |
| [IDSL-VAL-002](idsl-val-002.md) | warning | Restriction base incompatible with the data type | yes |
| [IDSL-VAL-003](idsl-val-003.md) | warning | Simple value that looks like a list | yes |
| [IDSL-VAL-004](idsl-val-004.md) | warning | Simple value that looks like a comparison | yes |
| [IDSL-VAL-005](idsl-val-005.md) | warning | Boolean literal in a form IDS does not accept | yes |
| [IDSL-VAL-006](idsl-val-006.md) | info | Leading or trailing whitespace, or invisible characters | yes |
| [IDSL-VAL-008](idsl-val-008.md) | info | Exact match on a real number | no |

## Units

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-UNIT-001](idsl-unit-001.md) | warning | Magnitude suggests a non-SI unit | yes |

## Patterns

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-REGEX-001](idsl-regex-001.md) | warning | ^ or $ in an XSD pattern | yes |
| [IDSL-REGEX-002](idsl-regex-002.md) | warning | Pattern that is a plain value or matches everything | yes |
| [IDSL-REGEX-003](idsl-regex-003.md) | warning | Construct not supported by XSD regex | yes |
| [IDSL-REGEX-004](idsl-regex-004.md) | error | Catastrophic backtracking risk | no |

## Cardinality

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-CARD-001](idsl-card-001.md) | warning | Prohibited requirement with a value or data type | yes |
| [IDSL-CARD-002](idsl-card-002.md) | info | Optional requirement that checks nothing | yes |
| [IDSL-CARD-003](idsl-card-003.md) | warning | Prohibited specification with requirements | yes |
| [IDSL-CARD-004](idsl-card-004.md) | info | Required specification with a narrow applicability | yes |

## Specifications

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-SPEC-001](idsl-spec-001.md) | warning | Requirement that can never fail | yes |
| [IDSL-SPEC-002](idsl-spec-002.md) | error | Contradictory requirements | no |
| [IDSL-SPEC-003](idsl-spec-003.md) | warning | Applicability that can never match | no |
| [IDSL-SPEC-005](idsl-spec-005.md) | warning | Duplicate specification | yes |
| [IDSL-SPEC-006](idsl-spec-006.md) | warning | Overlapping specifications with conflicting requirements | no |
| [IDSL-SPEC-007](idsl-spec-007.md) | info | Specification without requirements | no |
| [IDSL-SPEC-008](idsl-spec-008.md) | info | Specification without description or instructions | no |
| [IDSL-SPEC-009](idsl-spec-009.md) | warning | Duplicate identifier | yes |

## Document

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-DOC-001](idsl-doc-001.md) | error | Author is not an e-mail address, or date is not xs:date | yes |

## IFC versions

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-VER-001](idsl-ver-001.md) | warning | Name valid in only some IFC versions of the specification | yes |

## partOf relations

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-PART-001](idsl-part-001.md) | info | Unlikely partOf relation for these entities | yes |

## bSDD references

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| [IDSL-BSDD-001](idsl-bsdd-001.md) | warning | bSDD URI not found or inactive | yes |
| [IDSL-BSDD-002](idsl-bsdd-002.md) | info | Classification system differs from the bSDD dictionary name | yes |
| [IDSL-BSDD-003](idsl-bsdd-003.md) | warning | Value outside the allowed values bSDD publishes | yes |
