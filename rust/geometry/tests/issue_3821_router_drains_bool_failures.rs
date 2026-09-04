// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #3821: the router drains its processors' own boolean-failure logs.
//!
//! `BooleanClippingProcessor::take_failures` had no caller outside tests, so
//! everything it recorded sat in a `RefCell` the pipeline never read. These
//! tests exercise the route the pipeline actually uses — build a router, mesh
//! an element, drain the router — rather than calling `take_failures` directly,
//! which is what made the gap invisible for so long.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{BoolFailureReason, BoolOp, GeometryRouter};

fn router_for(content: &'static str) -> (GeometryRouter, EntityDecoder<'static>) {
    let entity_index = ifc_lite_core::build_entity_index(content.as_bytes());
    let mut decoder = EntityDecoder::with_index(content.as_bytes(), entity_index);
    let router = GeometryRouter::with_units(content.as_bytes(), &mut decoder);
    (router, decoder)
}

fn all_reason_labels(router: &GeometryRouter) -> Vec<String> {
    let mut out: Vec<String> = router
        .take_csg_failures()
        .values()
        .flatten()
        .map(|f| f.reason.label().to_string())
        .collect();
    out.sort();
    out
}

fn unsupported_operand_types(router: &GeometryRouter) -> Vec<String> {
    let mut out: Vec<String> = router
        .take_csg_failures()
        .values()
        .flatten()
        .filter_map(|f| match &f.reason {
            BoolFailureReason::UnsupportedOperand(ty) => Some(ty.clone()),
            _ => None,
        })
        .collect();
    out.sort();
    out
}

