// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The streaming pre-pass stashes `IfcMappedItem` and `IfcTypeProduct`
//! candidate spans during its one scan; `collect_type_geometry_jobs_from_spans`
//! reuses them instead of re-walking the file. These are the two-paths-that-
//! must-agree tests for that twin, plus the #3187 legacy-keyword fixtures that
//! make the widened gate distinguishable from the pre-#3187 one.
//!
//! Split out of `prepass.rs` to keep that module under its size ratchet.
use super::collect_type_geometry_jobs_from_spans;
use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};

/// Build the mapped-item + type-candidate spans exactly as the streaming
/// pre-pass scan does. Callers assert fixed expected job counts below.
fn assert_match(content: &[u8]) -> usize {
    let index = std::sync::Arc::new(build_entity_index(content));
    let mut mapped: Vec<(u32, usize, usize)> = Vec::new();
    let mut defines: Vec<(u32, usize, usize)> = Vec::new();
    let mut cands: Vec<(u32, usize, usize, IfcType)> = Vec::new();
    let mut sc = EntityScanner::new(content);
    while let Some((id, tn, st, en)) = sc.next_entity() {
        if tn == "IFCMAPPEDITEM" {
            mapped.push((id, st, en));
        } else if tn == "IFCRELDEFINESBYTYPE" {
            defines.push((id, st, en));
        } else if let Some(t) = ifc_lite_core::type_product_ifc_type(tn) {
            cands.push((id, st, en, t));
        }
    }
    let mut d2 = EntityDecoder::with_arc_index(content, index);
    let new = collect_type_geometry_jobs_from_spans(content, &mapped, &cands, &mut d2);
    for mode in [
        ifc_lite_processing::element::TypeGeometryMode::EmitTagged,
        ifc_lite_processing::element::TypeGeometryMode::SuppressInstanced,
    ] {
        let mut d3 = EntityDecoder::with_index(content, build_entity_index(content));
        let plan = ifc_lite_processing::discovery::TypeGeometryPlan::from_spans(
            content, &mapped, &defines, &cands, &mut d3, mode,
        );
        if mode == ifc_lite_processing::element::TypeGeometryMode::EmitTagged {
            assert_eq!(new, plan.jobs());
            let mut early_decoder = EntityDecoder::with_index(content, build_entity_index(content));
            let mut deferred = ifc_lite_processing::discovery::TypeGeometryPlan::from_spans(
                content, &mapped, &defines, &[], &mut early_decoder, mode,
            );
            assert!(deferred.jobs().is_empty(), "columns and first jobs precede type decoding");
            deferred.decode_products(content, &cands, &mut early_decoder);
            assert_eq!(deferred.jobs(), new);
        }
        let mut d4 = EntityDecoder::with_index(content, build_entity_index(content));
        let fallback = ifc_lite_processing::discovery::TypeGeometryPlan::from_file(
            content, &mut d4, mode,
        );
        assert_eq!(plan.referenced_representation_maps, fallback.referenced_representation_maps);
        assert_eq!(plan.instantiated_type_ids, fallback.instantiated_type_ids);
        assert_eq!(plan.mapped_item_plan, fallback.mapped_item_plan);
    }
    new.len()
}

#[test]
fn c4_7a_7782_bare_type_map_matches_native_and_typed_wrapper_is_refused() {
    let source = include_str!("../../../../processing/tests/fixtures/c4_bare_type_map_7782.ifc");
    assert_eq!(assert_match(source.as_bytes()), 1);
    let wrapped = source.replace("#44,$,$,.NOTDEFINED.", "IFCREPRESENTATIONMAP(#44),$,$,.NOTDEFINED.");
    assert_eq!(assert_match(wrapped.as_bytes()), 0);
    assert_eq!(assert_match(include_bytes!("../../../../processing/tests/fixtures/c4_type_geometry_modes_7782.ifc")), 2);
}

