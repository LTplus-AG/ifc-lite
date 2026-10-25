// SPDX-License-Identifier: MPL-2.0
use serde_json::json;

use super::*;

#[test]
fn a_source_measure_token_survives_regeneration() {
    // #2482: the token IS the unit semantics, so an untouched neighbour keeps it.
    assert_eq!(serialize_nominal_value(&json!(0.25), pvt::REAL, Some("IFCTHERMALTRANSMITTANCEMEASURE")), "IFCTHERMALTRANSMITTANCEMEASURE(0.25)");
    assert_eq!(serialize_nominal_value(&json!("W01"), pvt::STRING, Some("IFCIDENTIFIER")), "IFCIDENTIFIER('W01')");
}

#[test]
fn a_value_outside_a_constrained_member_relaxes_to_its_ancestor() {
    assert_eq!(serialize_nominal_value(&json!(-1), pvt::REAL, Some("IFCPOSITIVELENGTHMEASURE")), "IFCLENGTHMEASURE(-1.)");
    assert_eq!(serialize_nominal_value(&json!(2), pvt::REAL, Some("IFCNORMALISEDRATIOMEASURE")), "IFCRATIOMEASURE(2.)");
    // No unconstrained ancestor inside IfcValue: the shape decides.
    assert_eq!(serialize_nominal_value(&json!(99), pvt::REAL, Some("IFCPHMEASURE")), "IFCREAL(99.)");
}

#[test]
fn a_named_member_outranks_the_source_token() {
    assert_eq!(serialize_nominal_value(&json!("x"), pvt::TEXT, Some("IFCLABEL")), "IFCTEXT('x')");
}

#[test]
fn shape_fallbacks_match_serialize_property_value() {
    assert_eq!(serialize_property_value(&json!(null), pvt::LOGICAL), "IFCLOGICAL(.U.)");
    assert_eq!(serialize_property_value(&json!(null), pvt::STRING), "$");
    assert_eq!(serialize_property_value(&json!(2.5), pvt::INTEGER), "IFCINTEGER(3)");
    assert_eq!(serialize_property_value(&json!(-2.5), pvt::INTEGER), "IFCINTEGER(-2)");
    assert_eq!(serialize_property_value(&json!(["a", null]), pvt::LIST), "(IFCLABEL('a'),$)");
    assert_eq!(serialize_property_value(&json!("vendor"), pvt::STRING), "IFCLABEL('vendor')");
    // A vendor token is not an IfcValue member: the shape decides.
    assert_eq!(serialize_nominal_value(&json!("X"), pvt::STRING, Some("IFCACMEWIDGETCODE")), "IFCLABEL('X')");
}

/// (#8142)
#[test]
fn a_real_exponent_needs_its_decimal_point() {
    assert!(check_literal_measure("IFC4", "IfcLengthMeasure", "1.E5", true).is_ok());
    assert!(check_literal_measure("IFC4", "IfcLengthMeasure", "1E5", true).is_err());
    assert!(check_literal_measure("IFC5", "IfcLengthMeasure", "5.", true).is_ok());
}

/// (#8142) A binary is a quoted STEP binary literal: a leading digit 0-3 (the
/// unused bits of the last hex digit) and upper-case hex digits.
#[test]
fn a_binary_literal_must_have_the_step_binary_shape_8142() {
    for ok in ["\"0\"", "\"0A\"", "\"3FF\"", "\"1\""] {
        assert!(check_literal_measure("IFC4", "IfcBinary", ok, true).is_ok(), "{ok}");
    }
    for bad in ["5.", "'0A'", "\"\"", "\"4A\"", "\"0a\"", "\"0G\"", "0A", "\"0A", ".T."] {
        assert!(check_literal_measure("IFC4", "IfcBinary", bad, true).is_err(), "{bad}");
    }
}

/// (#8142) An aggregate member of `IfcValue` is refused for what it is, in
/// every family that declares it, not as an unknown measure.
#[test]
fn an_aggregate_value_type_is_refused_as_an_aggregate_8142() {
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        for measure in ["IFCCOMPLEXNUMBER", "IfcCompoundPlaneAngleMeasure"] {
            let reason = check_literal_measure(schema, measure, "(1,2,3)", true).unwrap_err();
            assert!(reason.contains("aggregate value types are not supported by single-value writes"), "{schema} {measure}: {reason}");
            let reason = check_real_measure(schema, measure, 1.0, true).unwrap_err();
            assert!(reason.contains("aggregate value types are not supported by single-value writes"), "{schema} {measure}: {reason}");
        }
    }
}

/// (#8142) `check_literal_measure` treats every base but six as BINARY; the
/// table carries no other.
#[test]
fn every_leaf_base_is_one_check_literal_measure_handles_8142() {
    for (token, _, base, _, _) in crate::generated::step_log_tables::NOMINAL_VALUE_LEAVES {
        assert!(["STRING", "REAL", "NUMBER", "INTEGER", "BOOLEAN", "LOGICAL", "BINARY"].contains(base), "{token}: {base}");
    }
}
