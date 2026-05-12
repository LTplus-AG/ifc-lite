# Documentation test cases

This document supports the automatic generation of testcases.

All valid IDS implementations must demonstrate identical behaviour against the expected values of the provided test cases.

They are designed to describe the expected behaviour of IFC verification, and should cover all standard and edge cases to remove  ambiguity from the expected implementation.

Test cases are arranged in folders by theme (e.g. attribute, entity, etc) and organised in 3 groups (i.e. pass, fail, and invalid), depending on the outcome of verification of the matching IFC/IDS couple.

| file name prefix | description                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| pass-            | all requirements are satisfied                                                                                                            |
| fail-            | at least one requirement fails                                                                                                            |
| invalid-         | at least one requirement fails (invalid files do not comply with the Audit tool, they could not be satisfied, regardless of IFC contents) |

IDS files are generated from the data of this script executing the `CreateTestCases` target in the repository.

IFC files have been imported from the work previously done in the [IfcOpenShell repository](https://blenderbim.org/docs-python/ifctester.html), and adepted where appropriate.

## attribute

### A prohibited facet returns the opposite of a required facet

``` ids attribute/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet.ids
A prohibited facet returns the opposite of a required facet
IFC2X3 IFC4 IFC4X3_ADD2
Entity: ''IFCWALL''
Requirements:
Attribute: Prohibited,''Name''
```

### A required facet checks all parameters as normal

``` ids attribute/pass-a_required_facet_checks_all_parameters_as_normal.ids
A required facet checks all parameters as normal
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name''
```

### An optional attribute passes if specified

``` ids attribute/pass-an_optional_attribute_passes_if_specified.ids
An optional attribute passes if specified
Entity: ''IFCWALL''
Requirements:
Attribute: Optional,''Name'', ''Foobar''
```

### An optional attribute passes if null

``` ids attribute/pass-an_optional_attribute_passes_if_null.ids
An optional attribute passes if null
Entity: ''IFCWALL''
Requirements:
Attribute: Optional,''Name'', ''Foobar''
```

### An optional attribute fails if empty

``` ids attribute/fail-an_optional_attribute_fails_if_empty.ids
An optional attribute fails if empty
Entity: ''IFCWALL''
Requirements:
Attribute: Optional,''Name'', ''Foobar''
```

### Attributes are not inherited by the occurrence

``` ids attribute/fail-attributes_are_not_inherited_by_the_occurrence.ids
Attributes are not inherited by the occurrence
Entity: ''IFCWALL''
Requirements:
Attribute: ''Description'',''Foobar''
```

### Attributes referencing an object should pass

``` ids attribute/pass-attributes_referencing_an_object_should_pass.ids
Attributes referencing an object should pass
IFC4
Entity: ''IFCTASK''
Requirements:
Attribute: ''TaskTime''
```

### Attributes should check strings case sensitively 1/2

``` ids attribute/pass-attributes_should_check_strings_case_sensitively_1_2.ids
Attributes should check strings case sensitively 1/2
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Foobar''
```

### Attributes should check strings case sensitively 2/2

``` ids attribute/fail-attributes_should_check_strings_case_sensitively_2_2.ids
Attributes should check strings case sensitively 2/2
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Foobar''
```

### Attributes with a boolean false should pass

``` ids attribute/pass-attributes_with_a_boolean_false_should_pass.ids
Attributes with a boolean false should pass
IFC4
Entity: ''IFCTASKTIME''
Requirements:
Attribute: ''IsCritical''
```

### Attributes with a boolean true should pass

``` ids attribute/pass-attributes_with_a_boolean_true_should_pass.ids
Attributes with a boolean true should pass
IFC4
Entity: ''IFCTASKTIME''
Requirements:
Attribute: ''IsCritical''
```

### Attributes with a logical unknown always fail

``` ids attribute/fail-attributes_with_a_logical_unknown_always_fail.ids
Attributes with a logical unknown always fail
Entity: ''IFCPRESENTATIONLAYERWITHSTYLE''
Requirements:
Attribute: ''LayerOn''
```

### Attributes with a select referencing a primitive should pass

``` ids attribute/pass-attributes_with_a_select_referencing_a_primitive_should_pass.ids
Attributes with a select referencing a primitive should pass
Entity: ''IFCSURFACESTYLERENDERING''
Requirements:
Attribute: ''DiffuseColour''
```

### Attributes with a select referencing an object should pass

``` ids attribute/pass-attributes_with_a_select_referencing_an_object_should_pass.ids
Attributes with a select referencing an object should pass
Entity: ''IFCSURFACESTYLERENDERING''
Requirements:
Attribute: ''DiffuseColour''
```

### Attributes with a string value should pass

``` ids attribute/pass-attributes_with_a_string_value_should_pass.ids
Attributes with a string value should pass
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name''
```

### Attributes with a zero duration should pass

``` ids attribute/pass-attributes_with_a_zero_duration_should_pass.ids
Attributes with a zero duration should pass
IFC4
Entity: ''IFCTASKTIME''
Requirements:
Attribute: ''ScheduleDuration''
```

### Attributes with a zero number have meaning and should pass

``` ids attribute/pass-attributes_with_a_zero_number_have_meaning_and_should_pass.ids
Attributes with a zero number have meaning and should pass
Entity: ''IFCQUANTITYCOUNT''
Requirements:
Attribute: ''CountValue''
```

### Attributes with an empty list always fail

``` ids attribute/fail-attributes_with_an_empty_list_always_fail.ids
Attributes with an empty list always fail
Entity: ''IFCRELCONNECTSPATHELEMENTS''
Requirements:
Attribute: ''RelatingPriorities''
```

### Attributes with an empty set always fail

``` ids attribute/fail-attributes_with_an_empty_set_always_fail.ids
Attributes with an empty set always fail
Entity: ''IFCPRESENTATIONLAYERWITHSTYLE''
Requirements:
Attribute: ''LayerStyles''
```

### Attributes with empty strings always fail

``` ids attribute/fail-attributes_with_empty_strings_always_fail.ids
Attributes with empty strings always fail
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name''
```

### Attributes with null values always fail

``` ids attribute/fail-attributes_with_null_values_always_fail.ids
Attributes with null values always fail
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name''
```

### Booleans must be specified as lowercase strings 1/3

``` ids attribute/fail-booleans_must_be_specified_as_lowercase_strings_1_3.ids
Booleans must be specified as lowercase strings 1/3
Entity: ''IFCTASK''
Requirements:
Attribute: ''IsMilestone'',''true''
```

### Booleans must be specified as lowercase strings 2/3

``` ids attribute/invalid-booleans_must_be_specified_as_lowercase_strings_2_3.ids
Booleans must be specified as lowercase strings 2/3
Entity: ''IFCTASK''
Requirements:
Attribute: ''IsMilestone'',''FALSE''
```

### Booleans must be specified as lowercase strings 3/3

``` ids attribute/pass-booleans_must_be_specified_as_lowercase_strings_3_3.ids
Booleans must be specified as lowercase strings 3/3
Entity: ''IFCTASK''
Requirements:
Attribute: ''IsMilestone'',''false''
```

### Dates are treated as strings 1/2

``` ids attribute/fail-dates_are_treated_as_strings_1_2.ids
Dates are treated as strings 1/2
IFC4
Entity: ''IFCCLASSIFICATION''
Requirements:
Attribute: ''EditionDate'',''2022-01-01''
```

### Dates are treated as strings 2/2

``` ids attribute/pass-dates_are_treated_as_strings_2_2.ids
Dates are treated as strings 2/2
IFC4
Entity: ''IFCCLASSIFICATION''
Requirements:
Attribute: ''EditionDate'',''2022-01-01''
```

### Derived attributes cannot be checked and always fail

``` ids attribute/invalid-derived_attributes_cannot_be_checked_and_always_fail.ids
Derived attributes cannot be checked and always fail
Entity: ''IFCCARTESIANPOINT''
Requirements:
Attribute: ''Dim''
```

### Durations are treated as strings 1/2

``` ids attribute/pass-durations_are_treated_as_strings_1_2.ids
Durations are treated as strings 1/2
IFC4
Entity: ''IFCTASKTIME''
Requirements:
Attribute: ''ScheduleDuration'',''PT16H''
```

### Durations are treated as strings 2/2

``` ids attribute/fail-durations_are_treated_as_strings_2_2.ids
Durations are treated as strings 2/2
IFC4
Entity: ''IFCTASKTIME''
Requirements:
Attribute: ''ScheduleDuration'',''PT16H''
```

### GlobalIds are treated as strings and not expanded

``` ids attribute/pass-globalids_are_treated_as_strings_and_not_expanded.ids
GlobalIds are treated as strings and not expanded
Entity: ''IFCWALL''
Requirements:
Attribute: ''GlobalId'',''1hqIFTRjfV6AWq_bMtnZwI''
```

### IDS does not handle string truncation such as for identifiers

``` ids attribute/fail-ids_does_not_handle_string_truncation_such_as_for_identifiers.ids
IDS does not handle string truncation such as for identifiers
IFC4
Entity: ''IFCPERSON''
Requirements:
Attribute: ''Identification'',''123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345_extra_characters''
```

### Integers follow the same rules as numbers

``` ids attribute/pass-integers_follow_the_same_rules_as_numbers.ids
Integers follow the same rules as numbers
IFC4
Entity: ''IFCSTAIRFLIGHT''
Requirements:
Attribute: ''NumberOfRisers'',''42''
```

### Integers cannot be expressed as floating point numbers 2/2

``` ids attribute/invalid-integers_cannot_be_expressed_as_floating_point_numbers_2_2.ids
Integers cannot be expressed as floating point numbers 2/2
IFC4
Entity: ''IFCSTAIRFLIGHT''
Requirements:
Attribute: ''NumberOfRisers'',''42.0''
```

### Invalid attribute names always fail

Entities of type IFCWALL do not have the ActingRole attribute.

``` ids attribute/invalid-invalid_attribute_names_always_fail.ids
Invalid attribute names always fail
Entity: ''IFCWALL''
Requirements:
Attribute: ''ActingRole''
```

### Inverse attributes cannot be checked and always fail

``` ids attribute/invalid-inverse_attributes_cannot_be_checked_and_always_fail.ids
Inverse attributes cannot be checked and always fail
Entity: ''IFCPERSON''
Requirements:
Attribute: ''EngagedIn''
```

### Name restrictions will match any result 1/3

``` ids attribute/pass-name_restrictions_will_match_any_result_1_3.ids
Name restrictions will match any result 1/3
Entity: ''IFCMATERIALLAYERSET''
Requirements:
Attribute: Pattern(''.*Name.*'')
```

### Name restrictions will match any result 2/3

``` ids attribute/pass-name_restrictions_will_match_any_result_2_3.ids
Name restrictions will match any result 2/3
Entity: ''IFCWALL''
Requirements:
Attribute: Enumeration(''Name'',''Description'')
```

### Name restrictions will match any result 3/3

``` ids attribute/pass-name_restrictions_will_match_any_result_3_3.ids
Name restrictions will match any result 3/3
Entity: ''IFCWALL''
Requirements:
Attribute: Enumeration(''Name'',''Description'')
```

### Non-ascii characters are treated without encoding

``` ids attribute/pass-non_ascii_characters_are_treated_without_encoding.ids
Non-ascii characters are treated without encoding
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''♫Don'tÄrgerhôtelЊет''
```

### Numeric values are checked using type casting 1/4

``` ids attribute/pass-numeric_values_are_checked_using_type_casting_1_4.ids
Numeric values are checked using type casting 1/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',''42''
```

### Numeric values are checked using type casting 2/4

``` ids attribute/pass-numeric_values_are_checked_using_type_casting_2_4.ids
Numeric values are checked using type casting 2/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',''42.''
```

### Numeric values are checked using type casting 3/4

``` ids attribute/pass-numeric_values_are_checked_using_type_casting_3_4.ids
Numeric values are checked using type casting 3/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',''42.0''
```

### Numeric values are checked using type casting 4/4

``` ids attribute/fail-numeric_values_are_checked_using_type_casting_4_4.ids
Numeric values are checked using type casting 4/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',''42''
```

### Only specifically formatted numbers are allowed 1/4

``` ids attribute/invalid-only_specifically_formatted_numbers_are_allowed_1_4.ids
Only specifically formatted numbers are allowed 1/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',''42,3''
```

### Only specifically formatted numbers are allowed 2/4

``` ids attribute/invalid-only_specifically_formatted_numbers_are_allowed_2_4.ids
Only specifically formatted numbers are allowed 2/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',''123,4.5''
```

### Only specifically formatted numbers are allowed 3/4

``` ids attribute/pass-only_specifically_formatted_numbers_are_allowed_3_4.ids
Only specifically formatted numbers are allowed 3/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',''1.2345e3''
```

### Only specifically formatted numbers are allowed 4/4

``` ids attribute/pass-only_specifically_formatted_numbers_are_allowed_4_4.ids
Only specifically formatted numbers are allowed 4/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',''1.2345E3''
```

### Specifying a float when the value is an integer is invalid

Note that the attribute name `NumberOfRiser` has been renamed to `NumberOfRisers` in IFC4

``` ids attribute/invalid-specifying_a_float_when_the_value_is_an_integer_is_invalid.ids
Specifying a float when the value is an integer is invalid
IFC4
Entity: ''IFCSTAIRFLIGHT''
Requirements:
Attribute: Pattern(''NumberOfRiser(s)?''),''42.3''
```

### Strict numeric checking may be done with a bounds restriction

``` ids attribute/pass-strict_numeric_checking_may_be_done_with_a_bounds_restriction.ids
Strict numeric checking may be done with a bounds restriction
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',xs:double MinInclusive(''42'') MaxInclusive(''42'')
```

### Typecast checking may also occur within enumeration restrictions

The type defined in the enumeration needs to be compatible with the dataType.
For attribute facets, the dataType is taken from the IDS schema.

ROADMAP: inconsistent types should be captured by the Audit tool.

``` ids attribute/pass-typecast_checking_may_also_occur_within_enumeration_restrictions.ids
Typecast checking may also occur within enumeration restrictions
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',xs:double Enumeration(''42'',''43'')
```

### Value checks always fail for lists

``` ids attribute/invalid-value_checks_always_fail_for_lists.ids
Value checks always fail for lists
Entity: ''IFCCARTESIANPOINT''
Requirements:
Attribute: ''Coordinates'',''Foobar''
```

### Value checks always fail for objects

``` ids attribute/invalid-value_checks_always_fail_for_objects.ids
Value checks always fail for objects
IFC4
Entity: ''IFCTASK''
Requirements:
Attribute: ''TaskTime'',''Foobar''
```

### Value checks always fail for selects

``` ids attribute/invalid-value_checks_always_fail_for_selects.ids
Value checks always fail for selects
Entity: ''IFCSURFACESTYLERENDERING''
Requirements:
Attribute: ''DiffuseColour'',''Foobar''
```

### Value restrictions may be used 1/3

``` ids attribute/pass-value_restrictions_may_be_used_1_3.ids
Value restrictions may be used 1/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Enumeration(''Foo'',''Bar'')
```

### Value restrictions may be used 2/3

``` ids attribute/pass-value_restrictions_may_be_used_2_3.ids
Value restrictions may be used 2/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Enumeration(''Foo'',''Bar'')
```

### Value restrictions may be used 3/3

``` ids attribute/fail-value_restrictions_may_be_used_3_3.ids
Value restrictions may be used 3/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Enumeration(''Foo'',''Bar'')
```

## classification

### A classification facet with no data matches any classification 1/2

``` ids classification/fail-a_classification_facet_with_no_data_matches_any_classification_1_2.ids
A classification facet with no data matches any classification 1/2
Entity: ''IFCWALL''
Requirements:
Classification: Pattern(''\w+'')
```

### A classification facet with no data matches any classification 2/2

``` ids classification/pass-a_classification_facet_with_no_data_matches_any_classification_2_2.ids
A classification facet with no data matches any classification 2/2
Entity: ''IFCSLAB''
Requirements:
Classification: Pattern(''\w+'')
```

### A prohibited facet returns the opposite of a required facet

``` ids classification/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet.ids
A prohibited facet returns the opposite of a required facet
Entity: ''IFCSLAB''
Requirements:
Classification: Prohibited,Pattern(''\w+'')
```

### A prohibited classification reference returns the opposite of a required facet

``` ids classification/fail-a_prohibited_classification_reference_returns_the_opposite_of_a_required_facet.ids
A prohibited classification reference returns the opposite of a required facet
Entity: ''IFCSLAB''
Requirements:
Classification: Prohibited,''Foobar'',''1''
```

### A required facet checks all parameters as normal

``` ids classification/pass-a_required_facet_checks_all_parameters_as_normal.ids
A required facet checks all parameters as normal
Entity: ''IFCSLAB''
Requirements:
Classification: Pattern(''\w+'')
```

### A required classification system fails if no match

``` ids classification/fail-a_required_classification_system_fails_if_no_match.ids
A required classification system fails if no match
Entity: ''IFCSLAB''
Requirements:
Classification: ''Foobar1''
```

### An optional classification value passes if specified

``` ids classification/pass-an_optional_classification_value_passes_if_specified.ids
An optional classification value passes if specified
Entity: ''IFCWALL''
Requirements:
Classification: Optional,Pattern(''\w+''),''ExpectedValue''
```

### An optional classification value passes if null

``` ids classification/pass-an_optional_classification_value_passes_if_null.ids
An optional classification value passes if null
Entity: ''IFCWALL''
Requirements:
Classification: Optional,Pattern(''\w+''),''ExpectedValue''
```

### An optional classification value fails if no match

``` ids classification/fail-an_optional_classification_value_fails_if_no_match.ids
An optional classification value fails if no match
Entity: ''IFCWALL''
Requirements:
Classification: Optional,Pattern(''\w+''),''ExpectedValue''
```

### Both system and value must match (all, not any) if specified 1/2

``` ids classification/pass-both_system_and_value_must_match__all__not_any__if_specified_1_2.ids
Both system and value must match (all, not any) if specified 1/2
Entity: ''IFCSLAB''
Requirements:
Classification: ''Foobar'',''1''
```

### Both system and value must match (all, not any) if specified 2/2

``` ids classification/fail-both_system_and_value_must_match__all__not_any__if_specified_2_2.ids
Both system and value must match (all, not any) if specified 2/2
Entity: ''IFCCOLUMN''
Requirements:
Classification: ''Foobar'',''1''
```

### Non-rooted resources that have external classification references should also pass

Since ifc4, IFCEXTERNALREFERENCERELATIONSHIP can relate an IFCEXTERNALREFERENCE to any IFCRESOURCEOBJECTSELECT.

``` ids classification/pass-non_rooted_resources_that_have_external_classification_references_should_also_pass.ids
Non-rooted resources that have external classification references should also pass
IFC4
Entity: ''IFCMATERIAL''
Requirements:
Classification: Pattern(''\w+''),''1''
```

### Occurrences override the type classification per system 1/3

``` ids classification/pass-occurrences_override_the_type_classification_per_system_1_3.ids
Occurrences override the type classification per system 1/3
Entity: ''IFCWALL''
Requirements:
Classification: Pattern(''\w+''),''11''
```

### Occurrences override the type classification per system 2/3

``` ids classification/fail-occurrences_override_the_type_classification_per_system_2_3.ids
Occurrences override the type classification per system 2/3
Entity: ''IFCWALL''
Requirements:
Classification: Pattern(''\w+''),''22''
```

### Occurrences override the type classification per system 3/3

``` ids classification/pass-occurrences_override_the_type_classification_per_system_3_3.ids
Occurrences override the type classification per system 3/3
Entity: ''IFCWALL''
Requirements:
Classification: Pattern(''\w+''),''X''
```

### Restrictions can be used for systems 1/2

``` ids classification/fail-restrictions_can_be_used_for_systems_1_2.ids
Restrictions can be used for systems 1/2
Entity: ''IFCWALL''
Requirements:
Classification: Pattern(''Foo.*'')
```

### Restrictions can be used for systems 2/2

``` ids classification/pass-restrictions_can_be_used_for_systems_2_2.ids
Restrictions can be used for systems 2/2
Entity: ''IFCSLAB''
Requirements:
Classification: Pattern(''Foo.*'')
```

### Restrictions can be used for values 1/3

``` ids classification/pass-restrictions_can_be_used_for_values_1_3.ids
Restrictions can be used for values 1/3
Entity: ''IFCSLAB''
Requirements:
Classification: Pattern(''\w+''),Pattern(''1.*'')
```

### Restrictions can be used for values 2/3

``` ids classification/pass-restrictions_can_be_used_for_values_2_3.ids
Restrictions can be used for values 2/3
Entity: ''IFCCOLUMN''
Requirements:
Classification: Pattern(''\w+''),Pattern(''1.*'')
```

### Restrictions can be used for values 3/3

``` ids classification/fail-restrictions_can_be_used_for_values_3_3.ids
Restrictions can be used for values 3/3
Entity: ''IFCBEAM''
Requirements:
Classification: Pattern(''\w+''),Pattern(''1.*'')
```

### Systems should match exactly 1/5

``` ids classification/pass-systems_should_match_exactly_1_5.ids
Systems should match exactly 1/5
Entity: ''IFCPROJECT''
Requirements:
Classification: ''Foobar''
```

### Systems should match exactly 2/5

``` ids classification/fail-systems_should_match_exactly_2_5.ids
Systems should match exactly 2/5
Entity: ''IFCWALL''
Requirements:
Classification: ''Foobar''
```

### Systems should match exactly 3/5

``` ids classification/pass-systems_should_match_exactly_3_5.ids
Systems should match exactly 3/5
Entity: ''IFCSLAB''
Requirements:
Classification: ''Foobar''
```

### Systems should match exactly 4/5

``` ids classification/pass-systems_should_match_exactly_4_5.ids
Systems should match exactly 4/5
Entity: ''IFCCOLUMN''
Requirements:
Classification: ''Foobar''
```

### Systems should match exactly 5/5

``` ids classification/pass-systems_should_match_exactly_5_5.ids
Systems should match exactly 5/5
Entity: ''IFCBEAM''
Requirements:
Classification: ''Foobar''
```

### Values match subreferences if full classifications are used (e.g. EF_25_10 should match EF_25_10_25, EF_25_10_30, etc)

``` ids classification/pass-values_match_subreferences_if_full_classifications_are_used__e_g__ef_25_10_should_match_ef_25_10_25__ef_25_10_30__etc_.ids
Values match subreferences if full classifications are used (e.g. EF_25_10 should match EF_25_10_25, EF_25_10_30, etc)
Entity: ''IFCBEAM''
Requirements:
Classification: Pattern(''\w+''),''2''
```

### Values should match exactly if lightweight classifications are used

``` ids classification/pass-values_should_match_exactly_if_lightweight_classifications_are_used.ids
Values should match exactly if lightweight classifications are used
Entity: ''IFCSLAB''
Requirements:
Classification: Pattern(''\w+''),''1''
```

## entity

### A matching entity should pass

``` ids entity/pass-a_matching_entity_should_pass.ids
A matching entity should pass
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL''
```

### A matching predefined type should pass

``` ids entity/pass-a_matching_predefined_type_should_pass.ids
A matching predefined type should pass
IFC4
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL'',''SOLIDWALL''
```

### A null predefined type should always fail a specified predefined types

``` ids entity/fail-a_null_predefined_type_should_always_fail_a_specified_predefined_types.ids
A null predefined type should always fail a specified predefined types
IFC4
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL'',''SOLIDWALL''
```

### A predefined type from an enumeration must be uppercase

``` ids entity/fail-a_predefined_type_from_an_enumeration_must_be_uppercase.ids
A predefined type from an enumeration must be uppercase
IFC4
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL'',''solidwall''
```

### A predefined type may specify a user-defined element type

``` ids entity/pass-a_predefined_type_may_specify_a_user_defined_element_type.ids
A predefined type may specify a user-defined element type
Entity: ''IFCWALLTYPE''
Requirements:
Entity: ''IFCWALLTYPE'',''WALDO''
```

### Userdefined predefined types may be specified

``` ids entity/pass-userdefined_predefined_types_may_be_specified.ids
Userdefined predefined types may be specified
Entity: ''IFCWALLTYPE''
Requirements:
Entity: ''IFCWALLTYPE'',''USERDEFINED''
```

### A predefined type may specify a user-defined object type

This custom subType should be allowed, if custom is allowed in the enumeration.
IfcWall does not have predefinedType in 2X3, so the test case is constrained to IFC4

``` ids entity/pass-a_predefined_type_may_specify_a_user_defined_object_type.ids
A predefined type may specify a user-defined object type
IFC4
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL'',''WALDO''
```

### A predefined type may specify a user-defined process type

``` ids entity/pass-a_predefined_type_may_specify_a_user_defined_process_type.ids
A predefined type may specify a user-defined process type
IFC4
Entity: ''IFCTASKTYPE''
Requirements:
Entity: ''IFCTASKTYPE'',''TASKY''
```

### An entity not matching a specified predefined type will fail

``` ids entity/fail-an_entity_not_matching_a_specified_predefined_type_will_fail.ids
An entity not matching a specified predefined type will fail
IFC4
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL'',''SOLIDWALL''
```

### An entity not matching the specified class should fail

``` ids entity/invalid-an_entity_not_matching_the_specified_class_should_fail.ids
An entity not matching the specified class should fail
Entity: ''IFCSLAB''
Requirements:
Entity: ''IFCWALL''
```

### An matching entity should pass regardless of predefined type

``` ids entity/pass-an_matching_entity_should_pass_regardless_of_predefined_type.ids
An matching entity should pass regardless of predefined type
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL''
```

### Entities can be specified as a XSD regex pattern 1/2

``` ids entity/invalid-entities_can_be_specified_as_a_xsd_regex_pattern_1_2.ids
Entities can be specified as a XSD regex pattern 1/2
Entity: ''IFCWALL''
Requirements:
Entity: Pattern(''IFC.*TYPE'')
```

### Entities can be specified as a XSD regex pattern 2/2

``` ids entity/pass-entities_can_be_specified_as_a_xsd_regex_pattern_2_2.ids
Entities can be specified as a XSD regex pattern 2/2
Entity: ''IFCWALLTYPE''
Requirements:
Entity: Pattern(''IFC.*TYPE'')
```

### Entities can be specified as an enumeration 1/3

``` ids entity/pass-entities_can_be_specified_as_an_enumeration_1_3.ids
Entities can be specified as an enumeration 1/3
Entity: ''IFCWALL''
Requirements:
Entity: Enumeration(''IFCWALL'',''IFCSLAB'')
```

### Entities can be specified as an enumeration 2/3

``` ids entity/pass-entities_can_be_specified_as_an_enumeration_2_3.ids
Entities can be specified as an enumeration 2/3
Entity: ''IFCSLAB''
Requirements:
Entity: Enumeration(''IFCWALL'',''IFCSLAB'')
```

### Entities can be specified as an enumeration 3/3

``` ids entity/invalid-entities_can_be_specified_as_an_enumeration_3_3.ids
Entities can be specified as an enumeration 3/3
Entity: ''IFCBEAM''
Requirements:
Entity: Enumeration(''IFCWALL'',''IFCSLAB'')
```

### Entities must be specified as uppercase strings

``` ids entity/invalid-entities_must_be_specified_as_uppercase_strings.ids
Entities must be specified as uppercase strings
Entity: ''IFCWALL''
Requirements:
Entity: ''IfcWall''
```

### Inherited predefined types should pass

``` ids entity/pass-inherited_predefined_types_should_pass.ids
Inherited predefined types should pass
IFC4
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL'',''X''
```

### Invalid entities always fail

``` ids entity/invalid-invalid_entities_always_fail.ids
Invalid entities always fail
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCRABBIT''
```

### Overridden predefined types should pass

``` ids entity/pass-overridden_predefined_types_should_pass.ids
Overridden predefined types should pass
IFC4
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL'',''X''
```

### Restrictions can be specified for the predefined type 1/3

``` ids entity/pass-restrictions_can_be_specified_for_the_predefined_type_1_3.ids
Restrictions can be specified for the predefined type 1/3
IFC4
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL'',Pattern(''FOO.*'')
```

### Restrictions can be specified for the predefined type 2/3

``` ids entity/pass-restrictions_can_be_specified_for_the_predefined_type_2_3.ids
Restrictions can be specified for the predefined type 2/3
IFC4
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL'',Pattern(''FOO.*'')
```

### Restrictions can be specified for the predefined type 3/3

``` ids entity/fail-restrictions_can_be_specified_for_the_predefined_type_3_3.ids
Restrictions can be specified for the predefined type 3/3
IFC4
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL'',Pattern(''FOO.*'')
```

### Subclasses are not considered as matching

``` ids entity/invalid-subclasses_are_not_considered_as_matching.ids
Subclasses are not considered as matching
Entity: ''IFCWALLSTANDARDCASE''
Requirements:
Entity: ''IFCWALL''
```

### User-defined types are checked case sensitively

``` ids entity/fail-user_defined_types_are_checked_case_sensitively.ids
User-defined types are checked case sensitively
IFC4
Entity: ''IFCWALL''
Requirements:
Entity: ''IFCWALL'',''WALDO''
```

## ids

### A minimal ids can check a minimal ifc (1/2)

``` ids ids/fail-a_minimal_ids_can_check_a_minimal_ifc_1_2.ids
A minimal ids can check a minimal ifc (1/2)
IFC4
Optional
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Waldo''
```

### A minimal ids can check a minimal ifc (2/2)

``` ids ids/pass-a_minimal_ids_can_check_a_minimal_ifc_2_2.ids
A minimal ids can check a minimal ifc (2/2)
IFC4
Optional
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Waldo''
```

### A specification passes only if all requirements pass (1/2)

``` ids ids/fail-a_specification_passes_only_if_all_requirements_pass_1_2.ids
A specification passes only if all requirements pass (1/2)
Optional
IFC2X3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Waldo''
Attribute: ''Description'',''Foobar''
```

### A specification passes only if all requirements pass (2/2)

``` ids ids/pass-a_specification_passes_only_if_all_requirements_pass_2_2.ids
A specification passes only if all requirements pass (2/2)
Optional
IFC2X3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Waldo''
Attribute: ''Description'',''Foobar''
```

### Optional specifications may still pass if nothing is applicable

``` ids ids/pass-optional_specifications_may_still_pass_if_nothing_is_applicable.ids
Optional specifications may still pass if nothing is applicable
Optional
IFC2X3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Waldo''
```

### Prohibited specifications invalid if requirements are specified

``` ids ids/invalid-prohibited_specifications_invalid_if_requirements_are_specified.ids
Prohibited specifications invalid if requirements are specified
Prohibited
IFC2X3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Waldo''
```

### Prohibited specifications fails if the applicability matches

``` ids ids/fail-prohibited_specifications_fails_if_the_applicability_matches.ids
Prohibited specifications fails if the applicability matches
Prohibited
IFC2X3
Entity: ''IFCWALL''
```

### Prohibited specifications passes if the applicability does not matches

``` ids ids/pass-prohibited_specifications_passes_if_the_applicability_does_not_matches.ids
Prohibited specifications passes if the applicability does not matches
Prohibited
IFC2X3
Entity: ''IFCWINDOW''
```

### Required specifications need at least one applicable entity (1/2)

``` ids ids/pass-required_specifications_need_at_least_one_applicable_entity_1_2.ids
Required specifications need at least one applicable entity (1/2)
IFC2X3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Waldo''
```

### Required specifications need at least one applicable entity (2/2)

``` ids ids/fail-required_specifications_need_at_least_one_applicable_entity_2_2.ids
Required specifications need at least one applicable entity (2/2)
IFC2X3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Waldo''
```

### Specification optionality and facet optionality can be combined

``` ids ids/pass-specification_optionality_and_facet_optionality_can_be_combined.ids
Specification optionality and facet optionality can be combined
Optional
IFC2X3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Waldo''
Attribute: Optional,''Description'',''Foobar''
```

### Specification version is purely metadata and does not impact pass or fail result

``` ids ids/pass-specification_version_is_purely_metadata_and_does_not_impact_pass_or_fail_result.ids
Specification version is purely metadata and does not impact pass or fail result
Optional
IFC2X3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',''Waldo''
```

## material

### A constituent set with no data will fail a value check

``` ids material/fail-a_constituent_set_with_no_data_will_fail_a_value_check.ids
A constituent set with no data will fail a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### A material category may pass the value check

``` ids material/pass-a_material_category_may_pass_the_value_check.ids
A material category may pass the value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### A material list with no data will fail a value check

``` ids material/fail-a_material_list_with_no_data_will_fail_a_value_check.ids
A material list with no data will fail a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### A material name may pass the value check

``` ids material/pass-a_material_name_may_pass_the_value_check.ids
A material name may pass the value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### A prohibited facet returns the opposite of a required facet

``` ids material/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet.ids
A prohibited facet returns the opposite of a required facet
Entity: ''IFCWALL''
Requirements:
Material: Prohibited,
```

### A required facet checks all parameters as normal

``` ids material/pass-a_required_facet_checks_all_parameters_as_normal.ids
A required facet checks all parameters as normal
Entity: ''IFCWALL''
Requirements:
Material: 
```

### An optional material passes if specified

``` ids material/pass-an_optional_material_passes_if_specified.ids
An optional material passes if specified
Entity: ''IFCWALL''
Requirements:
Material: Optional,''Foo''
```

### An optional material passes if null

``` ids material/pass-an_optional_material_passes_if_null.ids
An optional material passes if null
Entity: ''IFCWALL''
Requirements:
Material: Optional,''Foo''
```

### An optional material fails if no value matches

``` ids material/fail-an_optional_material_fails_if_no_value_matches.ids
An optional material fails if no value matches
Entity: ''IFCWALL''
Requirements:
Material: Optional,''Foo''
```

### Any constituent Category in a constituent set will pass a value check

``` ids material/pass-any_constituent_category_in_a_constituent_set_will_pass_a_value_check.ids
Any constituent Category in a constituent set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any constituent Name in a constituent set will pass a value check

``` ids material/pass-any_constituent_name_in_a_constituent_set_will_pass_a_value_check.ids
Any constituent Name in a constituent set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any layer Category in a layer set will pass a value check

``` ids material/pass-any_layer_category_in_a_layer_set_will_pass_a_value_check.ids
Any layer Category in a layer set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any layer Name in a layer set will pass a value check

``` ids material/pass-any_layer_name_in_a_layer_set_will_pass_a_value_check.ids
Any layer Name in a layer set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any material Category in a constituent set will pass a value check

``` ids material/pass-any_material_category_in_a_constituent_set_will_pass_a_value_check.ids
Any material Category in a constituent set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any material Category in a layer set will pass a value check

``` ids material/pass-any_material_category_in_a_layer_set_will_pass_a_value_check.ids
Any material Category in a layer set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any material Category in a list will pass a value check

``` ids material/pass-any_material_category_in_a_list_will_pass_a_value_check.ids
Any material Category in a list will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any material category in a profile set will pass a value check

``` ids material/pass-any_material_category_in_a_profile_set_will_pass_a_value_check.ids
Any material category in a profile set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any material Name in a constituent set will pass a value check

``` ids material/pass-any_material_name_in_a_constituent_set_will_pass_a_value_check.ids
Any material Name in a constituent set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any material Name in a layer set will pass a value check

``` ids material/pass-any_material_name_in_a_layer_set_will_pass_a_value_check.ids
Any material Name in a layer set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any material Name in a list will pass a value check

``` ids material/pass-any_material_name_in_a_list_will_pass_a_value_check.ids
Any material Name in a list will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any material Name in a profile set will pass a value check

``` ids material/pass-any_material_name_in_a_profile_set_will_pass_a_value_check.ids
Any material Name in a profile set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any profile Category in a profile set will pass a value check

``` ids material/pass-any_profile_category_in_a_profile_set_will_pass_a_value_check.ids
Any profile Category in a profile set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Any profile Name in a profile set will pass a value check

``` ids material/pass-any_profile_name_in_a_profile_set_will_pass_a_value_check.ids
Any profile Name in a profile set will pass a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Elements with any material will pass an empty material facet

``` ids material/pass-elements_with_any_material_will_pass_an_empty_material_facet.ids
Elements with any material will pass an empty material facet
Entity: ''IFCWALL''
Requirements:
Material: 
```

### Elements without a material always fail

``` ids material/fail-elements_without_a_material_always_fail.ids
Elements without a material always fail
Entity: ''IFCWALL''
Requirements:
Material: 
```

### Material with no data will fail a value check

``` ids material/fail-material_with_no_data_will_fail_a_value_check.ids
Material with no data will fail a value check
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Occurrences can inherit materials from their types

``` ids material/pass-occurrences_can_inherit_materials_from_their_types.ids
Occurrences can inherit materials from their types
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### Occurrences can override materials from their types

``` ids material/pass-occurrences_can_override_materials_from_their_types.ids
Occurrences can override materials from their types
Entity: ''IFCWALL''
Requirements:
Material: ''Foo''
```

### A layer set name will pass the value check

``` ids material/pass-a_layer_set_name_will_pass_a_value_check.ids
A layer set name will pass the value check
Entity: ''IFCWALL''
Requirements:
Material: ''Bar''
```

## partof

### A group entity must match exactly 1/2

``` ids partof/fail-a_group_entity_must_match_exactly_1_2.ids
A group entity must match exactly 1/2
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: ''IFCGROUP'',IFCRELASSIGNSTOGROUP
```

### A group entity must match exactly 2/2

``` ids partof/pass-a_group_entity_must_match_exactly_2_2.ids
A group entity must match exactly 2/2
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: ''IFCINVENTORY'',IFCRELASSIGNSTOGROUP
```

### A group predefined type must match exactly 1/2

``` ids partof/invalid-a_group_predefined_type_must_match_exactly_1_2.ids
A group predefined type must match exactly 1/2
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: ''IFCINVENTORY'',''BUNNARY'',IFCRELASSIGNSTOGROUP
```

### A group predefined type must match exactly 2/2

``` ids partof/pass-a_group_predefined_type_must_match_exactly_2_2.ids
A group predefined type must match exactly 2/2
IFC4
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: ''IFCINVENTORY'',''BUNNY'',IFCRELASSIGNSTOGROUP
```

### A grouped element passes a group relationship

``` ids partof/pass-a_grouped_element_passes_a_group_relationship.ids
A grouped element passes a group relationship
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: Pattern(''.*''),IFCRELASSIGNSTOGROUP
```

### A non aggregated element fails an aggregate relationship

``` ids partof/fail-a_non_aggregated_element_fails_an_aggregate_relationship.ids
A non aggregated element fails an aggregate relationship
Entity: ''IFCWALL''
Requirements:
PartOf: Pattern(''.*''),IFCRELAGGREGATES
```

### A non grouped element fails a group relationship

``` ids partof/fail-a_non_grouped_element_fails_a_group_relationship.ids
A non grouped element fails a group relationship
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: Pattern(''.*''),IFCRELASSIGNSTOGROUP
```

### A prohibited facet returns the opposite of a required facet

``` ids partof/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet.ids
A prohibited facet returns the opposite of a required facet
Entity: ''IFCWALL''
Requirements:
PartOf: Prohibited,Pattern(''.*''),IFCRELAGGREGATES
```

### A required facet checks all parameters as normal

``` ids partof/pass-a_required_facet_checks_all_parameters_as_normal.ids
A required facet checks all parameters as normal
Entity: ''IFCWALL''
Requirements:
PartOf: Pattern(''.*''),IFCRELAGGREGATES
```

### An aggregate entity may pass any ancestral whole passes

``` ids partof/pass-an_aggregate_entity_may_pass_any_ancestral_whole_passes.ids
An aggregate entity may pass any ancestral whole passes
Entity: ''IFCBEAM''
Requirements:
PartOf: ''IFCELEMENTASSEMBLY'',IFCRELAGGREGATES
```

### An aggregate may specify the entity of the whole 1/2

``` ids partof/pass-an_aggregate_may_specify_the_entity_of_the_whole_1_2.ids
An aggregate may specify the entity of the whole 1/2
Entity: ''IFCBEAM''
Requirements:
PartOf: ''IFCSLAB'',IFCRELAGGREGATES
```

### An aggregate may specify the entity of the whole 2/2

``` ids partof/fail-an_aggregate_may_specify_the_entity_of_the_whole_2_2.ids
An aggregate may specify the entity of the whole 2/2
Entity: ''IFCBEAM''
Requirements:
PartOf: ''IFCWALL'',IFCRELAGGREGATES
```

### An aggregate may specify the predefined type of the whole 1/2

``` ids partof/pass-an_aggregate_may_specify_the_predefined_type_of_the_whole_1_2.ids
An aggregate may specify the predefined type of the whole 1/2
Entity: ''IFCBEAM''
Requirements:
PartOf: ''IFCSLAB'',''BASESLAB'',IFCRELAGGREGATES
```

### An aggregate may specify the predefined type of the whole 2/2

``` ids partof/fail-an_aggregate_may_specify_the_predefined_type_of_the_whole_2_2.ids
An aggregate may specify the predefined type of the whole 2/2
Entity: ''IFCBEAM''
Requirements:
PartOf: ''IFCSLAB'',''SLABRADOR'',IFCRELAGGREGATES
```

### Any contained element passes a containment relationship 1/2

``` ids partof/fail-any_contained_element_passes_a_containment_relationship_1_2.ids
Any contained element passes a containment relationship 1/2
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: Pattern(''.*''),IFCRELCONTAINEDINSPATIALSTRUCTURE
```

### Any contained element passes a containment relationship 2/2

``` ids partof/pass-any_contained_element_passes_a_containment_relationship_2_2.ids
Any contained element passes a containment relationship 2/2
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: Pattern(''.*''),IFCRELCONTAINEDINSPATIALSTRUCTURE
```

### Any nested part passes a nest relationship

``` ids partof/pass-any_nested_part_passes_a_nest_relationship.ids
Any nested part passes a nest relationship
Entity: ''IFCDISCRETEACCESSORY''
Requirements:
PartOf: Pattern(''.*''),IFCRELNESTS
```

### Any nested whole fails a nest relationship

``` ids partof/fail-any_nested_whole_fails_a_nest_relationship.ids
Any nested whole fails a nest relationship
IFC4
Entity: ''IFCFURNITURE''
Requirements:
PartOf: Pattern(''.*''),IFCRELNESTS
```

### Nesting may be indirect

``` ids partof/pass-nesting_may_be_indirect.ids
Nesting may be indirect
IFC4
Entity: ''IFCMECHANICALFASTENER''
Requirements:
PartOf: ''IFCFURNITURE'',IFCRELNESTS
```

### The aggregated part passes an aggregate relationship

``` ids partof/pass-the_aggregated_part_passes_an_aggregate_relationship.ids
The aggregated part passes an aggregate relationship
Entity: ''IFCWALL''
Requirements:
PartOf: Pattern(''.*''),IFCRELAGGREGATES
```

### The aggregated whole fails an aggregate relationship

``` ids partof/fail-the_aggregated_whole_fails_an_aggregate_relationship.ids
The aggregated whole fails an aggregate relationship
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: Pattern(''.*''),IFCRELAGGREGATES
```

### The container entity must match exactly 1/2

``` ids partof/fail-the_container_entity_must_match_exactly_1_2.ids
The container entity must match exactly 1/2
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: ''IFCSITE'',IFCRELCONTAINEDINSPATIALSTRUCTURE
```

### The container entity must match exactly 2/2

``` ids partof/pass-the_container_entity_must_match_exactly_2_2.ids
The container entity must match exactly 2/2
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: ''IFCSPACE'',IFCRELCONTAINEDINSPATIALSTRUCTURE
```

### The container itself always fails

``` ids partof/fail-the_container_itself_always_fails.ids
The container itself always fails
Entity: ''IFCSPACE''
Requirements:
PartOf: Pattern(''.*''),IFCRELCONTAINEDINSPATIALSTRUCTURE
```

### The container must be related using specified relation 1/2

``` ids partof/pass-the_container_must_be_related_using_specified_relation_1_2.ids
The container must be related using specified relation 1/2
Entity: ''IFCBEAM''
Requirements:
PartOf: ''IFCSPACE'',IFCRELCONTAINEDINSPATIALSTRUCTURE
```

### The container must be related using specified relation 2/2

``` ids partof/fail-the_container_must_be_related_using_specified_relation_2_2.ids
The container must be related using specified relation 2/2
Entity: ''IFCBEAM''
Requirements:
PartOf: ''IFCSPACE'',IFCRELCONTAINEDINSPATIALSTRUCTURE
```

### The containment can be indirect 1/2

``` ids partof/pass-the_containment_can_be_indirect_1_2.ids
The containment can be indirect 1/2
Entity: ''IFCBEAM''
Requirements:
PartOf: ''IFCBUILDING'',IFCRELAGGREGATES
```

### The containment can be indirect 2/2

``` ids partof/fail-the_containment_can_be_indirect_2_2.ids
The containment can be indirect 2/2
Entity: ''IFCBEAM''
Requirements:
PartOf: ''IFCBUILDING'',IFCRELAGGREGATES
```

### The container predefined type must match exactly 1/2

``` ids partof/fail-the_container_predefined_type_must_match_exactly_1_2.ids
The container predefined type must match exactly 1/2
IFC4
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: ''IFCSPACE'',''WARREN'',IFCRELCONTAINEDINSPATIALSTRUCTURE
```

### The container predefined type must match exactly 2/2

``` ids partof/pass-the_container_predefined_type_must_match_exactly_2_2.ids
The container predefined type must match exactly 2/2
IFC4
Entity: ''IFCELEMENTASSEMBLY''
Requirements:
PartOf: ''IFCSPACE'',''BURROW'',IFCRELCONTAINEDINSPATIALSTRUCTURE
```

### The nest entity must match exactly 1/2

``` ids partof/fail-the_nest_entity_must_match_exactly_1_2.ids
The nest entity must match exactly 1/2
Entity: ''IFCDISCRETEACCESSORY''
Requirements:
PartOf: ''IFCBEAM'',IFCRELNESTS
```

### The nest entity must match exactly 2/2

``` ids partof/pass-the_nest_entity_must_match_exactly_2_2.ids
The nest entity must match exactly 2/2
IFC4
Entity: ''IFCDISCRETEACCESSORY''
Requirements:
PartOf: ''IFCFURNITURE'',IFCRELNESTS
```

### The nest predefined type must match exactly 1/2

``` ids partof/fail-the_nest_predefined_type_must_match_exactly_1_2.ids
The nest predefined type must match exactly 1/2
IFC4
Entity: ''IFCDISCRETEACCESSORY''
Requirements:
PartOf: ''IFCFURNITURE'',''LITTERBOX'',IFCRELNESTS
```

### The nest predefined type must match exactly 2/2

``` ids partof/pass-the_nest_predefined_type_must_match_exactly_2_2.ids
The nest predefined type must match exactly 2/2
IFC4
Entity: ''IFCDISCRETEACCESSORY''
Requirements:
PartOf: ''IFCFURNITURE'',''WATERBOTTLE'',IFCRELNESTS
```

## property

### A logical unknown is considered as not matching and will not pass

IFCDURATION is not available in IFC2x3

``` ids property/fail-a_logical_unknown_is_considered_false_and_will_not_pass.ids
A logical unknown is considered as not matching and will not pass
IFC4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLOGICAL
```

### A name check will match any property with any string value

``` ids property/pass-a_name_check_will_match_any_property_with_any_string_value.ids
A name check will match any property with any string value
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL
```

### A name check will match any quantity with any value

``` ids property/pass-a_name_check_will_match_any_quantity_with_any_value.ids
A name check will match any quantity with any value
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLENGTHMEASURE
```

### A number specified as a string is treated as a string

``` ids property/pass-a_number_specified_as_a_string_is_treated_as_a_string.ids
A number specified as a string is treated as a string
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''1''
```

### A prohibited facet returns the opposite of a required facet

``` ids property/fail-a_prohibited_facet_returns_the_opposite_of_a_required_facet.ids
A prohibited facet returns the opposite of a required facet
Entity: ''IFCWALL''
Requirements:
Property: Prohibited,''Foo_Bar'',''Foo''
```

### A property set to false is still considered a value and will pass a name check

``` ids property/pass-a_property_set_to_false_is_still_considered_a_value_and_will_pass_a_name_check.ids
A property set to false is still considered a value and will pass a name check
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCBOOLEAN
```

### A property set to true will pass a name check

``` ids property/pass-a_property_set_to_true_will_pass_a_name_check.ids
A property set to true will pass a name check
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCBOOLEAN
```

### A required facet checks all parameters as normal

``` ids property/pass-a_required_facet_checks_all_parameters_as_normal.ids
A required facet checks all parameters as normal
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL
```

### A zero duration will pass

IFCDURATION is not available in IFC2x3

``` ids property/pass-a_zero_duration_will_pass.ids
A zero duration will pass
IFC4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCDURATION
```

### All matching properties must satisfy requirements 1/3

``` ids property/pass-all_matching_properties_must_satisfy_requirements_1_3.ids
All matching properties must satisfy requirements 1/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',Pattern(''Foo.*''),IFCLABEL,''x''
```

### All matching properties must satisfy requirements 2/3

``` ids property/pass-all_matching_properties_must_satisfy_requirements_2_3.ids
All matching properties must satisfy requirements 2/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',Pattern(''Foo.*''),IFCLABEL,''x''
```

### All matching properties must satisfy requirements 3/3

``` ids property/fail-all_matching_properties_must_satisfy_requirements_3_3.ids
All matching properties must satisfy requirements 3/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',Pattern(''Foo.*''),IFCLABEL,''x''
```

### All matching property sets must satisfy requirements 1/3

``` ids property/pass-all_matching_property_sets_must_satisfy_requirements_1_3.ids
All matching property sets must satisfy requirements 1/3
Entity: ''IFCWALL''
Requirements:
Property: Pattern(''Foo_.*''),''Foo'',IFCLABEL
```

### All matching property sets must satisfy requirements 2/3

``` ids property/fail-all_matching_property_sets_must_satisfy_requirements_2_3.ids
All matching property sets must satisfy requirements 2/3
Entity: ''IFCWALL''
Requirements:
Property: Pattern(''Foo_.*''),''Foo'',IFCLABEL
```

### All matching property sets must satisfy requirements 3/3

``` ids property/pass-all_matching_property_sets_must_satisfy_requirements_3_3.ids
All matching property sets must satisfy requirements 3/3
Entity: ''IFCWALL''
Requirements:
Property: Pattern(''Foo_.*''),''Foo'',IFCLABEL
```

### An empty string is considered not matching and will not pass

``` ids property/fail-an_empty_string_is_considered_false_and_will_not_pass.ids
An empty string is considered not matching and will not pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL
```

### An optional facet always passes regardless of outcome 1/2

``` ids property/pass-an_optional_facet_always_passes_regardless_of_outcome_1_2.ids
An optional facet always passes regardless of outcome 1/2
Entity: ''IFCWALL''
Requirements:
Property: Optional,''Foo_Bar'',''Foo'',IFCLABEL
```

### An optional facet always passes regardless of outcome 2/2

``` ids property/pass-an_optional_facet_always_passes_regardless_of_outcome_2_2.ids
An optional facet always passes regardless of outcome 2/2
Entity: ''IFCWALL''
Requirements:
Property: Optional,''Foo_Bar'',''Bar'',IFCLABEL
```

### Any matching value in a bounded property will pass 1/4

``` ids property/pass-any_matching_value_in_a_bounded_property_will_pass_1_4.ids
Any matching value in a bounded property will pass 1/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLENGTHMEASURE,''1''
```

### Any matching value in a bounded property will pass 2/4

``` ids property/pass-any_matching_value_in_a_bounded_property_will_pass_2_4.ids
Any matching value in a bounded property will pass 2/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLENGTHMEASURE,''5''
```

### Any matching value in a bounded property will pass 3/4

``` ids property/pass-any_matching_value_in_a_bounded_property_will_pass_3_4.ids
Any matching value in a bounded property will pass 3/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLENGTHMEASURE,''3''
```

### Any matching value in a bounded property will pass 4/4

``` ids property/fail-any_matching_value_in_a_bounded_property_will_pass_4_4.ids
Any matching value in a bounded property will pass 4/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLENGTHMEASURE,''2''
```

### Any matching value in a list property will pass 1/3

``` ids property/pass-any_matching_value_in_a_list_property_will_pass_1_3.ids
Any matching value in a list property will pass 1/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''X''
```

### Any matching value in a list property will pass 2/3

``` ids property/pass-any_matching_value_in_a_list_property_will_pass_2_3.ids
Any matching value in a list property will pass 2/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''Y''
```

### Any matching value in a list property will pass 3/3

``` ids property/fail-any_matching_value_in_a_list_property_will_pass_3_3.ids
Any matching value in a list property will pass 3/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''Z''
```

### Any matching value in a table property will pass 1/3

``` ids property/pass-any_matching_value_in_a_table_property_will_pass_1_3.ids
Any matching value in a table property will pass 1/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''X''
```

### Any matching value in a table property will pass 2/3

``` ids property/pass-any_matching_value_in_a_table_property_will_pass_2_3.ids
Any matching value in a table property will pass 2/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLENGTHMEASURE,''1''
```

### Any matching value in a table property will pass 3/3

``` ids property/fail-any_matching_value_in_a_table_property_will_pass_3_3.ids
Any matching value in a table property will pass 3/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''Y''
```

### Any matching value in an enumerated property will pass 1/3

``` ids property/pass-any_matching_value_in_an_enumerated_property_will_pass_1_3.ids
Any matching value in an enumerated property will pass 1/3
IFC4
Entity: ''IFCWALL''
Requirements:
Property: ''Pset_WallCommon'',''Status'',IFCLABEL,''EXISTING''
```

### Any matching value in an enumerated property will pass 2/3

``` ids property/pass-any_matching_value_in_an_enumerated_property_will_pass_2_3.ids
Any matching value in an enumerated property will pass 2/3
IFC4
Entity: ''IFCWALL''
Requirements:
Property: ''Pset_WallCommon'',''Status'',IFCLABEL,''DEMOLISH''
```

### No matching value in an enumerated property will fail 3/3

``` ids property/fail-no_matching_value_in_an_enumerated_property_will_fail_3_3.ids
No matching value in an enumerated property will fail 3/3
IFC4
Entity: ''IFCWALL''
Requirements:
Property: ''Pset_WallCommon'',''Status'',IFCLABEL,''NEW''
```

### Booleans must be specified as lowercase strings 1/3

``` ids property/fail-booleans_must_be_specified_as_lowercase_strings_1_3.ids
Booleans must be specified as lowercase strings 1/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCBOOLEAN,''true''
```

### Booleans must be specified as lowercase strings 2/3

``` ids property/pass-booleans_must_be_specified_as_lowercase_strings_2_3.ids
Booleans must be specified as lowercase strings 2/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCBOOLEAN,''false''
```

### Booleans must be specified as lowercase strings 3/3

``` ids property/invalid-booleans_must_be_specified_as_lowercase_strings_3_3.ids
Booleans must be specified as lowercase strings 3/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCBOOLEAN,''FALSE''
```

### Complex properties are not supported 1/2

``` ids property/fail-complex_properties_are_not_supported_1_2.ids
Complex properties are not supported 1/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLENGTHMEASURE
```

### Complex properties are not supported 2/2

``` ids property/fail-complex_properties_are_not_supported_2_2.ids
Complex properties are not supported 2/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo'',''MyLength'',IFCLENGTHMEASURE
```

### Dates are treated as strings 1/2

``` ids property/pass-dates_are_treated_as_strings_1_2.ids
Dates are treated as strings 1/2
IFC4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCDATE,''2022-01-01''
```

### Dates are treated as strings 2/2

``` ids property/fail-dates_are_treated_as_strings_2_2.ids
Dates are treated as strings 2/2
IFC4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCDATE,''2022-01-01''
```

### Durations are treated as strings 1/2

IFCDURATION is not available in IFC2x3

``` ids property/fail-durations_are_treated_as_strings_1_2.ids
Durations are treated as strings 1/2
IFC4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCDURATION,''PT16H''
```

### Durations are treated as strings 2/2

IFCDURATION is not available in IFC2x3

``` ids property/pass-durations_are_treated_as_strings_2_2.ids
Durations are treated as strings 2/2
IFC4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCDURATION,''PT16H''
```

### Elements with a matching pset but no property also fail

``` ids property/fail-elements_with_a_matching_pset_but_no_property_also_fail.ids
Elements with a matching pset but no property also fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL
```

### Elements with no properties always fail

``` ids property/fail-elements_with_no_properties_always_fail.ids
Elements with no properties always fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL
```

### IDS does not handle string truncation such as for identifiers

``` ids property/fail-ids_does_not_handle_string_truncation_such_as_for_identifiers.ids
IDS does not handle string truncation such as for identifiers
IFC4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCIDENTIFIER,''123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345_extra_characters''
```

### If multiple properties are matched, all values must satisfy requirements 1/2

``` ids property/pass-if_multiple_properties_are_matched__all_values_must_satisfy_requirements_1_2.ids
If multiple properties are matched, all values must satisfy requirements 1/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',Pattern(''Foo.*''),IFCLABEL,Enumeration(''x'',''y'')
```

### If multiple properties are matched, all values must satisfy requirements 2/2

``` ids property/fail-if_multiple_properties_are_matched__all_values_must_satisfy_requirements_2_2.ids
If multiple properties are matched, all values must satisfy requirements 2/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',Pattern(''Foo.*''),IFCLABEL,Enumeration(''x'',''y'')
```

### Integer values are checked using type casting 1/4

``` ids property/pass-integer_values_are_checked_using_type_casting_1_4.ids
Integer values are checked using type casting 1/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCINTEGER,''42''
```

### Integer values cannot be stored with decimal 2/4

``` ids property/invalid-integer_values_cannot_be_stored_with_decimal_2_4.ids
Integer values cannot be stored with decimal 2/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCINTEGER,''42.''
```

### Integer values cannot be stored with decimal 3/4

``` ids property/invalid-integer_values_cannot_be_stored_with_decimal_3_4.ids
Integer values cannot be stored with decimal 3/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCINTEGER,''42.0''
```

### Integer values are checked using type casting 4/4

``` ids property/invalid-integer_values_are_checked_using_type_casting_4_4.ids
Integer values are checked using type casting 4/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCINTEGER,''42.3''
```

### Measures are used to specify an IFC data type 1/2

``` ids property/fail-measures_are_used_to_specify_an_ifc_data_type_1_2.ids
Measures are used to specify an IFC data type 1/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCTIMEMEASURE,''2''
```

### Measures are used to specify an IFC data type 2/2

``` ids property/pass-measures_are_used_to_specify_an_ifc_data_type_2_2.ids
Measures are used to specify an IFC data type 2/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCTIMEMEASURE,''2''
```

### Non-ascii characters are treated without encoding

``` ids property/pass-non_ascii_characters_are_treated_without_encoding.ids
Non-ascii characters are treated without encoding
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''♫Don'tÄrgerhôtelЊет''
```

### Only specifically formatted numbers are allowed 1/4

``` ids property/invalid-only_specifically_formatted_numbers_are_allowed_1_4.ids
Only specifically formatted numbers are allowed 1/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''42,3''
```

### Only specifically formatted numbers are allowed 2/4

``` ids property/invalid-only_specifically_formatted_numbers_are_allowed_2_4.ids
Only specifically formatted numbers are allowed 2/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''123,4.5''
```

### Only specifically formatted numbers are allowed 3/4

``` ids property/pass-only_specifically_formatted_numbers_are_allowed_3_4.ids
Only specifically formatted numbers are allowed 3/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''1.2345e3''
```

### Only specifically formatted numbers are allowed 4/4

``` ids property/pass-only_specifically_formatted_numbers_are_allowed_4_4.ids
Only specifically formatted numbers are allowed 4/4
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''1.2345E3''
```

### Predefined properties are supported but discouraged 1/2

``` ids property/pass-predefined_properties_are_supported_but_discouraged_1_2.ids
Predefined properties are supported but discouraged 1/2
Entity: ''IFCDOOR''
Requirements:
Property: ''Foo_Bar'',''PanelOperation'',IFCDOORPANELOPERATIONENUM,''SWINGING''
```

### Predefined properties are supported but discouraged 2/2

``` ids property/fail-predefined_properties_are_supported_but_discouraged_2_2.ids
Predefined properties are supported but discouraged 2/2
Entity: ''IFCDOOR''
Requirements:
Property: ''Foo_Bar'',''PanelOperation'',IFCDOORPANELOPERATIONENUM,''SWONGING''
```

### Properties can be inherited from the type 1/2

``` ids property/pass-properties_can_be_inherited_from_the_type_1_2.ids
Properties can be inherited from the type 1/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL
```

### Properties can be inherited from the type 2/2

``` ids property/pass-properties_can_be_inherited_from_the_type_2_2.ids
Properties can be inherited from the type 2/2
Entity: ''IFCWALLTYPE''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL
```

### Properties can be overriden by an occurrence 1/2

``` ids property/pass-properties_can_be_overriden_by_an_occurrence_1_2.ids
Properties can be overriden by an occurrence 1/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''Bar''
```

### Properties can be overriden by an occurrence 2/2

``` ids property/fail-properties_can_be_overriden_by_an_occurrence_2_2.ids
Properties can be overriden by an occurrence 2/2
Entity: ''IFCWALLTYPE''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''Bar''
```

### Properties with a null value fail

``` ids property/fail-properties_with_a_null_value_fail.ids
Properties with a null value fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL
```

### Quantities must also match the appropriate measure

``` ids property/fail-quantities_must_also_match_the_appropriate_measure.ids
Quantities must also match the appropriate measure
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCAREAMEASURE
```

### Real values are checked using type casting 1/3

``` ids property/pass-real_values_are_checked_using_type_casting_1_3.ids
Real values are checked using type casting 1/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''42''
```

### Real values are checked using type casting 2/3

``` ids property/pass-real_values_are_checked_using_type_casting_2_3.ids
Real values are checked using type casting 2/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''42.0''
```

### Real values are checked using type casting 3/3

``` ids property/pass-real_values_are_checked_using_type_casting_3_3.ids
Real values are checked using type casting 3/3
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''42.3''
```

### Reference properties are treated as objects and not supported

``` ids property/fail-reference_properties_are_treated_as_objects_and_not_supported.ids
Reference properties are treated as objects and not supported
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL
```

### Specifying a value fails against different values

``` ids property/fail-specifying_a_value_fails_against_different_values.ids
Specifying a value fails against different values
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''Bar''
```

### Specifying a value performs a case-sensitive match 1/2

``` ids property/pass-specifying_a_value_performs_a_case_sensitive_match_1_2.ids
Specifying a value performs a case-sensitive match 1/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''Bar''
```

### Specifying a value performs a case-sensitive match 2/2

``` ids property/fail-specifying_a_value_performs_a_case_sensitive_match_2_2.ids
Specifying a value performs a case-sensitive match 2/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLABEL,''Bar''
```

### Unit conversions shall take place to IDS-nominated standard units 1/2

``` ids property/fail-unit_conversions_shall_take_place_to_ids_nominated_standard_units_1_2.ids
Unit conversions shall take place to IDS-nominated standard units 1/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLENGTHMEASURE,''2''
```

### Unit conversions shall take place to IDS-nominated standard units 2/2

``` ids property/pass-unit_conversions_shall_take_place_to_ids_nominated_standard_units_2_2.ids
Unit conversions shall take place to IDS-nominated standard units 2/2
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCLENGTHMEASURE,''2''
```

### Properties can be associated to relevant object types

The audit tool restricts properties starting with the reserved prefix `Pset_` to the appropriate objects,
but they can also be associated to the relevant types. E.g. `Pset_WallCommon` on `IFCWALLTYPE`.

The provided IFC fails because one of the property sets defines the invalid value `FOOBAR`.

``` ids property/fail-properties_can_be_associated_to_relevant_object_types.ids
Properties can be associated to relevant object types
Optional
IFC4
Entity: ''IFCWALLTYPE''
Requirements:
Property: ''Pset_WallCommon'',''FireRating'',IFCLABEL,Pattern(''(-|[0-9]{2,3})\/(-|[0-9]{2,3})\/(-|[0-9]{2,3})'')
```

## restriction

### A bound can be exclusive 1/3

``` ids restriction/fail-a_bound_can_be_exclusive_1_3.ids
A bound can be exclusive 1/3
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',xs:double MinExclusive(''0'') MaxExclusive(''10'')
```

### A bound can be inclusive 1/4

``` ids restriction/pass-a_bound_can_be_inclusive_1_4.ids
A bound can be inclusive 1/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',xs:double MinInclusive(''0'') MaxInclusive(''10'')
```

### A bound can be exclusive 2/3

``` ids restriction/pass-a_bound_can_be_exclusive_2_3.ids
A bound can be exclusive 2/3
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',xs:double MinExclusive(''0'') MaxExclusive(''10'')
```

### A bound can be inclusive 2/4

``` ids restriction/pass-a_bound_can_be_inclusive_2_4.ids
A bound can be inclusive 2/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',xs:double MinInclusive(''0'') MaxInclusive(''10'')
```

### A bound can be exclusive 3/3

``` ids restriction/fail-a_bound_can_be_exclusive_3_3.ids
A bound can be exclusive 3/3
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',xs:double MinExclusive(''0'') MaxExclusive(''10'')
```

### A bound can be inclusive 3/4

``` ids restriction/pass-a_bound_can_be_inclusive_3_4.ids
A bound can be inclusive 3/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',xs:double MinInclusive(''0'') MaxInclusive(''10'')
```

### A bound can be inclusive 4/4

``` ids restriction/fail-a_bound_can_be_inclusive_4_4.ids
A bound can be inclusive 4/4
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',xs:double MinInclusive(''0'') MaxInclusive(''10'')
```

### An enumeration matches case sensitively 1/3

``` ids restriction/pass-an_enumeration_matches_case_sensitively_1_3.ids
An enumeration matches case sensitively 1/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Enumeration(''Foo'',''Bar'')
```

### An enumeration matches case sensitively 2/3

``` ids restriction/pass-an_enumeration_matches_case_sensitively_2_3.ids
An enumeration matches case sensitively 2/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Enumeration(''Foo'',''Bar'')
```

### An enumeration matches case sensitively 3/3

``` ids restriction/fail-an_enumeration_matches_case_sensitively_3_3.ids
An enumeration matches case sensitively 3/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Enumeration(''Foo'',''Bar'')
```

### An enumeration matches case sensitively 4/3

``` ids restriction/fail-an_enumeration_matches_case_sensitively_4_3.ids
An enumeration matches case sensitively 4/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Enumeration(''Foo'',''Bar'')
```

### Length checks can be used 1/2

``` ids restriction/fail-length_checks_can_be_used_1_2.ids
Length checks can be used 1/2
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Length(''2'')
```

### Length checks can be used 2/2

``` ids restriction/pass-length_checks_can_be_used_2_2.ids
Length checks can be used 2/2
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Length(''2'')
```

### Max and min length checks can be used 1/3

``` ids restriction/fail-max_and_min_length_checks_can_be_used_1_3.ids
Max and min length checks can be used 1/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',MinLength(''2'') MaxLength(''3'')
```

### Max and min length checks can be used 2/3

``` ids restriction/pass-max_and_min_length_checks_can_be_used_2_3.ids
Max and min length checks can be used 2/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',MinLength(''2'') MaxLength(''3'')
```

### Max and min length checks can be used 3/3

``` ids restriction/pass-max_and_min_length_checks_can_be_used_3_3.ids
Max and min length checks can be used 3/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',MinLength(''2'') MaxLength(''3'')
```

### Max and min length checks can be used 4/3

``` ids restriction/fail-max_and_min_length_checks_can_be_used_4_3.ids
Max and min length checks can be used 4/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',MinLength(''2'') MaxLength(''3'')
```

### Patterns always invalid on any number

``` ids restriction/invalid-patterns_always_fail_on_any_number.ids
Patterns always invalid on any number
Optional
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',Pattern(''.*'')
```

### Patterns only work on strings and nothing else

``` ids restriction/invalid-patterns_only_work_on_strings_and_nothing_else.ids
Patterns only work on strings and nothing else
Entity: ''IFCSURFACESTYLEREFRACTION''
Requirements:
Attribute: ''RefractionIndex'',Pattern(''.*'')
```

### Regex patterns can be used 1/3

``` ids restriction/pass-regex_patterns_can_be_used_1_3.ids
Regex patterns can be used 1/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Pattern(''[A-Z]{2}[0-9]{2}'')
```

### Regex patterns can be used 2/3

``` ids restriction/pass-regex_patterns_can_be_used_2_3.ids
Regex patterns can be used 2/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Pattern(''[A-Z]{2}[0-9]{2}'')
```

### Regex patterns can be used 3/3

``` ids restriction/fail-regex_patterns_can_be_used_3_3.ids
Regex patterns can be used 3/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Pattern(''[A-Z]{2}[0-9]{2}'')
```

### Regex patterns work in OR 1/3

``` ids restriction/pass-regex_patterns_work_in_OR_1_3.ids
Regex patterns work in OR 1/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Pattern(''[A-Z]{2}[0-9]{2}'') Pattern(''[a-z]{2}[0-9]{2}'')
```

### Regex patterns work in OR 2/3

``` ids restriction/pass-regex_patterns_work_in_OR_2_3.ids
Regex patterns work in OR 2/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Pattern(''[a-z]{2}[0-9]{2}'') Pattern(''[A-Z]{2}[0-9]{2}'')
```

### Regex patterns work in OR 3/3

``` ids restriction/fail-regex_patterns_work_in_OR_3_3.ids
Regex patterns work in OR 3/3
Entity: ''IFCWALL''
Requirements:
Attribute: ''Name'',Pattern(''[a-z]{3}[0-9]{2}'') Pattern(''[A-Z]{3}[0-9]{2}'')
```

## tolerance

### Comparison tolerance for floating point positive high number lower bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_positive_high_number_lower_bound.ids
Comparison tolerance for floating point positive high number lower bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''100000.''
```

### Comparison tolerance for floating point positive high number lower bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_positive_high_number_lower_bound.ids
Comparison tolerance for floating point positive high number lower bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''100000.''
```

### Comparison tolerance for floating point positive high number upper bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_positive_high_number_upper_bound.ids
Comparison tolerance for floating point positive high number upper bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''100000.''
```

### Comparison tolerance for floating point positive high number upper bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_positive_high_number_upper_bound.ids
Comparison tolerance for floating point positive high number upper bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''100000.''
```

### Comparison tolerance for floating point one lower bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_one_lower_bound.ids
Comparison tolerance for floating point one lower bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''1.''
```

### Comparison tolerance for floating point one lower bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_one_lower_bound.ids
Comparison tolerance for floating point one lower bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''1.''
```

### Comparison tolerance for floating point one upper bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_one_upper_bound.ids
Comparison tolerance for floating point one upper bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''1.''
```

### Comparison tolerance for floating point one upper bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_one_upper_bound.ids
Comparison tolerance for floating point one upper bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''1.''
```

### Comparison tolerance for floating point positive low number lower bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_positive_low_number_lower_bound.ids
Comparison tolerance for floating point positive low number lower bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''0.0000001''
```

### Comparison tolerance for floating point positive low number lower bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_positive_low_number_lower_bound.ids
Comparison tolerance for floating point positive low number lower bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''0.0000001''
```

### Comparison tolerance for floating point positive low number upper bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_positive_low_number_upper_bound.ids
Comparison tolerance for floating point positive low number upper bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''0.0000001''
```

### Comparison tolerance for floating point positive low number upper bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_positive_low_number_upper_bound.ids
Comparison tolerance for floating point positive low number upper bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''0.0000001''
```

### Comparison tolerance for floating point zero lower bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_zero_lower_bound.ids
Comparison tolerance for floating point zero lower bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''0.''
```

### Comparison tolerance for floating point zero lower bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_zero_lower_bound.ids
Comparison tolerance for floating point zero lower bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''0.''
```

### Comparison tolerance for floating point zero upper bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_zero_upper_bound.ids
Comparison tolerance for floating point zero upper bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''0.''
```

### Comparison tolerance for floating point zero upper bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_zero_upper_bound.ids
Comparison tolerance for floating point zero upper bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''0.''
```

### Comparison tolerance for floating point negative low number lower bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_negative_low_number_lower_bound.ids
Comparison tolerance for floating point negative low number lower bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-0.0000001''
```

### Comparison tolerance for floating point negative low number lower bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_negative_low_number_lower_bound.ids
Comparison tolerance for floating point negative low number lower bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-0.0000001''
```

### Comparison tolerance for floating point negative low number upper bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_negative_low_number_upper_bound.ids
Comparison tolerance for floating point negative low number upper bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-0.0000001''
```

### Comparison tolerance for floating point negative low number upper bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_negative_low_number_upper_bound.ids
Comparison tolerance for floating point negative low number upper bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-0.0000001''
```

### Comparison tolerance for floating point negative one lower bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_negative_one_lower_bound.ids
Comparison tolerance for floating point negative one lower bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-1.''
```

### Comparison tolerance for floating point negative one lower bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_negative_one_lower_bound.ids
Comparison tolerance for floating point negative one lower bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-1.''
```

### Comparison tolerance for floating point negative one upper bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_negative_one_upper_bound.ids
Comparison tolerance for floating point negative one upper bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-1.''
```

### Comparison tolerance for floating point negative one upper bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_negative_one_upper_bound.ids
Comparison tolerance for floating point negative one upper bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-1.''
```

### Comparison tolerance for floating point negative high number lower bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_negative_high_number_lower_bound.ids
Comparison tolerance for floating point negative high number lower bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-1000000.''
```

### Comparison tolerance for floating point negative high number lower bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_negative_high_number_lower_bound.ids
Comparison tolerance for floating point negative high number lower bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-1000000.''
```

### Comparison tolerance for floating point negative high number upper bound pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_negative_high_number_upper_bound.ids
Comparison tolerance for floating point negative high number upper bound pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-1000000.''
```

### Comparison tolerance for floating point negative high number upper bound fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_negative_high_number_upper_bound.ids
Comparison tolerance for floating point negative high number upper bound fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,''-1000000.''
```

### Comparison tolerance for floating point range greater than zero exclusive fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_range_greater_than_zero_exclusive.ids
Comparison tolerance for floating point range greater than zero exclusive fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,xs:double MinExclusive(''0.'')
```

### Comparison tolerance for floating point range greater than zero exclusive pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_range_greater_than_zero_exclusive.ids
Comparison tolerance for floating point range greater than zero exclusive pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,xs:double MinExclusive(''0.'')
```

### Comparison tolerance for floating point range greater than zero inclusive fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_range_greater_than_zero_inclusive.ids
Comparison tolerance for floating point range greater than zero inclusive fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,xs:double MinInclusive(''0.'')
```

### Comparison tolerance for floating point range greater than zero inclusive pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_range_greater_than_zero_inclusive.ids
Comparison tolerance for floating point range greater than zero inclusive pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,xs:double MinInclusive(''0.'')
```

### Comparison tolerance for floating point range lower than zero exclusive fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_range_lower_than_zero_exclusive.ids
Comparison tolerance for floating point range lower than zero exclusive fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,xs:double MaxExclusive(''0.'')
```

### Comparison tolerance for floating point range lower than zero exclusive pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_range_lower_than_zero_exclusive.ids
Comparison tolerance for floating point range lower than zero exclusive pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,xs:double MaxExclusive(''0.'')
```

### Comparison tolerance for floating point range lower than zero inclusive fail

``` ids tolerance/fail-comparison_tolerance_for_floating_point_range_lower_than_zero_inclusive.ids
Comparison tolerance for floating point range lower than zero inclusive fail
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,xs:double MaxInclusive(''0.'')
```

### Comparison tolerance for floating point range lower than zero inclusive pass

``` ids tolerance/pass-comparison_tolerance_for_floating_point_range_lower_than_zero_inclusive.ids
Comparison tolerance for floating point range lower than zero inclusive pass
Entity: ''IFCWALL''
Requirements:
Property: ''Foo_Bar'',''Foo'',IFCREAL,xs:double MaxInclusive(''0.'')
```
