# IDS Conformance Dashboard

How IDS engines answer the buildingSMART IDS 1.0 test cases, case by case.

The corpus is buildingSMART's own: 334 IDS files, each with the verdict it
expects in its name. `pass-` and `fail-` files pair an IDS with an IFC model
and ask whether the model satisfies the specification. `invalid-` files ask
whether the IDS document itself conforms; an engine with a document audit
must reject them. ifc-lite vendors the corpus unchanged in
`packages/ids/src/__corpus__/buildingsmart-ids` (CC BY-ND 4.0).

The dashboard runs each engine through a small adapter and records every
verdict. It only reports what was run: an engine appears here when it can be
installed from a public package registry under an open-source licence and
run headless. Commercial tools are not included.

## Reproduce

```bash
pnpm turbo build --filter=@ifc-lite/ids...
node scripts/ids-conformance/run.mjs
```

This rewrites [`ids-conformance.json`](ids-conformance.json) (every case for
every engine, plus summaries) and the generated section below. Add an engine
installed outside this repository:

```bash
# An open-source engine from npm, run in-process
npm install --prefix /tmp/thatopen --ignore-scripts \
  @thatopen/components@3.4.9 @thatopen/fragments@3.4.8 \
  web-ifc@0.0.78 three@0.182.0 camera-controls web-worker
node scripts/ids-conformance/run.mjs --thatopen-root /tmp/thatopen

# Any engine in another runtime, through a command adapter
node scripts/ids-conformance/run.mjs --engine-config my-engine.json
```

## Adding an engine

An adapter answers one or both corpus questions for one IDS+IFC pair:

| Method | Input | Output |
|---|---|---|
| `validate` | the `.ids` and `.ifc` paths | `'pass'` or `'fail'`: the verdict of the file's single specification |
| `audit` | the `.ids` path | `'valid'` or `'invalid'` |

A question the engine does not offer is `n/a` and never counted. A crash is
an `error` and counts as a disagreement. An adapter may translate engine
output into a verdict, but it must say how in its notes, which the report
prints next to the numbers.

Engines in other runtimes plug in without code through a JSON
`--engine-config` (see `scripts/ids-conformance/lib/adapters/command.mjs`):

```json
{
  "id": "my-engine",
  "name": "My engine",
  "version": "1.2.3",
  "licence": "MIT",
  "source": "https://example.org/my-engine",
  "notes": ["validate: runs the engine CLI; spec status of the single specification"],
  "validate": ["python3", "-I", "bridge.py", "{ids}", "{ifc}"],
  "audit": ["my-engine", "audit", "{ids}"]
}
```

The command prints one JSON line, for example `{"verdict": "fail"}`, or
`{"verdict": "unsupported", "reason": "..."}` for a case it cannot answer.

Engines considered for this page and not run yet are listed in the IDS Studio
P-12 work log with the reason (runtime missing in the build environment, or a
licence that is not permissive), together with the exact command to add them.

