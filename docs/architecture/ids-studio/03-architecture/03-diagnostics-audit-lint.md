# Diagnostics: Audit (conformance) and Lint (meaning)

## 1. Two engines, one diagnostic shape

| | **Audit** | **Lint** |
|---|---|---|
| Question | "Is this a valid IDS 1.0 file?" | "Does this IDS mean what the author intends, and will it behave well?" |
| Authority | IDS XSD + buildingSMART Audit Tool semantics | Our rule catalogue (documented, versioned) |
| Severity | Error (blocks export) | Error / Warning / Info |
| Inputs | IDS only (+ schema tables) | IDS + schema + bSDD cache + optionally loaded models |
| Home | `@ifc-lite/ids/audit` (existing, extended) | `@ifc-lite/ids-authoring/lint` (new) |

```ts
interface Diagnostic {
  code: string;                 // 'IDS-AUDIT-xxx' | 'IDSL-XXX-nnn'
  severity: 'error' | 'warning' | 'info';
  nodeId: Uuid; field?: string; // location in StudioDocument
  message: string;              // i18n key + params
  why?: string;                 // explanation key (long form)
  fixes?: QuickFix[];           // each = { label, ops: Op[] , preview?: true }
  evidence?: { count?: number; sample?: EntityRef[] }; // model-aware rules
  docsUrl: string;              // per-rule page
}
```

Agent, UI, CLI (`ids lint --json`) and MCP all consume the same `Diagnostic[]`.

## 2. Audit completion (P-01)
Target: every one of the 27 `invalid-` corpus cases detected, so `AUDIT_UNDETECTED` becomes empty. Work items:
- Classify the 21 undetected cases by defect family:
  - XSD structural
  - restriction-base mismatch
  - cardinality placement
  - partOf shape
  - dataType casing
  - … (exact list to be derived in IDS-004)
- Group them into one PR per family, per house rules (IDS-004…008).
- Extend audit to conjunctive siblings (`and[]`), which today inspect only the primary family.
- Cross-check: CI job runs the official `ids-audit-tool` (NuGet) on all exported test docs and compares verdicts (oracle). Disagreements are triaged as our bug, their bug or a spec ambiguity. Spec ambiguities are filed upstream.

## 3. Lint rule catalogue (v1)

Code format: `IDSL-<AREA>-<nnn>`. Areas:
- ENT entity
- PDT predefined type
- ATT attribute
- PSET property set
- PROP property
- VAL value
- UNIT units
- REGEX patterns
- CARD cardinality
- SPEC specification-level
- DOC document
- BSDD
- MODEL model-aware
- VER versions

"Static" rules need no model; "Model" rules run in the worker when models are loaded. A ✚ marks a rule we have not seen in other IDS tools.