// An IfcColumnType carrying a RepresentationMap that NO IfcMappedItem
// references — the #957 orphan-type-geometry case (renders the type's map
// directly). RepresentationMaps is IfcTypeProduct attr 6.
const ORPHAN: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000A',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#10=IFCREPRESENTATIONMAP(#5,#12);
#12=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#13));
#13=IFCTRIANGULATEDFACESET(#8,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#20=IFCCOLUMNTYPE('0ColType00000000000A',$,'ColType',$,$,$,(#10),$,$,.COLUMN.);
ENDSEC;
END-ISO-10303-21;
"#;

// Same, but an IfcMappedItem references the map — the map is drawn through
// the occurrence, so the type yields NO orphan job (filtered out).
const REFERENCED: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000A',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#10=IFCREPRESENTATIONMAP(#5,#12);
#12=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#13));
#13=IFCTRIANGULATEDFACESET(#8,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#20=IFCCOLUMNTYPE('0ColType00000000000A',$,'ColType',$,$,$,(#10),$,$,.COLUMN.);
#30=IFCMAPPEDITEM(#10,#31);
#31=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

// #3187: the same two shapes, but with an IFC2X3 `IfcDoorStyle` -- a type
// product IFC4X3 dropped. A bare `IfcType::from_str` answered `Unknown`
// before exact-name support and the pre-#3187 gate discarded it. The
// two fixtures above are both `IFCCOLUMNTYPE`, which the bare and the
// legacy-aware resolver agree on, so neither of them can tell the widened
// gate from the old one. These can.
const LEGACY_ORPHAN: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000A',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#10=IFCREPRESENTATIONMAP(#5,#12);
#12=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#13));
#13=IFCTRIANGULATEDFACESET(#8,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#20=IFCDOORSTYLE('0DoorStyle000000000A',$,'DoorStyle',$,$,$,(#10),$,.NOTDEFINED.,.NOTDEFINED.,.F.,.F.);
ENDSEC;
END-ISO-10303-21;
"#;

const LEGACY_REFERENCED: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000A',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#10=IFCREPRESENTATIONMAP(#5,#12);
#12=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#13));
#13=IFCTRIANGULATEDFACESET(#8,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#20=IFCDOORSTYLE('0DoorStyle000000000A',$,'DoorStyle',$,$,$,(#10),$,.NOTDEFINED.,.NOTDEFINED.,.F.,.F.);
#30=IFCMAPPEDITEM(#10,#31);
#31=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn from_spans_matches_full_scan_orphan_case() {
    let n = assert_match(ORPHAN.as_bytes());
    assert_eq!(n, 1, "the orphan IfcColumnType should yield one type job");
}

#[test]
fn from_spans_matches_full_scan_referenced_case() {
    let n = assert_match(REFERENCED.as_bytes());
    assert_eq!(n, 0, "a referenced RepresentationMap yields no orphan type job");
}

/// #3187 -- both halves of this twin must resolve the LEGACY keyword
/// through `type_product_ifc_type`. It both preserves the pre-#4203 legacy
/// classification now that an exact variant exists and prevents the lost job
/// that occurred when a bare resolver still returned `Unknown`.
#[test]
fn from_spans_matches_full_scan_legacy_orphan_case() {
    let n = assert_match(LEGACY_ORPHAN.as_bytes());
    assert_eq!(
        n, 1,
        "the orphan IFC2X3 IfcDoorStyle should yield one type job, exactly as the \
         IfcColumnType above does"
    );
}

/// The instanced half of the same widening: admitting the legacy keyword
/// must not bypass the referenced-map filter, or the type renders a second
/// copy at the mapping origin on top of its occurrence.
#[test]
fn from_spans_matches_full_scan_legacy_referenced_case() {
    let n = assert_match(LEGACY_REFERENCED.as_bytes());
    assert_eq!(
        n, 0,
        "the legacy type's RepresentationMap is drawn through its IfcMappedItem, so \
         it must not ALSO yield an orphan type job"
    );
}
