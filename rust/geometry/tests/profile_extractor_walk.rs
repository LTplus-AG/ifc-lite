// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The 2D drawing extractor walks the representations the mesh path renders
//! (`Select::Meshed`) and bounds mapped nesting the way the mesh path does
//! (`MAX_MAPPED_ITEM_DEPTH` plus the path-scoped visited set), through the one
//! `RepresentationWalk` (C2-X1, D36). Before, it selected on the
//! RepresentationIdentifier (`Body`/`SweptSolid`) and capped mapped chains at a
//! private depth of 3 with no visited set, so a drawing and the 3D model
//! disagreed about which solids exist.

use ifc_lite_core::MAX_MAPPED_ITEM_DEPTH;
use ifc_lite_geometry::extract_profiles_with_diagnostics;

/// One wall `#100` whose `IfcProductDefinitionShape` lists `reps`, plus the
/// extra `entities`. `#140` (4 x 0.3 x 2.5 m) and `#240` (1 x 1 x 1 m) are
/// extrusions; `#13` is the Body context.
fn wall(reps: &str, entities: &str) -> String {
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('profile-extractor walk'),'2;1');
FILE_NAME('f.ifc','2026-10-17T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0ExtractorWalkProj00A',$,'P',$,$,$,$,(#10),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#110=IFCLOCALPLACEMENT($,#111);
#111=IFCAXIS2PLACEMENT3D(#12,$,$);
#130=IFCRECTANGLEPROFILEDEF(.AREA.,'Wall',#131,4.,0.3);
#131=IFCAXIS2PLACEMENT2D(#132,#133);
#132=IFCCARTESIANPOINT((0.,0.));
#133=IFCDIRECTION((1.,0.));
#140=IFCEXTRUDEDAREASOLID(#130,#141,#142,2.5);
#141=IFCAXIS2PLACEMENT3D(#12,$,$);
#142=IFCDIRECTION((0.,0.,1.));
#230=IFCRECTANGLEPROFILEDEF(.AREA.,'Block',#131,1.,1.);
#240=IFCEXTRUDEDAREASOLID(#230,#141,#142,1.);
#151=IFCPRODUCTDEFINITIONSHAPE($,$,({reps}));
#100=IFCWALL('0ExtractorWalkWall00A',$,'Wall',$,$,#110,#151,$,$);
{entities}
ENDSEC;
END-ISO-10303-21;
"#
    )
}

/// `IfcMappedItem` `#{item}` over map `#{item+1}` whose representation
/// `#{item+2}` holds `items`.
fn mapped(item: u32, items: &str) -> String {
    let (map, rep) = (item + 1, item + 2);
    format!(
        "#{item}=IFCMAPPEDITEM(#{map},#99);\n\
         #{map}=IFCREPRESENTATIONMAP(#11,#{rep});\n\
         #{rep}=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',({items}));\n"
    )
}

const TARGET: &str = "#99=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#12,1.,$);";

/// A chain of `levels` mapped items, `#1000`, `#1003`, ..., the innermost
/// holding `#240`. The wall's mapped representation is `#160`.
fn chain(levels: u32) -> String {
    let mut entities = format!("{TARGET}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','MappedRepresentation',(#1000));\n");
    for level in 0..levels {
        let item = 1000 + 3 * level;
        let inner = if level + 1 == levels { "#240".to_string() } else { format!("#{}", item + 3) };
        entities.push_str(&mapped(item, &inner));
    }
    wall("#160", &entities)
}

/// An element whose body is carried both directly and as a mapped duplicate
/// renders once on the mesh path (the #4699 mapped-duplicate exclusion), so the
/// drawing draws it once. The identifier filter drew both.
#[test]
fn mapped_duplicate_of_direct_body_draws_once() {
    let entities = format!(
        "{TARGET}\n#150=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140));\n\
         #160=IFCSHAPEREPRESENTATION(#13,'Body','MappedRepresentation',(#1000));\n{}",
        mapped(1000, "#140")
    );
    let (profiles, skipped) = extract_profiles_with_diagnostics(&wall("#150,#160", &entities), 0);
    assert_eq!(profiles.len(), 1, "the mapped duplicate must not draw a second profile: {profiles:?}");
    assert!(skipped.is_empty(), "{skipped:?}");

    // Control: the mapped representation alone (no direct body) still draws.
    let (alone, _) = extract_profiles_with_diagnostics(&wall("#160", &entities), 0);
    assert_eq!(alone.len(), 1, "a mapped-only body must draw");
}