### Entity and types
| Code | Sev | Static/Model | Rule | Quick fix |
|---|---|---|---|---|
| IDSL-ENT-001 ✚ | error | S | **Abstract entity in an entity facet.** IDS 1.0 entity matching doesn't include subtypes, so e.g. `IfcBuildingElement` matches no element. *Verify the semantics against the IDS docs and corpus (A-03).* | Expand to concrete subtypes: (a) enumeration of names in one facet, (b) one spec per subtype |
| IDSL-ENT-002 | warning | S | Deprecated entity in the target version (e.g. `IfcWallStandardCase` in IFC4X3) | Retarget to its replacement |
| IDSL-ENT-003 ✚ | info | S | Entity has subtypes the author may also mean (e.g. `IfcWall` vs `IfcCurtainWall`, `IfcSlab` vs `IfcRoof` components) | Add subtype(s) to the enumeration |
| IDSL-ENT-004 | warning | S | Type entity used where occurrence is likely meant (e.g. `IfcDoorType` in applicability with occurrence psets) | Switch to occurrence; note that properties inherit from the type |
| IDSL-PDT-001 | error | S | PredefinedType not in the entity's enum for the version | Pick from the enum |
| IDSL-PDT-002 ✚ | info | S | `USERDEFINED` predefined type without an `ObjectType` attribute requirement (#178, #447) | Add an attribute facet ObjectType |
| IDSL-ATT-001 | error | S | Attribute not defined on the entity (including inherited) | Candidates |
| IDSL-ATT-002 ✚ | warning | S | Attribute value check on an attribute of entity/select type (not a simple value) | Explain; suggest existence-only |

### Property sets and properties
| Code | Sev | S/M | Rule | Quick fix |
|---|---|---|---|---|
| IDSL-PSET-001 ✚ | warning | S | Standard pset not applicable to any entity in the applicability (per `applicableEntities`) | Suggest applicable psets that hold the same property name |
| IDSL-PSET-002 | error | S | Custom pset uses a reserved prefix (`Pset_`, `Qto_`, …) | Rename with a project prefix |
| IDSL-PSET-003 ✚ | warning | S | Qto (quantity set) used with a non-measure dataType or a string value | Fix dataType |
| IDSL-PROP-001 | error | S | Property not in that standard pset | Candidates (same pset, same name elsewhere) |
| IDSL-PROP-002 ✚ | warning | S | dataType mismatch with the standard property's declared type | Set the correct dataType |
| IDSL-PROP-003 ✚ | info | S | Property requirement without dataType where the type matters for comparison (numeric bounds on an untyped property) | Add dataType from the schema |
| IDSL-PROP-004 ✚ | info | M | Property found on *type* objects only in the loaded model (inheritance applies; IFC2X3 type mapping #116) | Explain only |

### Values and units
| Code | Sev | S/M | Rule | Quick fix |
|---|---|---|---|---|
| IDSL-VAL-001 | error | S | Enumeration value not in the standard property's enumeration | Nearest enum values |
| IDSL-VAL-002 ✚ | warning | S | Restriction base type incompatible with the dataType (pattern on a boolean, bounds on a label) | Change base or dataType |
| IDSL-VAL-003 ✚ | warning | S | Simple value that looks like a list (`[EI60, EI90]`, `EI60, EI90`, `EI60/EI90`) | Convert to enumeration |
| IDSL-VAL-004 ✚ | warning | S | Simple value that looks like a comparison (`>25`, `≥ 0.9`) | Convert to bounds |
| IDSL-VAL-005 ✚ | warning | S | Boolean literal in a form the IDS docs don't accept (casing or 'yes'/'ja') *(exact accepted forms to be verified against the corpus, A-04)* | Normalise |
| IDSL-VAL-006 ✚ | info | S | Leading/trailing whitespace or non-breaking spaces in values | Trim |
| IDSL-VAL-007 ✚ | warning | M | Case-sensitivity trap: the model has values differing only by case or whitespace from the required ones | Pattern with alternation, or keep strict |
| IDSL-VAL-008 ✚ | info | S | Real-number equality (simpleValue on IfcReal/IfcLengthMeasure): exact float match is brittle; tolerance is under discussion in IDS 1.1 (#418) | Convert to a bounds range |
| IDSL-UNIT-001 ✚ | warning | S | Numeric value magnitude suggests non-SI units (e.g. length 2400 → probably mm; area 15,000,000) | Convert to SI |
| IDSL-UNIT-002 ✚ | info | M | Model project units differ from SI; displays the conversion used | — |

### Patterns
| Code | Sev | S/M | Rule | Quick fix |
|---|---|---|---|---|
| IDSL-REGEX-001 ✚ | warning | S | `^` or `$` in an XSD pattern are literal characters (XSD patterns are implicitly anchored) | Remove the anchors |
| IDSL-REGEX-002 ✚ | warning | S | `.*` at both ends is redundant, or the pattern equals a simple value | Simplify |
| IDSL-REGEX-003 | error | S | Pattern uses constructs unsupported in XSD regex (lookaround, backrefs, `\d` vs XSD semantics notes, non-greedy) | Rewrite |
| IDSL-REGEX-004 | error | S | Catastrophic backtracking risk (regex-guard) | Rewrite |
| IDSL-REGEX-005 ✚ | info | M | Pattern matches 0 distinct model values while near-misses exist | Show the near-misses |

### Cardinality and spec semantics
| Code | Sev | S/M | Rule | Quick fix |
|---|---|---|---|---|
| IDSL-CARD-001 ✚ | warning | S | Prohibited requirement with a value or dataType (ambiguity #206, #420: "must not have" vs "must not have this value") | Explain both readings; pick one with an explicit structure |
| IDSL-CARD-002 ✚ | info | S | Optional requirement without a value (no-op in IDS 1.0 semantics) | Remove, or make required |
| IDSL-CARD-003 ✚ | warning | S | Spec cardinality `prohibited` with requirements present (requirements are ignored) | Remove requirements, or change cardinality |
| IDSL-CARD-004 ✚ | info | S | Spec `required` with a very specific applicability, which will fail models that legitimately lack such elements | Suggest optional |
| IDSL-SPEC-001 ✚ | warning | S | **Can never fail:** a requirement facet is implied by an applicability facet (same field, same or weaker constraint) | Remove the requirement, or move it out of applicability |
| IDSL-SPEC-002 ✚ | error | S | **Contradiction:** two requirements on the same field with disjoint constraints (enumerations without overlap, empty bound intersection) | Show the conflict |
| IDSL-SPEC-003 ✚ | warning | S | **Never applies (static):** contradictory applicability facets (two entity facets with different names, disjoint values) | — |
| IDSL-SPEC-004 ✚ | warning | M | **Never applies (model):** zero applicable elements across loaded models | Show the funnel stage where the count hits 0 |
| IDSL-SPEC-005 ✚ | warning | S | Duplicate specs (same applicability and requirements) | Merge |
| IDSL-SPEC-006 ✚ | warning | S | Overlapping specs with conflicting requirements on the same elements | Show the pair |
| IDSL-SPEC-007 | info | S | Spec without a requirement (pure existence check): intentional? | — |
| IDSL-SPEC-008 | info | S | Missing description/instructions (modeller-facing quality) | AI: draft instructions |
| IDSL-SPEC-009 | warning | S | Duplicate `identifier` values | Renumber |
| IDSL-SPEC-010 ✚ | info | M | Requirement passes on 100% of applicable elements in all loaded models (fine, but is it too weak?) | — |

### Document, versions, bSDD
| Code | Sev | S/M | Rule | Quick fix |
|---|---|---|---|---|
| IDSL-DOC-001 | error | S | `author` not an email; `date` not xs:date | Fix |
| IDSL-VER-001 ✚ | warning | S | Multi-version spec uses names valid in only one version | Split the spec per version |
| IDSL-VER-002 ✚ | warning | M | Loaded model schema ≠ spec ifcVersion (spec silently not applicable) | Explain |
| IDSL-BSDD-001 | warning | S | Classification/property URI not found or inactive in bSDD | Search the replacement |
| IDSL-BSDD-002 ✚ | info | S | Classification `system` name differs from the bSDD dictionary name for that URI | Align |
| IDSL-BSDD-003 ✚ | warning | S | Allowed values from bSDD differ from the IDS enumeration | Sync |
| IDSL-PART-001 ✚ | info | S | partOf relation/entity combination unlikely per the schema (e.g. `IfcRelVoidsElement` with a non-opening) | Candidates |

**Count:** 51 rules in v1. β ships ≥25 static rules; GA ships all (FR-C02).

## 4. Engine design
- Rules are pure functions: `(ctx: LintContext, scope: Uuid[]) → Diagnostic[]`, registered with metadata (code, default severity, static/model, docs).
- **Incremental:** the reducer reports `touched` node IDs, and only rules whose scope intersects are re-run. Document-level rules (duplicates, overlaps) use per-spec signatures cached by hash.
- Model rules run in the IDS worker with the same accessor as previews. Results are tagged with a model-set hash so stale results are discarded.
- Each rule ships with: docs page (markdown in `docs/guide/ids-lint/`), ≥2 positive and ≥2 negative fixtures, and quick-fix tests (apply fix → rule clears, audit stays clean).
- **Lint corpus:** a labelled set of real-world IDS files collected with permission or authored internally, used to measure precision (FR-C05).

## 5. Upstream contribution
Rules that reveal spec ambiguity (CARD-001, ENT-001, VAL-005, VAL-008) are linked to the corresponding buildingSMART/IDS issues. Publishing the catalogue makes ifc-lite the reference for what an IDS really means.