/// A wall whose Body item is an `IfcBooleanResult` with an `IFCSECTIONEDSPINE`
/// FIRST operand — no branch in the boolean operand dispatch, so the base solid
/// meshes empty and the element's item silently disappears.
const UNSUPPORTED_BASE_OPERAND: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('3821 direct boolean'),'2;1');
FILE_NAME('d.ifc','2026-09-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWALL('1DirectBooleanWall001',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#30));
#30=IFCBOOLEANRESULT(.DIFFERENCE.,#31,#33);
#31=IFCSECTIONEDSPINE(#32,(#34),(#5));
#32=IFCCOMPOSITECURVE((),$);
#33=IFCEXTRUDEDAREASOLID(#34,#5,#35,1.0);
#34=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.0,0.2);
#35=IFCDIRECTION((0.,0.,1.));
ENDSEC;
END-ISO-10303-21;
"#;

/// The same unsupported operand, one level deeper: the Body item is an
/// `IfcCsgSolid` whose `TreeRootExpression` is the boolean. That boolean runs
/// on a TRANSIENT processor `CsgSolidProcessor` builds and drops, so it is not
/// in the router's processor table and has to hand its log back to the
/// `CsgSolidProcessor` that built it.
const UNSUPPORTED_BASE_OPERAND_UNDER_CSGSOLID: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('3821 csgsolid boolean'),'2;1');
FILE_NAME('e.ifc','2026-09-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWALL('1CsgSolidBooleanWall1',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#20));
#20=IFCCSGSOLID(#30);
#30=IFCBOOLEANRESULT(.DIFFERENCE.,#31,#33);
#31=IFCSECTIONEDSPINE(#32,(#34),(#5));
#32=IFCCOMPOSITECURVE((),$);
#33=IFCEXTRUDEDAREASOLID(#34,#5,#35,1.0);
#34=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.0,0.2);
#35=IFCDIRECTION((0.,0.,1.));
ENDSEC;
END-ISO-10303-21;
"#;

/// A clean wall: one extruded solid, no booleans at all. Without this control,
/// "the drain reported something" would not distinguish a working drain from
/// one that manufactures records.
const CLEAN: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('3821 control'),'2;1');
FILE_NAME('f.ifc','2026-09-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWALL('1ControlPlainWall001',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#14));
#14=IFCEXTRUDEDAREASOLID(#34,#5,#35,3.0);
#34=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.0,0.3);
#35=IFCDIRECTION((0.,0.,1.));
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn unsupported_base_operand_reaches_the_routers_csg_failures() {
    let (router, mut decoder) = router_for(UNSUPPORTED_BASE_OPERAND);
    let element = decoder.decode_by_id(10).expect("decode the wall");
    let mesh = router
        .process_element(&element, &mut decoder)
        .expect("an unsupported operand must not error the element");

    // Behaviour is unchanged: the boolean still yields an empty mesh. Returning
    // `Err` here would delete the host for the second-operand case, which is
    // why the arm records instead of failing.
    assert!(mesh.is_empty(), "the boolean result is still empty; this is observability, not a behaviour change");

    assert_eq!(
        unsupported_operand_types(&router),
        vec!["IfcSectionedSpine".to_string()],
        "the router must drain the boolean processor's log and name the operand type"
    );
}

#[test]
fn unsupported_operand_under_an_ifccsgsolid_reaches_the_router_too() {
    let (router, mut decoder) = router_for(UNSUPPORTED_BASE_OPERAND_UNDER_CSGSOLID);
    let element = decoder.decode_by_id(10).expect("decode the wall");
    let _ = router.process_element(&element, &mut decoder);

    assert_eq!(
        unsupported_operand_types(&router),
        vec!["IfcSectionedSpine".to_string()],
        "a boolean run on CsgSolidProcessor's transient processor must still be reported"
    );
}

#[test]
fn a_clean_element_drains_nothing() {
    let (router, mut decoder) = router_for(CLEAN);
    let element = decoder.decode_by_id(10).expect("decode the wall");
    let mesh = router
        .process_element(&element, &mut decoder)
        .expect("the control wall meshes");
    assert!(!mesh.is_empty(), "control wall must produce geometry");
    assert!(
        router.take_csg_failures().is_empty(),
        "a model with no booleans must drain no failures"
    );
}

#[test]
fn draining_twice_does_not_double_count() {
    // The boolean processor is registered under BOTH IfcBooleanResult and
    // IfcBooleanClippingResult as one shared Arc, so the sweep visits it twice.
    let (router, mut decoder) = router_for(UNSUPPORTED_BASE_OPERAND);
    let element = decoder.decode_by_id(10).expect("decode the wall");
    let _ = router.process_element(&element, &mut decoder);

    assert_eq!(unsupported_operand_types(&router).len(), 1, "one drop, one record");
    assert!(
        router.take_csg_failures().is_empty(),
        "the drain is destructive: a second take must return nothing"
    );
}

/// The same unsupported type as the SECOND operand (an unsupported cutter).
/// The host renders un-cut, which is correct; what must not happen is TWO
/// records for one dropped step. Before the one-record rule, the arm recorded
/// `UnsupportedOperand` and the caller then recorded `EmptyOperand` on top of
/// it, inflating `total_csg_failures` and — because the reason breakdown breaks
/// count ties alphabetically — making the viewer name `EmptyOperand`, the
/// consequence, as the top failure reason instead of the cause.
const UNSUPPORTED_SECOND_OPERAND: &str = r"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('3821 unsupported cutter'),'2;1');
FILE_NAME('g.ifc','2026-09-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWALL('1UnsupportedCutter01',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#30));
#30=IFCBOOLEANRESULT(.DIFFERENCE.,#33,#31);
#31=IFCSECTIONEDSPINE(#32,(#34),(#5));
#32=IFCCOMPOSITECURVE((),$);
#33=IFCEXTRUDEDAREASOLID(#34,#5,#35,3.0);
#34=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.0,0.3);
#35=IFCDIRECTION((0.,0.,1.));
ENDSEC;
END-ISO-10303-21;
";

/// A cutter of a SUPPORTED type that meshes to nothing. The control for the
/// one-record rule: suppressing the `EmptyOperand` consequence of an
/// UNSUPPORTED operand must not suppress `EmptyOperand` where it is the only
/// thing anyone recorded.
const EMPTY_SUPPORTED_CUTTER: &str = r"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('3821 empty supported cutter'),'2;1');
FILE_NAME('h.ifc','2026-09-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWALL('1EmptySupportedCut01',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#30));
#30=IFCBOOLEANRESULT(.DIFFERENCE.,#33,#36);
#33=IFCEXTRUDEDAREASOLID(#34,#5,#35,3.0);
#34=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.0,0.3);
#35=IFCDIRECTION((0.,0.,1.));
#36=IFCEXTRUDEDAREASOLID(#37,#5,#35,1.0);
#37=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#38);
#38=IFCPOLYLINE(());
ENDSEC;
END-ISO-10303-21;
";

#[test]
fn an_unsupported_cutter_yields_exactly_one_record_naming_the_cause() {
    let (router, mut decoder) = router_for(UNSUPPORTED_SECOND_OPERAND);
    let element = decoder.decode_by_id(10).expect("decode the wall");
    let mesh = router
        .process_element(&element, &mut decoder)
        .expect("an unsupported cutter must not error the element");

    // The host still renders, un-cut — the correct recovery, and the reason the
    // operand arm must not return `Err`.
    assert!(!mesh.is_empty(), "the host must survive an unsupported cutter");

    assert_eq!(
        all_reason_labels(&router),
        vec!["UnsupportedOperand".to_string()],
        "one dropped step must produce ONE record, naming the cause and not the \
         EmptyOperand consequence"
    );
}

#[test]
fn a_genuinely_empty_cutter_still_records_emptyoperand() {
    let (router, mut decoder) = router_for(EMPTY_SUPPORTED_CUTTER);
    let element = decoder.decode_by_id(10).expect("decode the wall");
    let _ = router.process_element(&element, &mut decoder);
    assert_eq!(
        all_reason_labels(&router),
        vec!["EmptyOperand".to_string()],
        "an empty cutter of a SUPPORTED type must still record EmptyOperand"
    );
}

#[test]
fn flipping_skip_small_cuts_does_not_discard_an_undrained_log() {
    // `set_skip_small_cuts` re-registers the boolean and CSG processors, which
    // DROPS the old ones — and a dropped processor takes its failure log with
    // it. The viewer flips this flag on a live router, so a record made before
    // the flip and drained after it must survive.
    let (mut router, mut decoder) = router_for(UNSUPPORTED_BASE_OPERAND);
    let element = decoder.decode_by_id(10).expect("decode the wall");
    let _ = router.process_element(&element, &mut decoder);

    // Deliberately NOT drained first: that is the whole hazard.
    router.set_skip_small_cuts(true);

    assert_eq!(
        unsupported_operand_types(&router),
        vec!["IfcSectionedSpine".to_string()],
        "a record made before the flag flipped must survive the re-registration"
    );
}

/// An unsupported SECOND operand is the only record for its step (the
/// `EmptyOperand` consequence is suppressed by the one-record rule above), so
/// the operation it names is the only operation a consumer of
/// `take_csg_failures` or of `BoolFailure`'s `Display` ever sees for that step.
/// Recording `Unknown` there renders "UNKNOWN failed: ..." for a boolean the
/// file authored as `.DIFFERENCE.`.
#[test]
fn an_unsupported_cutter_names_the_containing_operation() {
    let (router, mut decoder) = router_for(UNSUPPORTED_SECOND_OPERAND);
    let element = decoder.decode_by_id(10).expect("decode the wall");
    let _ = router.process_element(&element, &mut decoder);

    let ops: Vec<BoolOp> = router
        .take_csg_failures()
        .values()
        .flatten()
        .map(|f| f.op)
        .collect();
    assert_eq!(
        ops,
        vec![BoolOp::Difference],
        "the record must name the authored .DIFFERENCE., not UNKNOWN"
    );
}

/// Two routers, one thread. A boolean under an `IfcCsgSolid` runs on a
/// transient processor; if its log escapes through a thread-local rather than
/// through the router that owns the CSG processor, a router that never drains
/// hands its records to whichever router drains next — diagnostics for the
/// wrong model. The public router API permits exactly this order, so nothing
/// but scoping prevents it.
#[test]
fn an_undrained_router_does_not_leak_into_the_next_one() {
    let (leaky, mut leaky_decoder) = router_for(UNSUPPORTED_BASE_OPERAND_UNDER_CSGSOLID);
    let element = leaky_decoder.decode_by_id(10).expect("decode the wall");
    let _ = leaky.process_element(&element, &mut leaky_decoder);
    // Deliberately NOT drained: draining is optional in the public API.

    let (clean, mut clean_decoder) = router_for(CLEAN);
    let clean_element = clean_decoder.decode_by_id(10).expect("decode the wall");
    let _ = clean.process_element(&clean_element, &mut clean_decoder);
    assert!(
        clean.take_csg_failures().is_empty(),
        "a second router on the same thread must not inherit the first router's records"
    );

    // And the records are not merely lost: the router that made them still has them.
    assert_eq!(
        unsupported_operand_types(&leaky),
        vec!["IfcSectionedSpine".to_string()],
        "the owning router must still be able to drain its own records"
    );
}
