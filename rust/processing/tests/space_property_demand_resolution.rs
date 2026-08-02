// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Demand-driven space/zone property resolution (`resolve_space_zone_properties_lazy`).
//!
//! The processor no longer eagerly decodes every property atom during the scan;
//! it resolves an IfcSpace/IfcZone's properties on demand in the lookup phase.
//! Two invariants are locked here end-to-end through `process_geometry`:
//!
//! 1. **A space's real property set still lands on its mesh.** The demand path
//!    must decode the `IfcPropertySet` a space references and attach its values.
//! 2. **The type gate holds.** The lazy path resolves the property-set id through
//!    the entity index (`decode_by_id`), so — unlike the old scan, which only
//!    stashed exact `IFCPROPERTYSET` matches — a malformed
//!    `IfcRelDefinesByProperties` whose `RelatingPropertyDefinition` points at a
//!    NON-pset entity could otherwise have its attribute list mined into invented
//!    properties. The gate (`ifc_type == IfcPropertySet`) must reject it, matching
//!    the eager path (which never surfaced such properties).

use ifc_lite_processing::process_geometry;

// A single IfcSpace with a tessellated body so it produces a mesh that can carry
// `space_zone_properties`. It is linked to:
//   * #50 — a real IfcPropertySet (RealPset / RealProp=present), and
//   * #62 — another IfcRelDefinesByProperties (NOT a property set) that lists a
//     property atom (#52 PhantomProp=leak) in its RelatedObjects. #61 points the
//     space at #62. A resolver without a type gate would mine #62's attribute-4
//     list and invent `PhantomProp`; the gate must drop it.
const SPACE_PROPS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('space property demand-resolution fixture'),'2;1');
FILE_NAME('space_props.ifc','2026-07-06T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project000000000000AA',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCLOCALPLACEMENT($,#5);
#8=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#30=IFCSPACE('0Space00000000000000AA',$,'Room 101',$,$,#7,#41,$,.ELEMENT.,.INTERNAL.,$);
#41=IFCPRODUCTDEFINITIONSHAPE($,$,(#42));
#42=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#43));
#43=IFCTRIANGULATEDFACESET(#8,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#50=IFCPROPERTYSET('0RealPset00000000000A',$,'RealPset',$,(#51));
#51=IFCPROPERTYSINGLEVALUE('RealProp',$,IFCLABEL('present'),$);
#60=IFCRELDEFINESBYPROPERTIES('0RelReal000000000000A',$,$,$,(#30),#50);
#52=IFCPROPERTYSINGLEVALUE('PhantomProp',$,IFCLABEL('leak'),$);
#62=IFCRELDEFINESBYPROPERTIES('0RelInner00000000000A',$,$,$,(#52),#50);
#61=IFCRELDEFINESBYPROPERTIES('0RelPhantom0000000A',$,$,$,(#30),#62);
ENDSEC;
END-ISO-10303-21;
"#;

fn space_mesh_properties() -> std::collections::BTreeMap<String, String> {
    let result = process_geometry(&SPACE_PROPS_IFC.as_bytes());
    let space = result
        .meshes
        .iter()
        .find(|m| m.express_id == 30)
        .expect("IfcSpace #30 should produce a mesh");
    space
        .properties
        .clone()
        .expect("space mesh should carry space_zone_properties")
}

#[test]
fn space_real_property_set_is_resolved_on_demand() {
    let props = space_mesh_properties();
    assert_eq!(
        props.get("RealProp").map(String::as_str),
        Some("present"),
        "the space's real IfcPropertySet value must be resolved and attached; got {props:?}"
    );
    // The pset-scoped alias is also emitted by add_space_zone_property.
    assert_eq!(props.get("RealPset.RealProp").map(String::as_str), Some("present"));
}

#[test]
fn type_gate_rejects_non_property_set_relating_definition() {
    let props = space_mesh_properties();
    assert!(
        !props.contains_key("PhantomProp"),
        "a RelatingPropertyDefinition pointing at a non-IfcPropertySet entity must not \
         invent properties (type gate); got {props:?}"
    );
    assert!(!props.contains_key("RealPset.PhantomProp"));
}