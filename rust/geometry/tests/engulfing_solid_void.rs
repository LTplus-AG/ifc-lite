// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression: an `IfcOpeningElement` whose REAL solid fully CONTAINS its host
//! must remove the host entirely (the boolean result is empty).
//!
//! A thin wall panel whose single opening spans the whole panel: the exact
//! subtract no-ops on the coincident shared faces and returns the host
//! re-triangulated at UNCHANGED volume — a spurious solid where the opening
//! should be. The fix detects true solid containment and drops the host.
//!
//! The control wall pins the discriminator: a normal window-sized opening (its
//! AABB sits INSIDE the wall) must still cut a hole and leave the wall standing
//! — the containment guard must not fire for ordinary voids.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const ENGULFED_WALL: u32 = 50;
const NORMAL_WALL: u32 = 150;

const IFC: &str = r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('engulfing-solid void regression'),'2;1');
FILE_NAME('engulf.ifc','2026-06-22T00:00:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#2=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCDIRECTION((0.,0.,1.));
#7=IFCDIRECTION((1.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#5,#6,#7);
#10=IFCUNITASSIGNMENT((#11));
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#8,$);
#1=IFCPROJECT('0proj0000000000000001',#2,'P',$,$,$,$,(#20),#10);
#30=IFCLOCALPLACEMENT($,#8);
#40=IFCCARTESIANPOINT((0.,0.));
#41=IFCDIRECTION((1.,0.));
#42=IFCAXIS2PLACEMENT2D(#40,#41);
/* --- engulfed wall #50: thin 2.0 x 0.1 panel, 3.0 high --- */
#43=IFCRECTANGLEPROFILEDEF(.AREA.,'',#42,2.,0.1);
#44=IFCEXTRUDEDAREASOLID(#43,#8,#6,3.);
#45=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#44));
#46=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));
#50=IFCWALLSTANDARDCASE('engulfedwall00000001',#2,'panel',$,$,#30,#46,'t1');
/* opening #65: 2.4 x 0.3, 3.4 high -> contains the whole panel */
#61=IFCRECTANGLEPROFILEDEF(.AREA.,'',#42,2.4,0.3);
#62=IFCEXTRUDEDAREASOLID(#61,#8,#6,3.4);
#63=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#62));
#64=IFCPRODUCTDEFINITIONSHAPE($,$,(#63));
#65=IFCOPENINGELEMENT('engulfopening000001',#2,'op',$,$,#30,#64,'t2');
#70=IFCRELVOIDSELEMENT('engulfvoid00000001',#2,$,$,#50,#65);
/* --- control wall #150: same panel, normal window-sized opening --- */
#143=IFCRECTANGLEPROFILEDEF(.AREA.,'',#42,2.,0.1);
#144=IFCEXTRUDEDAREASOLID(#143,#8,#6,3.);
#145=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#144));
#146=IFCPRODUCTDEFINITIONSHAPE($,$,(#145));
#150=IFCWALLSTANDARDCASE('normalwall00000001',#2,'wall',$,$,#30,#146,'t3');
/* window opening 0.5 x 0.3 from z=1 to z=2 -> AABB INSIDE the wall */
#180=IFCAXIS2PLACEMENT3D(#181,#6,#7);
#181=IFCCARTESIANPOINT((0.,0.,1.));
#161=IFCRECTANGLEPROFILEDEF(.AREA.,'',#42,0.5,0.3);
#162=IFCEXTRUDEDAREASOLID(#161,#180,#6,1.);
#163=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#162));
#164=IFCPRODUCTDEFINITIONSHAPE($,$,(#163));
#165=IFCOPENINGELEMENT('normalopening00001',#2,'op',$,$,#30,#164,'t4');
#170=IFCRELVOIDSELEMENT('normalvoid0000001',#2,$,$,#150,#165);
ENDSEC;
END-ISO-10303-21;"##;

fn mesh_volume(m: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [
            m.positions[b] as f64,
            m.positions[b + 1] as f64,
            m.positions[b + 2] as f64,
        ]
    };
    (m.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1])
                + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0)
        .abs()
}

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(h), Some(o)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(h).or_default().push(o);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

#[test]
fn engulfing_solid_opening_removes_host_but_window_keeps_wall() {
    let entity_index = build_entity_index(IFC);
    let mut decoder = EntityDecoder::with_index(IFC, entity_index);
    let router = GeometryRouter::with_units(IFC, &mut decoder);
    let void_index = build_void_index(IFC);

    // Both walls have exactly one opening.
    assert_eq!(void_index.get(&ENGULFED_WALL).map(Vec::len), Some(1));
    assert_eq!(void_index.get(&NORMAL_WALL).map(Vec::len), Some(1));

    // --- Engulfed wall: the opening solid contains the whole panel. ---
    let wall = decoder
        .decode_by_id(ENGULFED_WALL)
        .expect("decode engulfed wall");
    let uncut = router
        .process_element(&wall, &mut decoder)
        .expect("process wall");
    assert!(
        (mesh_volume(&uncut) - 0.6).abs() < 0.05,
        "uncut panel volume = {:.4}, expected ~0.6 (2.0 x 0.1 x 3.0)",
        mesh_volume(&uncut)
    );
    let voided = router
        .process_element_with_voids(&wall, &mut decoder, &void_index)
        .expect("process engulfed wall with voids");
    assert!(
        voided.is_empty(),
        "engulfing-solid void must remove the host entirely; \
         got {} tris / {:.4} volume",
        voided.triangle_count(),
        mesh_volume(&voided)
    );
    // The host must be flagged CONSUMED so the element pipeline keeps the empty
    // result instead of falling back to the un-cut host (the bug that made the
    // panel re-appear after the first fix).
    assert!(
        router.host_consumed_by_void(ENGULFED_WALL),
        "engulfed host must be flagged consumed so the un-cut fallback is suppressed"
    );

    // --- Control wall: a window-sized opening must NOT empty the wall. ---
    let nwall = decoder
        .decode_by_id(NORMAL_WALL)
        .expect("decode normal wall");
    let nvoided = router
        .process_element_with_voids(&nwall, &mut decoder, &void_index)
        .expect("process normal wall with voids");
    assert!(
        !nvoided.is_empty() && mesh_volume(&nvoided) > 0.4,
        "a normal window opening must leave the wall standing; got {} tris / {:.4} volume \
         — the containment guard fired on an ordinary void",
        nvoided.triangle_count(),
        mesh_volume(&nvoided)
    );
    assert!(
        !router.host_consumed_by_void(NORMAL_WALL),
        "an ordinary windowed wall must NOT be flagged consumed"
    );
}