<!-- BEGIN GENERATED: ids-conformance -->
Corpus: buildingSMART IDS 1.0 test cases (vendored in packages/ids/src/__corpus__/buildingsmart-ids), 334 cases (CC BY-ND 4.0; https://github.com/buildingSMART/IDS).
Generated from [`ids-conformance.json`](ids-conformance.json) by `node scripts/ids-conformance/run.mjs`; do not edit by hand.

| Engine | Version | Licence | Source |
|---|---|---|---|
| ifc-lite | @ifc-lite/ids 3.2.0 (workspace) | MPL-2.0 | packages/ids in this repository |
| ifc-lite (IDS 1.1 preview) | @ifc-lite/ids 3.2.0 (workspace) | MPL-2.0 | packages/ids in this repository |
| @thatopen/components (IDS module) | 3.4.9 (fragments 3.4.8, web-ifc 0.0.78) | MIT (web-ifc: MPL-2.0) | https://www.npmjs.com/package/@thatopen/components |

### Agreement with the corpus

Each cell is cases agreeing with the expected verdict out of cases the engine answered. `n/a` cases (a question the engine does not offer) are not counted; an `error` (the engine crashed or gave no verdict) counts as a disagreement.

| Facet (corpus folder) | ifc-lite | ifc-lite (IDS 1.1 preview) | @thatopen/components (IDS module) |
|---|---|---|---|
| attribute | 56/56 (100.0%) | 56/56 (100.0%) | 27/45 (60.0%) · 11 n/a |
| classification | 27/27 (100.0%) | 27/27 (100.0%) | 17/27 (63.0%) |
| entity | 33/33 (100.0%) | 33/33 (100.0%) | 20/27 (74.1%) · 2 error, 6 n/a |
| ids | 12/12 (100.0%) | 12/12 (100.0%) | 11/11 (100.0%) · 1 n/a |
| material | 29/29 (100.0%) | 29/29 (100.0%) | 24/29 (82.8%) |
| partof | 34/34 (100.0%) | 34/34 (100.0%) | 17/33 (51.5%) · 1 n/a |
| property | 82/82 (100.0%) | 82/82 (100.0%) | 51/76 (67.1%) · 19 error, 6 n/a |
| restriction | 25/25 (100.0%) | 25/25 (100.0%) | 17/23 (73.9%) · 2 n/a |
| tolerance | 36/36 (100.0%) | 36/36 (100.0%) | 22/36 (61.1%) |
| *all `pass-` cases* | 187/187 (100.0%) | 187/187 (100.0%) | 129/187 (69.0%) · 13 error |
| *all `fail-` cases* | 120/120 (100.0%) | 120/120 (100.0%) | 77/120 (64.2%) · 8 error |
| *all `invalid-` cases* | 27/27 (100.0%) | 27/27 (100.0%) | n/a (27) |
| **all cases** | **334/334 (100.0%)** | **334/334 (100.0%)** | **206/307 (67.1%) · 21 error, 27 n/a** |

### How each column is produced

- **ifc-lite**
    - validate: parseIDS + validateIDS over @ifc-lite/parser; the verdict is the status of the file's single specification.
    - audit: auditIDSDocument; a document with at least one error-severity issue is invalid.
- **ifc-lite (IDS 1.1 preview)**
    - validate: parseIDS + validateIDS over @ifc-lite/parser; the verdict is the status of the file's single specification.
    - audit: auditIDSDocument; a document with at least one error-severity issue is invalid.
    - IDS 1.1 preview flag on parse, validate and audit (#418 tolerance candidate applies to simple values).
- **@thatopen/components (IDS module)**
    - validate: IfcLoader converts the IFC, IDSSpecifications loads the IDS, the single specification is tested; the engine reports one pass/fail per applicable element.
    - The adapter derives the specification verdict with IDS 1.0 cardinality: fail if any applicable element fails, if fewer elements apply than minOccurs (default 1), or if maxOccurs="0" and any element applies. Applicable elements are collected with the engine's own applicability facets, as its test() does.
    - IfcLoader runs with its default import settings. Entities its importer does not convert (for example IfcTaskTime, which is not a product) are invisible to the engine, so a specification on them finds nothing applicable.
    - audit: not offered by the engine; invalid- cases are n/a.

### Disagreements

#### ifc-lite: 0

None.

#### ifc-lite (IDS 1.1 preview): 0

None.

#### @thatopen/components (IDS module): 101

| Case | Expected | Got | Detail |
|---|---|---|---|
| `attribute/fail-an_optional_attribute_fails_if_empty` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-attributes_referencing_an_object_should_pass` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-attributes_with_a_boolean_false_should_pass` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-attributes_with_a_boolean_true_should_pass` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-attributes_with_a_select_referencing_a_primitive_should_pass` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-attributes_with_a_select_referencing_an_object_should_pass` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-attributes_with_a_zero_duration_should_pass` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-booleans_must_be_specified_as_lowercase_strings_3_3` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-dates_are_treated_as_strings_2_2` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-durations_are_treated_as_strings_1_2` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-globalids_are_treated_as_strings_and_not_expanded` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-numeric_values_are_checked_using_type_casting_1_4` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-numeric_values_are_checked_using_type_casting_2_4` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-numeric_values_are_checked_using_type_casting_3_4` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-only_specifically_formatted_numbers_are_allowed_3_4` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-only_specifically_formatted_numbers_are_allowed_4_4` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-strict_numeric_checking_may_be_done_with_a_bounds_restriction` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `attribute/pass-typecast_checking_may_also_occur_within_enumeration_restrictions` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `classification/fail-a_classification_facet_with_no_data_matches_any_classification_1_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `classification/fail-a_prohibited_classification_reference_returns_the_opposite_of_a_required_facet` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `classification/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `classification/fail-a_required_classification_system_fails_if_no_match` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `classification/fail-an_optional_classification_value_fails_if_no_match` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `classification/fail-both_system_and_value_must_match__all__not_any__if_specified_2_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `classification/fail-occurrences_override_the_type_classification_per_system_2_3` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `classification/fail-restrictions_can_be_used_for_systems_1_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `classification/fail-restrictions_can_be_used_for_values_3_3` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `classification/fail-systems_should_match_exactly_2_5` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `entity/fail-a_null_predefined_type_should_always_fail_a_specified_predefined_types` | fail | error | Cannot use 'in' operator to search for 'value' in undefined |
| `entity/fail-restrictions_can_be_specified_for_the_predefined_type_3_3` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `entity/pass-in_ifc2x3_a_user_defined_airterminal_predefined_type_resolves_via_the_type_mapping_table_1_2` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `entity/pass-in_ifc2x3_an_airterminal_can_be_checked_by_name_via_the_type_mapping_table_1_2` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `entity/pass-in_ifc2x3_an_airterminal_predefined_type_resolves_via_the_type_mapping_table_1_2` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `entity/pass-in_ifc2x3_there_must_be_an_airterminal_per_the_type_mapping_table_1_2` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `entity/pass-inherited_predefined_types_should_pass` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `material/fail-a_constituent_set_with_no_data_will_fail_a_value_check` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `material/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `material/fail-an_optional_material_fails_if_no_value_matches` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `material/pass-an_optional_material_passes_if_null` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `material/pass-occurrences_can_inherit_materials_from_their_types` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-a_group_entity_must_match_exactly_1_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-a_non_aggregated_element_fails_an_aggregate_relationship` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-a_non_grouped_element_fails_a_group_relationship` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-an_aggregate_may_specify_the_entity_of_the_whole_2_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-an_aggregate_may_specify_the_predefined_type_of_the_whole_2_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-any_contained_element_passes_a_containment_relationship_1_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-any_nested_whole_fails_a_nest_relationship` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-the_aggregated_whole_fails_an_aggregate_relationship` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-the_container_entity_must_match_exactly_1_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-the_container_itself_always_fails` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-the_container_must_be_related_using_specified_relation_2_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-the_container_predefined_type_must_match_exactly_1_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-the_containment_can_be_indirect_2_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-the_nest_entity_must_match_exactly_1_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `partof/fail-the_nest_predefined_type_must_match_exactly_1_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `property/fail-a_logical_unknown_is_considered_false_and_will_not_pass` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `property/fail-any_matching_value_in_a_bounded_property_will_pass_4_4` | fail | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/fail-any_matching_value_in_a_list_property_will_pass_3_3` | fail | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/fail-any_matching_value_in_a_table_property_will_pass_3_3` | fail | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/fail-complex_properties_are_not_supported_1_2` | fail | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/fail-no_matching_value_in_an_enumerated_property_will_fail_3_3` | fail | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/fail-predefined_properties_are_supported_but_discouraged_2_2` | fail | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/fail-reference_properties_are_treated_as_objects_and_not_supported` | fail | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/fail-unit_conversions_shall_take_place_to_ids_nominated_standard_units_1_2` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `property/pass-any_matching_value_in_a_bounded_property_will_pass_1_4` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-any_matching_value_in_a_bounded_property_will_pass_2_4` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-any_matching_value_in_a_bounded_property_will_pass_3_4` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-any_matching_value_in_a_list_property_will_pass_1_3` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-any_matching_value_in_a_list_property_will_pass_2_3` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-any_matching_value_in_a_table_property_will_pass_1_3` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-any_matching_value_in_a_table_property_will_pass_2_3` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-any_matching_value_in_an_enumerated_property_will_pass_1_3` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-any_matching_value_in_an_enumerated_property_will_pass_2_3` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-material_properties_are_supported_under_ifc2x3_via_extendedmaterialproperties` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `property/pass-material_properties_are_supported_under_ifc4_via_ifcmaterialproperties` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `property/pass-predefined_properties_are_supported_but_discouraged_1_2` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-properties_can_be_inherited_from_the_type_1_2` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-properties_can_be_inherited_from_the_type_2_2` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `property/pass-properties_can_be_overriden_by_an_occurrence_1_2` | pass | error | Cannot use 'in' operator to search for 'value' in undefined |
| `property/pass-unit_conversions_shall_take_place_to_ids_nominated_standard_units_2_2` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `restriction/fail-max_and_min_length_checks_can_be_used_1_3` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `restriction/fail-regex_patterns_work_in_OR_3_3` | fail | pass | 1 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `restriction/pass-a_bound_can_be_exclusive_2_3` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `restriction/pass-a_bound_can_be_inclusive_1_4` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `restriction/pass-a_bound_can_be_inclusive_2_4` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `restriction/pass-a_bound_can_be_inclusive_3_4` | pass | fail | 0 applicable, 0 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_negative_high_number_lower_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_negative_high_number_upper_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_negative_low_number_lower_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_negative_low_number_upper_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_negative_one_lower_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_negative_one_upper_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_one_lower_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_one_upper_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_positive_high_number_lower_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_positive_high_number_upper_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_positive_low_number_lower_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_positive_low_number_upper_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_zero_lower_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |
| `tolerance/pass-comparison_tolerance_for_floating_point_zero_upper_bound` | pass | fail | 1 applicable, 1 failed (minOccurs 1, maxOccurs unbounded) |

??? note "All 334 cases"

    | Case | Expected | ifc-lite | ifc-lite (IDS 1.1 preview) | @thatopen/components (IDS module) |
    |---|---|---|---|---|
    | `attribute/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet` | fail | fail | fail | fail |
    | `attribute/fail-an_optional_attribute_fails_if_empty` | fail | fail | fail | **pass** ✗ |
    | `attribute/fail-attributes_are_not_inherited_by_the_occurrence` | fail | fail | fail | fail |
    | `attribute/fail-attributes_should_check_strings_case_sensitively_2_2` | fail | fail | fail | fail |
    | `attribute/fail-attributes_with_a_logical_unknown_always_fail` | fail | fail | fail | fail |
    | `attribute/fail-attributes_with_an_empty_list_always_fail` | fail | fail | fail | fail |
    | `attribute/fail-attributes_with_an_empty_set_always_fail` | fail | fail | fail | fail |
    | `attribute/fail-attributes_with_empty_strings_always_fail` | fail | fail | fail | fail |
    | `attribute/fail-attributes_with_null_values_always_fail` | fail | fail | fail | fail |
    | `attribute/fail-booleans_must_be_specified_as_lowercase_strings_1_3` | fail | fail | fail | fail |
    | `attribute/fail-dates_are_treated_as_strings_1_2` | fail | fail | fail | fail |
    | `attribute/fail-durations_are_treated_as_strings_2_2` | fail | fail | fail | fail |
    | `attribute/fail-ids_does_not_handle_string_truncation_such_as_for_identifiers` | fail | fail | fail | fail |
    | `attribute/fail-numeric_values_are_checked_using_type_casting_4_4` | fail | fail | fail | fail |
    | `attribute/fail-value_restrictions_may_be_used_3_3` | fail | fail | fail | fail |
    | `attribute/invalid-booleans_must_be_specified_as_lowercase_strings_2_3` | invalid | invalid | invalid | n/a |
    | `attribute/invalid-derived_attributes_cannot_be_checked_and_always_fail` | invalid | invalid | invalid | n/a |
    | `attribute/invalid-integers_cannot_be_expressed_as_floating_point_numbers_2_2` | invalid | invalid | invalid | n/a |
    | `attribute/invalid-invalid_attribute_names_always_fail` | invalid | invalid | invalid | n/a |
    | `attribute/invalid-inverse_attributes_cannot_be_checked_and_always_fail` | invalid | invalid | invalid | n/a |
    | `attribute/invalid-only_specifically_formatted_numbers_are_allowed_1_4` | invalid | invalid | invalid | n/a |
    | `attribute/invalid-only_specifically_formatted_numbers_are_allowed_2_4` | invalid | invalid | invalid | n/a |
    | `attribute/invalid-specifying_a_float_when_the_value_is_an_integer_is_invalid` | invalid | invalid | invalid | n/a |
    | `attribute/invalid-value_checks_always_fail_for_lists` | invalid | invalid | invalid | n/a |
    | `attribute/invalid-value_checks_always_fail_for_objects` | invalid | invalid | invalid | n/a |
    | `attribute/invalid-value_checks_always_fail_for_selects` | invalid | invalid | invalid | n/a |
    | `attribute/pass-a_required_facet_checks_all_parameters_as_normal` | pass | pass | pass | pass |
    | `attribute/pass-an_optional_attribute_passes_if_null` | pass | pass | pass | pass |
    | `attribute/pass-an_optional_attribute_passes_if_specified` | pass | pass | pass | pass |
    | `attribute/pass-attributes_referencing_an_object_should_pass` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-attributes_should_check_strings_case_sensitively_1_2` | pass | pass | pass | pass |
    | `attribute/pass-attributes_with_a_boolean_false_should_pass` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-attributes_with_a_boolean_true_should_pass` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-attributes_with_a_select_referencing_a_primitive_should_pass` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-attributes_with_a_select_referencing_an_object_should_pass` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-attributes_with_a_string_value_should_pass` | pass | pass | pass | pass |
    | `attribute/pass-attributes_with_a_zero_duration_should_pass` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-attributes_with_a_zero_number_have_meaning_and_should_pass` | pass | pass | pass | pass |
    | `attribute/pass-booleans_must_be_specified_as_lowercase_strings_3_3` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-dates_are_treated_as_strings_2_2` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-durations_are_treated_as_strings_1_2` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-globalids_are_treated_as_strings_and_not_expanded` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-integers_follow_the_same_rules_as_numbers` | pass | pass | pass | pass |
    | `attribute/pass-name_restrictions_will_match_any_result_1_3` | pass | pass | pass | pass |
    | `attribute/pass-name_restrictions_will_match_any_result_2_3` | pass | pass | pass | pass |
    | `attribute/pass-name_restrictions_will_match_any_result_3_3` | pass | pass | pass | pass |
    | `attribute/pass-non_ascii_characters_are_treated_without_encoding` | pass | pass | pass | pass |
    | `attribute/pass-numeric_values_are_checked_using_type_casting_1_4` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-numeric_values_are_checked_using_type_casting_2_4` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-numeric_values_are_checked_using_type_casting_3_4` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-only_specifically_formatted_numbers_are_allowed_3_4` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-only_specifically_formatted_numbers_are_allowed_4_4` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-strict_numeric_checking_may_be_done_with_a_bounds_restriction` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-typecast_checking_may_also_occur_within_enumeration_restrictions` | pass | pass | pass | **fail** ✗ |
    | `attribute/pass-value_restrictions_may_be_used_1_3` | pass | pass | pass | pass |
    | `attribute/pass-value_restrictions_may_be_used_2_3` | pass | pass | pass | pass |
    | `classification/fail-a_classification_facet_with_no_data_matches_any_classification_1_2` | fail | fail | fail | **pass** ✗ |
    | `classification/fail-a_prohibited_classification_reference_returns_the_opposite_of_a_required_facet` | fail | fail | fail | **pass** ✗ |
    | `classification/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet` | fail | fail | fail | **pass** ✗ |
    | `classification/fail-a_required_classification_system_fails_if_no_match` | fail | fail | fail | **pass** ✗ |
    | `classification/fail-an_optional_classification_value_fails_if_no_match` | fail | fail | fail | **pass** ✗ |
    | `classification/fail-both_system_and_value_must_match__all__not_any__if_specified_2_2` | fail | fail | fail | **pass** ✗ |
    | `classification/fail-occurrences_override_the_type_classification_per_system_2_3` | fail | fail | fail | **pass** ✗ |
    | `classification/fail-restrictions_can_be_used_for_systems_1_2` | fail | fail | fail | **pass** ✗ |
    | `classification/fail-restrictions_can_be_used_for_values_3_3` | fail | fail | fail | **pass** ✗ |
    | `classification/fail-systems_should_match_exactly_2_5` | fail | fail | fail | **pass** ✗ |
    | `classification/pass-a_classification_facet_with_no_data_matches_any_classification_2_2` | pass | pass | pass | pass |
    | `classification/pass-a_required_facet_checks_all_parameters_as_normal` | pass | pass | pass | pass |
    | `classification/pass-an_optional_classification_value_passes_if_null` | pass | pass | pass | pass |
    | `classification/pass-an_optional_classification_value_passes_if_specified` | pass | pass | pass | pass |
    | `classification/pass-both_system_and_value_must_match__all__not_any__if_specified_1_2` | pass | pass | pass | pass |
    | `classification/pass-non_rooted_resources_that_have_external_classification_references_should_also_pass` | pass | pass | pass | pass |
    | `classification/pass-occurrences_override_the_type_classification_per_system_1_3` | pass | pass | pass | pass |
    | `classification/pass-occurrences_override_the_type_classification_per_system_3_3` | pass | pass | pass | pass |
    | `classification/pass-restrictions_can_be_used_for_systems_2_2` | pass | pass | pass | pass |
    | `classification/pass-restrictions_can_be_used_for_values_1_3` | pass | pass | pass | pass |
    | `classification/pass-restrictions_can_be_used_for_values_2_3` | pass | pass | pass | pass |
    | `classification/pass-systems_should_match_exactly_1_5` | pass | pass | pass | pass |
    | `classification/pass-systems_should_match_exactly_3_5` | pass | pass | pass | pass |
    | `classification/pass-systems_should_match_exactly_4_5` | pass | pass | pass | pass |
    | `classification/pass-systems_should_match_exactly_5_5` | pass | pass | pass | pass |
    | `classification/pass-values_match_subreferences_if_full_classifications_are_used__e_g__ef_25_10_should_match_ef_25_10_25__ef_25_10_30__etc_` | pass | pass | pass | pass |
    | `classification/pass-values_should_match_exactly_if_lightweight_classifications_are_used` | pass | pass | pass | pass |
    | `entity/fail-a_null_predefined_type_should_always_fail_a_specified_predefined_types` | fail | fail | fail | **error** ✗ |
    | `entity/fail-a_predefined_type_from_an_enumeration_must_be_uppercase` | fail | fail | fail | fail |
    | `entity/fail-an_entity_not_matching_a_specified_predefined_type_will_fail` | fail | fail | fail | fail |
    | `entity/fail-in_ifc2x3_a_user_defined_airterminal_predefined_type_resolves_via_the_type_mapping_table_2_2` | fail | fail | fail | fail |
    | `entity/fail-in_ifc2x3_an_airterminal_can_be_checked_by_name_via_the_type_mapping_table_2_2` | fail | fail | fail | fail |
    | `entity/fail-in_ifc2x3_an_airterminal_predefined_type_resolves_via_the_type_mapping_table_2_2` | fail | fail | fail | fail |
    | `entity/fail-in_ifc2x3_there_must_be_an_airterminal_per_the_type_mapping_table_2_2` | fail | fail | fail | fail |
    | `entity/fail-restrictions_can_be_specified_for_the_predefined_type_3_3` | fail | fail | fail | **pass** ✗ |
    | `entity/fail-user_defined_types_are_checked_case_sensitively` | fail | fail | fail | fail |
    | `entity/invalid-an_entity_not_matching_the_specified_class_should_fail` | invalid | invalid | invalid | n/a |
    | `entity/invalid-entities_can_be_specified_as_a_xsd_regex_pattern_1_2` | invalid | invalid | invalid | n/a |
    | `entity/invalid-entities_can_be_specified_as_an_enumeration_3_3` | invalid | invalid | invalid | n/a |
    | `entity/invalid-entities_must_be_specified_as_uppercase_strings` | invalid | invalid | invalid | n/a |
    | `entity/invalid-invalid_entities_always_fail` | invalid | invalid | invalid | n/a |
    | `entity/invalid-subclasses_are_not_considered_as_matching` | invalid | invalid | invalid | n/a |
    | `entity/pass-a_matching_entity_should_pass` | pass | pass | pass | pass |
    | `entity/pass-a_matching_predefined_type_should_pass` | pass | pass | pass | pass |
    | `entity/pass-a_predefined_type_may_specify_a_user_defined_element_type` | pass | pass | pass | pass |
    | `entity/pass-a_predefined_type_may_specify_a_user_defined_object_type` | pass | pass | pass | pass |
    | `entity/pass-a_predefined_type_may_specify_a_user_defined_process_type` | pass | pass | pass | pass |
    | `entity/pass-an_matching_entity_should_pass_regardless_of_predefined_type` | pass | pass | pass | pass |
    | `entity/pass-entities_can_be_specified_as_a_xsd_regex_pattern_2_2` | pass | pass | pass | pass |
    | `entity/pass-entities_can_be_specified_as_an_enumeration_1_3` | pass | pass | pass | pass |
    | `entity/pass-entities_can_be_specified_as_an_enumeration_2_3` | pass | pass | pass | pass |
    | `entity/pass-in_ifc2x3_a_user_defined_airterminal_predefined_type_resolves_via_the_type_mapping_table_1_2` | pass | pass | pass | **fail** ✗ |
    | `entity/pass-in_ifc2x3_an_airterminal_can_be_checked_by_name_via_the_type_mapping_table_1_2` | pass | pass | pass | **fail** ✗ |
    | `entity/pass-in_ifc2x3_an_airterminal_predefined_type_resolves_via_the_type_mapping_table_1_2` | pass | pass | pass | **fail** ✗ |
    | `entity/pass-in_ifc2x3_there_must_be_an_airterminal_per_the_type_mapping_table_1_2` | pass | pass | pass | **fail** ✗ |
    | `entity/pass-inherited_predefined_types_should_pass` | pass | pass | pass | **error** ✗ |
    | `entity/pass-overridden_predefined_types_should_pass` | pass | pass | pass | pass |
    | `entity/pass-restrictions_can_be_specified_for_the_predefined_type_1_3` | pass | pass | pass | pass |
    | `entity/pass-restrictions_can_be_specified_for_the_predefined_type_2_3` | pass | pass | pass | pass |
    | `entity/pass-userdefined_predefined_types_may_be_specified` | pass | pass | pass | pass |
    | `ids/fail-a_minimal_ids_can_check_a_minimal_ifc_1_2` | fail | fail | fail | fail |
    | `ids/fail-a_specification_passes_only_if_all_requirements_pass_1_2` | fail | fail | fail | fail |
    | `ids/fail-prohibited_specifications_fails_if_the_applicability_matches` | fail | fail | fail | fail |
    | `ids/fail-required_specifications_need_at_least_one_applicable_entity_2_2` | fail | fail | fail | fail |
    | `ids/invalid-prohibited_specifications_invalid_if_requirements_are_specified` | invalid | invalid | invalid | n/a |
    | `ids/pass-a_minimal_ids_can_check_a_minimal_ifc_2_2` | pass | pass | pass | pass |
    | `ids/pass-a_specification_passes_only_if_all_requirements_pass_2_2` | pass | pass | pass | pass |
    | `ids/pass-optional_specifications_may_still_pass_if_nothing_is_applicable` | pass | pass | pass | pass |
    | `ids/pass-prohibited_specifications_passes_if_the_applicability_does_not_matches` | pass | pass | pass | pass |
    | `ids/pass-required_specifications_need_at_least_one_applicable_entity_1_2` | pass | pass | pass | pass |
    | `ids/pass-specification_optionality_and_facet_optionality_can_be_combined` | pass | pass | pass | pass |
    | `ids/pass-specification_version_is_purely_metadata_and_does_not_impact_pass_or_fail_result` | pass | pass | pass | pass |
    | `material/fail-a_constituent_set_with_no_data_will_fail_a_value_check` | fail | fail | fail | **pass** ✗ |
    | `material/fail-a_material_list_with_no_data_will_fail_a_value_check` | fail | fail | fail | fail |
    | `material/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet` | fail | fail | fail | **pass** ✗ |
    | `material/fail-an_optional_material_fails_if_no_value_matches` | fail | fail | fail | **pass** ✗ |
    | `material/fail-elements_without_a_material_always_fail` | fail | fail | fail | fail |
    | `material/fail-material_with_no_data_will_fail_a_value_check` | fail | fail | fail | fail |
    | `material/pass-a_layer_set_name_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-a_material_category_may_pass_the_value_check` | pass | pass | pass | pass |
    | `material/pass-a_material_name_may_pass_the_value_check` | pass | pass | pass | pass |
    | `material/pass-a_required_facet_checks_all_parameters_as_normal` | pass | pass | pass | pass |
    | `material/pass-an_optional_material_passes_if_null` | pass | pass | pass | **fail** ✗ |
    | `material/pass-an_optional_material_passes_if_specified` | pass | pass | pass | pass |
    | `material/pass-any_constituent_category_in_a_constituent_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_constituent_name_in_a_constituent_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_layer_category_in_a_layer_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_layer_name_in_a_layer_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_material_category_in_a_constituent_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_material_category_in_a_layer_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_material_category_in_a_list_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_material_category_in_a_profile_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_material_name_in_a_constituent_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_material_name_in_a_layer_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_material_name_in_a_list_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_material_name_in_a_profile_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_profile_category_in_a_profile_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-any_profile_name_in_a_profile_set_will_pass_a_value_check` | pass | pass | pass | pass |
    | `material/pass-elements_with_any_material_will_pass_an_empty_material_facet` | pass | pass | pass | pass |
    | `material/pass-occurrences_can_inherit_materials_from_their_types` | pass | pass | pass | **fail** ✗ |
    | `material/pass-occurrences_can_override_materials_from_their_types` | pass | pass | pass | pass |
    | `partof/fail-a_group_entity_must_match_exactly_1_2` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-a_non_aggregated_element_fails_an_aggregate_relationship` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-a_non_grouped_element_fails_a_group_relationship` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-an_aggregate_may_specify_the_entity_of_the_whole_2_2` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-an_aggregate_may_specify_the_predefined_type_of_the_whole_2_2` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-any_contained_element_passes_a_containment_relationship_1_2` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-any_nested_whole_fails_a_nest_relationship` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-the_aggregated_whole_fails_an_aggregate_relationship` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-the_container_entity_must_match_exactly_1_2` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-the_container_itself_always_fails` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-the_container_must_be_related_using_specified_relation_2_2` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-the_container_predefined_type_must_match_exactly_1_2` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-the_containment_can_be_indirect_2_2` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-the_nest_entity_must_match_exactly_1_2` | fail | fail | fail | **pass** ✗ |
    | `partof/fail-the_nest_predefined_type_must_match_exactly_1_2` | fail | fail | fail | **pass** ✗ |
    | `partof/invalid-a_group_predefined_type_must_match_exactly_1_2` | invalid | invalid | invalid | n/a |
    | `partof/pass-a_group_entity_must_match_exactly_2_2` | pass | pass | pass | pass |
    | `partof/pass-a_group_predefined_type_must_match_exactly_2_2` | pass | pass | pass | pass |
    | `partof/pass-a_grouped_element_passes_a_group_relationship` | pass | pass | pass | pass |
    | `partof/pass-a_required_facet_checks_all_parameters_as_normal` | pass | pass | pass | pass |
    | `partof/pass-an_aggregate_entity_may_pass_any_ancestral_whole_passes` | pass | pass | pass | pass |
    | `partof/pass-an_aggregate_may_specify_the_entity_of_the_whole_1_2` | pass | pass | pass | pass |
    | `partof/pass-an_aggregate_may_specify_the_predefined_type_of_the_whole_1_2` | pass | pass | pass | pass |
    | `partof/pass-any_contained_element_passes_a_containment_relationship_2_2` | pass | pass | pass | pass |
    | `partof/pass-any_nested_part_passes_a_nest_relationship` | pass | pass | pass | pass |
    | `partof/pass-nesting_may_be_indirect` | pass | pass | pass | pass |
    | `partof/pass-the_aggregated_part_passes_an_aggregate_relationship` | pass | pass | pass | pass |
    | `partof/pass-the_container_entity_must_match_exactly_2_2` | pass | pass | pass | pass |
    | `partof/pass-the_container_must_be_related_using_specified_relation_1_2` | pass | pass | pass | pass |
    | `partof/pass-the_container_predefined_type_must_match_exactly_2_2` | pass | pass | pass | pass |
    | `partof/pass-the_containment_can_be_indirect_1_2` | pass | pass | pass | pass |
    | `partof/pass-the_nest_entity_must_match_exactly_2_2` | pass | pass | pass | pass |
    | `partof/pass-the_nest_predefined_type_must_match_exactly_2_2` | pass | pass | pass | pass |
    | `property/fail-a_logical_unknown_is_considered_false_and_will_not_pass` | fail | fail | fail | **pass** ✗ |
    | `property/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet` | fail | fail | fail | fail |
    | `property/fail-all_matching_properties_must_satisfy_requirements_3_3` | fail | fail | fail | fail |
    | `property/fail-all_matching_property_sets_must_satisfy_requirements_2_3` | fail | fail | fail | fail |
    | `property/fail-an_empty_string_is_considered_false_and_will_not_pass` | fail | fail | fail | fail |
    | `property/fail-any_matching_value_in_a_bounded_property_will_pass_4_4` | fail | fail | fail | **error** ✗ |
    | `property/fail-any_matching_value_in_a_list_property_will_pass_3_3` | fail | fail | fail | **error** ✗ |
    | `property/fail-any_matching_value_in_a_table_property_will_pass_3_3` | fail | fail | fail | **error** ✗ |
    | `property/fail-booleans_must_be_specified_as_lowercase_strings_1_3` | fail | fail | fail | fail |
    | `property/fail-complex_properties_are_not_supported_1_2` | fail | fail | fail | **error** ✗ |
    | `property/fail-complex_properties_are_not_supported_2_2` | fail | fail | fail | fail |
    | `property/fail-dates_are_treated_as_strings_2_2` | fail | fail | fail | fail |
    | `property/fail-durations_are_treated_as_strings_1_2` | fail | fail | fail | fail |
    | `property/fail-elements_with_a_matching_pset_but_no_property_also_fail` | fail | fail | fail | fail |
    | `property/fail-elements_with_no_properties_always_fail` | fail | fail | fail | fail |
    | `property/fail-ids_does_not_handle_string_truncation_such_as_for_identifiers` | fail | fail | fail | fail |
    | `property/fail-if_multiple_properties_are_matched__all_values_must_satisfy_requirements_2_2` | fail | fail | fail | fail |
    | `property/fail-material_properties_that_are_absent_fail_under_ifc2x3` | fail | fail | fail | fail |
    | `property/fail-material_properties_that_are_absent_fail_under_ifc4` | fail | fail | fail | fail |
    | `property/fail-measures_are_used_to_specify_an_ifc_data_type_1_2` | fail | fail | fail | fail |
    | `property/fail-no_matching_value_in_an_enumerated_property_will_fail_3_3` | fail | fail | fail | **error** ✗ |
    | `property/fail-predefined_properties_are_supported_but_discouraged_2_2` | fail | fail | fail | **error** ✗ |
    | `property/fail-project_properties_that_are_absent_fail_under_ifc2x3_via_ifcobject` | fail | fail | fail | fail |
    | `property/fail-project_properties_that_are_absent_fail_under_ifc4_via_ifccontext` | fail | fail | fail | fail |
    | `property/fail-properties_can_be_associated_to_relevant_object_types` | fail | fail | fail | fail |
    | `property/fail-properties_can_be_overriden_by_an_occurrence_2_2` | fail | fail | fail | fail |
    | `property/fail-properties_with_a_null_value_fail` | fail | fail | fail | fail |
    | `property/fail-quantities_must_also_match_the_appropriate_measure` | fail | fail | fail | fail |
    | `property/fail-reference_properties_are_treated_as_objects_and_not_supported` | fail | fail | fail | **error** ✗ |
    | `property/fail-specifying_a_value_fails_against_different_values` | fail | fail | fail | fail |
    | `property/fail-specifying_a_value_performs_a_case_sensitive_match_2_2` | fail | fail | fail | fail |
    | `property/fail-unit_conversions_shall_take_place_to_ids_nominated_standard_units_1_2` | fail | fail | fail | **pass** ✗ |
    | `property/invalid-booleans_must_be_specified_as_lowercase_strings_3_3` | invalid | invalid | invalid | n/a |
    | `property/invalid-integer_values_are_checked_using_type_casting_4_4` | invalid | invalid | invalid | n/a |
    | `property/invalid-integer_values_cannot_be_stored_with_decimal_2_4` | invalid | invalid | invalid | n/a |
    | `property/invalid-integer_values_cannot_be_stored_with_decimal_3_4` | invalid | invalid | invalid | n/a |
    | `property/invalid-only_specifically_formatted_numbers_are_allowed_1_4` | invalid | invalid | invalid | n/a |
    | `property/invalid-only_specifically_formatted_numbers_are_allowed_2_4` | invalid | invalid | invalid | n/a |
    | `property/pass-a_name_check_will_match_any_property_with_any_string_value` | pass | pass | pass | pass |
    | `property/pass-a_name_check_will_match_any_quantity_with_any_value` | pass | pass | pass | pass |
    | `property/pass-a_number_specified_as_a_string_is_treated_as_a_string` | pass | pass | pass | pass |
    | `property/pass-a_property_set_to_false_is_still_considered_a_value_and_will_pass_a_name_check` | pass | pass | pass | pass |
    | `property/pass-a_property_set_to_true_will_pass_a_name_check` | pass | pass | pass | pass |
    | `property/pass-a_required_facet_checks_all_parameters_as_normal` | pass | pass | pass | pass |
    | `property/pass-a_zero_duration_will_pass` | pass | pass | pass | pass |
    | `property/pass-all_matching_properties_must_satisfy_requirements_1_3` | pass | pass | pass | pass |
    | `property/pass-all_matching_properties_must_satisfy_requirements_2_3` | pass | pass | pass | pass |
    | `property/pass-all_matching_property_sets_must_satisfy_requirements_1_3` | pass | pass | pass | pass |
    | `property/pass-all_matching_property_sets_must_satisfy_requirements_3_3` | pass | pass | pass | pass |
    | `property/pass-an_optional_facet_always_passes_regardless_of_outcome_1_2` | pass | pass | pass | pass |
    | `property/pass-an_optional_facet_always_passes_regardless_of_outcome_2_2` | pass | pass | pass | pass |
    | `property/pass-any_matching_value_in_a_bounded_property_will_pass_1_4` | pass | pass | pass | **error** ✗ |
    | `property/pass-any_matching_value_in_a_bounded_property_will_pass_2_4` | pass | pass | pass | **error** ✗ |
    | `property/pass-any_matching_value_in_a_bounded_property_will_pass_3_4` | pass | pass | pass | **error** ✗ |
    | `property/pass-any_matching_value_in_a_list_property_will_pass_1_3` | pass | pass | pass | **error** ✗ |
    | `property/pass-any_matching_value_in_a_list_property_will_pass_2_3` | pass | pass | pass | **error** ✗ |
    | `property/pass-any_matching_value_in_a_table_property_will_pass_1_3` | pass | pass | pass | **error** ✗ |
    | `property/pass-any_matching_value_in_a_table_property_will_pass_2_3` | pass | pass | pass | **error** ✗ |
    | `property/pass-any_matching_value_in_an_enumerated_property_will_pass_1_3` | pass | pass | pass | **error** ✗ |
    | `property/pass-any_matching_value_in_an_enumerated_property_will_pass_2_3` | pass | pass | pass | **error** ✗ |
    | `property/pass-booleans_must_be_specified_as_lowercase_strings_2_3` | pass | pass | pass | pass |
    | `property/pass-dates_are_treated_as_strings_1_2` | pass | pass | pass | pass |
    | `property/pass-durations_are_treated_as_strings_2_2` | pass | pass | pass | pass |
    | `property/pass-if_multiple_properties_are_matched__all_values_must_satisfy_requirements_1_2` | pass | pass | pass | pass |
    | `property/pass-integer_values_are_checked_using_type_casting_1_4` | pass | pass | pass | pass |
    | `property/pass-material_properties_are_supported_under_ifc2x3_via_extendedmaterialproperties` | pass | pass | pass | **fail** ✗ |
    | `property/pass-material_properties_are_supported_under_ifc4_via_ifcmaterialproperties` | pass | pass | pass | **fail** ✗ |
    | `property/pass-measures_are_used_to_specify_an_ifc_data_type_2_2` | pass | pass | pass | pass |
    | `property/pass-non_ascii_characters_are_treated_without_encoding` | pass | pass | pass | pass |
    | `property/pass-only_specifically_formatted_numbers_are_allowed_3_4` | pass | pass | pass | pass |
    | `property/pass-only_specifically_formatted_numbers_are_allowed_4_4` | pass | pass | pass | pass |
    | `property/pass-predefined_properties_are_supported_but_discouraged_1_2` | pass | pass | pass | **error** ✗ |
    | `property/pass-project_properties_are_supported_under_ifc2x3_via_ifcobject` | pass | pass | pass | pass |
    | `property/pass-project_properties_are_supported_under_ifc4_via_ifccontext` | pass | pass | pass | pass |
    | `property/pass-properties_can_be_inherited_from_the_type_1_2` | pass | pass | pass | **error** ✗ |
    | `property/pass-properties_can_be_inherited_from_the_type_2_2` | pass | pass | pass | **fail** ✗ |
    | `property/pass-properties_can_be_overriden_by_an_occurrence_1_2` | pass | pass | pass | **error** ✗ |
    | `property/pass-real_values_are_checked_using_type_casting_1_3` | pass | pass | pass | pass |
    | `property/pass-real_values_are_checked_using_type_casting_2_3` | pass | pass | pass | pass |
    | `property/pass-real_values_are_checked_using_type_casting_3_3` | pass | pass | pass | pass |
    | `property/pass-specifying_a_value_performs_a_case_sensitive_match_1_2` | pass | pass | pass | pass |
    | `property/pass-unit_conversions_shall_take_place_to_ids_nominated_standard_units_2_2` | pass | pass | pass | **fail** ✗ |
    | `restriction/fail-a_bound_can_be_exclusive_1_3` | fail | fail | fail | fail |
    | `restriction/fail-a_bound_can_be_exclusive_3_3` | fail | fail | fail | fail |
    | `restriction/fail-a_bound_can_be_inclusive_4_4` | fail | fail | fail | fail |
    | `restriction/fail-an_enumeration_matches_case_sensitively_3_3` | fail | fail | fail | fail |
    | `restriction/fail-an_enumeration_matches_case_sensitively_4_3` | fail | fail | fail | fail |
    | `restriction/fail-length_checks_can_be_used_1_2` | fail | fail | fail | fail |
    | `restriction/fail-max_and_min_length_checks_can_be_used_1_3` | fail | fail | fail | **pass** ✗ |
    | `restriction/fail-max_and_min_length_checks_can_be_used_4_3` | fail | fail | fail | fail |
    | `restriction/fail-regex_patterns_can_be_used_3_3` | fail | fail | fail | fail |
    | `restriction/fail-regex_patterns_work_in_OR_3_3` | fail | fail | fail | **pass** ✗ |
    | `restriction/invalid-patterns_always_fail_on_any_number` | invalid | invalid | invalid | n/a |
    | `restriction/invalid-patterns_only_work_on_strings_and_nothing_else` | invalid | invalid | invalid | n/a |
    | `restriction/pass-a_bound_can_be_exclusive_2_3` | pass | pass | pass | **fail** ✗ |
    | `restriction/pass-a_bound_can_be_inclusive_1_4` | pass | pass | pass | **fail** ✗ |
    | `restriction/pass-a_bound_can_be_inclusive_2_4` | pass | pass | pass | **fail** ✗ |
    | `restriction/pass-a_bound_can_be_inclusive_3_4` | pass | pass | pass | **fail** ✗ |
    | `restriction/pass-an_enumeration_matches_case_sensitively_1_3` | pass | pass | pass | pass |
    | `restriction/pass-an_enumeration_matches_case_sensitively_2_3` | pass | pass | pass | pass |
    | `restriction/pass-length_checks_can_be_used_2_2` | pass | pass | pass | pass |
    | `restriction/pass-max_and_min_length_checks_can_be_used_2_3` | pass | pass | pass | pass |
    | `restriction/pass-max_and_min_length_checks_can_be_used_3_3` | pass | pass | pass | pass |
    | `restriction/pass-regex_patterns_can_be_used_1_3` | pass | pass | pass | pass |
    | `restriction/pass-regex_patterns_can_be_used_2_3` | pass | pass | pass | pass |
    | `restriction/pass-regex_patterns_work_in_OR_1_3` | pass | pass | pass | pass |
    | `restriction/pass-regex_patterns_work_in_OR_2_3` | pass | pass | pass | pass |
    | `tolerance/fail-comparison_tolerance_for_floating_point_negative_high_number_lower_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_negative_high_number_upper_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_negative_low_number_lower_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_negative_low_number_upper_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_negative_one_lower_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_negative_one_upper_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_one_lower_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_one_upper_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_positive_high_number_lower_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_positive_high_number_upper_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_positive_low_number_lower_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_positive_low_number_upper_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_range_greater_than_zero_exclusive` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_range_greater_than_zero_inclusive` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_range_lower_than_zero_exclusive` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_range_lower_than_zero_inclusive` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_zero_lower_bound` | fail | fail | fail | fail |
    | `tolerance/fail-comparison_tolerance_for_floating_point_zero_upper_bound` | fail | fail | fail | fail |
    | `tolerance/pass-comparison_tolerance_for_floating_point_negative_high_number_lower_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_negative_high_number_upper_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_negative_low_number_lower_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_negative_low_number_upper_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_negative_one_lower_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_negative_one_upper_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_one_lower_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_one_upper_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_positive_high_number_lower_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_positive_high_number_upper_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_positive_low_number_lower_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_positive_low_number_upper_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_range_greater_than_zero_exclusive` | pass | pass | pass | pass |
    | `tolerance/pass-comparison_tolerance_for_floating_point_range_greater_than_zero_inclusive` | pass | pass | pass | pass |
    | `tolerance/pass-comparison_tolerance_for_floating_point_range_lower_than_zero_exclusive` | pass | pass | pass | pass |
    | `tolerance/pass-comparison_tolerance_for_floating_point_range_lower_than_zero_inclusive` | pass | pass | pass | pass |
    | `tolerance/pass-comparison_tolerance_for_floating_point_zero_lower_bound` | pass | pass | pass | **fail** ✗ |
    | `tolerance/pass-comparison_tolerance_for_floating_point_zero_upper_bound` | pass | pass | pass | **fail** ✗ |
<!-- END GENERATED: ids-conformance -->