/// The mesh path follows mapped chains to `MAX_MAPPED_ITEM_DEPTH` levels; the
/// extractor's private cap of 3 dropped a 5-level chain (nesting index 4) that
/// renders in 3D.
#[test]
fn mapped_chain_deeper_than_the_old_cap_draws() {
    let (profiles, skipped) = extract_profiles_with_diagnostics(&chain(5), 0);
    assert_eq!(profiles.len(), 1, "a 5-level mapped chain renders, so it draws: {skipped:?}");
    assert!(skipped.is_empty(), "{skipped:?}");

    let (at_cap, skipped) = extract_profiles_with_diagnostics(&chain(MAX_MAPPED_ITEM_DEPTH), 0);
    assert_eq!(at_cap.len(), 1, "a chain at the shared cap draws: {skipped:?}");
}

/// Past the shared cap the chain is refused and the drop is recorded once.
#[test]
fn mapped_chain_past_the_cap_is_refused_and_recorded() {
    let (profiles, skipped) = extract_profiles_with_diagnostics(&chain(MAX_MAPPED_ITEM_DEPTH + 1), 0);
    assert!(profiles.is_empty(), "{profiles:?}");
    assert_eq!(skipped.len(), 1, "one refusal, one record: {skipped:?}");
    assert_eq!(skipped[0].express_id, 100);
    assert!(skipped[0].reason.contains("maximum depth"), "{skipped:?}");
}

/// A map whose representation holds an extrusion AND a mapped item back into
/// the same map is a cycle. The walk refuses it at the first repeat and records
/// it; the old depth cap instead re-drew the extrusion once per level (4x)
/// before giving up.
#[test]
fn mapped_cycle_is_refused_and_recorded() {
    // #1000's own mapped representation holds #1000 again.
    let entities = format!(
        "{TARGET}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','MappedRepresentation',(#1000));\n{}",
        mapped(1000, "#240,#1000")
    );
    let (profiles, skipped) = extract_profiles_with_diagnostics(&wall("#160", &entities), 0);
    assert_eq!(profiles.len(), 1, "the extrusion inside the cycle draws exactly once: {profiles:?}");
    assert_eq!(skipped.len(), 1, "the cycle is recorded once: {skipped:?}");
    assert_eq!(skipped[0].express_id, 100);
    assert!(skipped[0].reason.contains("cyclic"), "the record names the cycle: {skipped:?}");
}

/// The mesh path selects on the effective RepresentationType, so a solid
/// filed under any identifier renders; the identifier filter dropped it.
#[test]
fn representations_meshed_under_other_identifiers_draw() {
    for rep in [
        "#150=IFCSHAPEREPRESENTATION(#13,'Model','SweptSolid',(#140));",
        "#150=IFCSHAPEREPRESENTATION(#13,$,'SweptSolid',(#140));",
        "#150=IFCSHAPEREPRESENTATION(#13,'Body','',(#140));",
    ] {
        let (profiles, skipped) = extract_profiles_with_diagnostics(&wall("#150", rep), 0);
        assert_eq!(profiles.len(), 1, "{rep} renders, so it draws: {skipped:?}");
        assert!(skipped.is_empty(), "{skipped:?}");
    }
}

/// And the converse: a representation the mesh path does not render (a
/// footprint) is not drawn, whatever its identifier says.
#[test]
fn representations_the_mesh_path_skips_are_not_drawn() {
    let rep = "#150=IFCSHAPEREPRESENTATION(#13,'Body','Curve2D',(#140));";
    let (profiles, skipped) = extract_profiles_with_diagnostics(&wall("#150", rep), 0);
    assert!(profiles.is_empty(), "{profiles:?}");
    assert!(skipped.is_empty(), "a deliberate exclusion is not a drop: {skipped:?}");
}
