// SPDX-License-Identifier: MPL-2.0
use serde_json::json;

use super::*;

fn fam(schema: &str) -> Option<SchemaFamily> {
    SchemaFamily::of_file_schema(schema)
}

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
    assert!(check_literal_measure(fam("IFC4"), "IfcLengthMeasure", "1.E5", true).is_ok());
    assert!(check_literal_measure(fam("IFC4"), "IfcLengthMeasure", "1E5", true).is_err());
    assert!(check_literal_measure(fam("IFC5"), "IfcLengthMeasure", "5.", true).is_ok());
}

/// (#8142) A binary is a quoted STEP binary literal: a leading digit 0-3 (the
/// unused bits of the last hex digit) and upper-case hex digits.
#[test]
fn a_binary_literal_must_have_the_step_binary_shape_8142() {
    for ok in ["\"0\"", "\"0A\"", "\"3FF\"", "\"10\""] {
        assert!(check_literal_measure(fam("IFC4"), "IfcBinary", ok, true).is_ok(), "{ok}");
    }
    // With no hex digits there are no unused bits: "3" is not a binary.
    for bad in ["5.", "'0A'", "\"\"", "\"1\"", "\"3\"", "\"4A\"", "\"0a\"", "\"0G\"", "0A", "\"0A", ".T."] {
        assert!(check_literal_measure(fam("IFC4"), "IfcBinary", bad, true).is_err(), "{bad}");
    }
}

/// (#8142) An aggregate member of `IfcValue` is refused for what it is, in
/// every family that declares it, not as an unknown measure.
#[test]
fn an_aggregate_value_type_is_refused_as_an_aggregate_8142() {
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        for measure in ["IFCCOMPLEXNUMBER", "IfcCompoundPlaneAngleMeasure"] {
            let reason = check_literal_measure(fam(schema), measure, "(1,2,3)", true).unwrap_err();
            assert!(reason.contains("is an aggregate value type, which a single-value write cannot carry"), "{schema} {measure}: {reason}");
            let reason = check_real_measure(fam(schema), measure, 1.0, true).unwrap_err();
            assert!(reason.contains("is an aggregate value type, which a single-value write cannot carry"), "{schema} {measure}: {reason}");
        }
    }
}

/// (#8142) Known gap, pinned as `main` behaves: IFC4X3 declares
/// `IfcCountMeasure` over INTEGER, but every path still reads IFC4's NUMBER,
/// so a count is checked and written as a real in IFC4X3 too. The fix is the
/// follow-up on `fix/ifc4x3-count-measure`.
#[test]
fn an_ifc4x3_count_is_still_a_real_known_gap_8142() {
    for schema in ["IFC4", "IFC4X3"] {
        assert!(check_literal_measure(fam(schema), "IfcCountMeasure", "3.", true).is_ok(), "{schema}");
        assert_eq!(canonical_literal(fam(schema), "IfcCountMeasure", "3"), "3.", "{schema}");
        assert_eq!(check_real_measure(fam(schema), "IfcCountMeasure", 3.5, true), Ok(MeasureNumber::Real), "{schema}");
    }
    assert_eq!(serialize_nominal_value(&json!(3), pvt::INTEGER, Some("IFCCOUNTMEASURE")), "IFCCOUNTMEASURE(3.)");
    assert_eq!(super::super::values::typed_marker("IfcCountMeasure", &json!(3)).unwrap(), "IFCCOUNTMEASURE(3.)");
}

/// (#8142) A number for a measure over INTEGER is written as an integer when
/// it is whole, and refused, saying so, when it is not.
#[test]
fn an_integer_measure_takes_a_whole_number_8142() {
    assert_eq!(check_real_measure(fam("IFC4"), "IfcPositiveInteger", 2.0, true), Ok(MeasureNumber::Integer(2)));
    let reason = check_real_measure(fam("IFC4X3"), "IfcPositiveInteger", 2.5, true).unwrap_err();
    assert!(reason.contains("IfcPositiveInteger takes a whole number in IFC4X3"), "{reason}");
    assert!(check_real_measure(fam("IFC4"), "IfcPositiveInteger", 0.0, true).unwrap_err().contains("outside"));
    assert!(check_real_measure(fam("IFC4"), "IfcPositiveInteger", 1e300, true).is_err());
    let reason = check_real_measure(fam("IFC4"), "IfcBoolean", 1.0, true).unwrap_err();
    assert_eq!(reason, "IfcBoolean holds a BOOLEAN value, not a number");
}
