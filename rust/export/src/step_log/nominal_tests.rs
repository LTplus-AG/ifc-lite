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
