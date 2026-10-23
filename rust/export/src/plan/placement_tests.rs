// SPDX-License-Identifier: MPL-2.0
use crate::plan::index::FileIndex;
use crate::step_ids::IdAllocator;
use super::resolve_placement;
use crate::plan::test_fixtures::{gid, two_walls_sharing_a_pset, wall_with_own_pset};
use crate::plan::types::PlacementPatch;

fn identity_shifted(x: f64) -> PlacementPatch {
    PlacementPatch {
        matrix: [
            [1.0, 0.0, 0.0, x],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
    }
}

#[test]
fn rewrites_an_unshared_local_placement_by_appending_a_fresh_axis_placement() {
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let content = wall_with_own_pset(schema);
        let index = FileIndex::complete(&content);
        let mut ids = IdAllocator::after(index.max_id);
        let write = resolve_placement(&index, schema, 10, &identity_shifted(5.0), &mut ids).expect(schema);

        assert_eq!(write.new_records.len(), 4, "{schema}: point, axis dir, ref dir, axis placement");
        let (_, cp_text) = &write.new_records[0];
        assert!(cp_text.contains("IFCCARTESIANPOINT((5.,0.,0.))"), "{schema}: {cp_text}");
        let (placement_id, idx, value) = write.repoint;
        assert_eq!(placement_id, 20, "{schema}: the wall's own IfcLocalPlacement");
        let new_id = value.trim_start_matches('#').parse::<u32>().unwrap();
        assert_eq!(write.new_records.last().unwrap().0, new_id);
        assert!(idx > 0, "{schema}: RelativePlacement, never PlacementRelTo");

        // (2) The old, now-unreferenced chain (#21 axis placement, #22
        // point) is swept — never the always-there project (#1).
        assert!(write.orphaned.contains(&21), "{schema}: old axis placement orphaned");
        assert!(write.orphaned.contains(&22), "{schema}: old point orphaned transitively");
        assert!(!write.orphaned.contains(&1), "{schema}: the project is never swept");
    }
}

/// (2) The orphan sweep prunes only what THIS patch orphaned: a point the
/// old axis placement shares with something else survives, and nothing
/// already unreferenced before the patch is touched.
#[test]
fn placement_sweep_never_takes_a_still_shared_sub_record() {
    let schema = "IFC4";
    // #22 (the old placement's point) is also used by a second,
    // independent IfcCartesianPoint reference: a synthetic
    // IfcRelDefinesByProperties'-style stand-in isn't realistic for a
    // point, so instead this shares it as the origin of a SECOND axis
    // placement (#26) nothing in this patch touches.
    let content = String::from_utf8(wall_with_own_pset(schema))
        .unwrap()
        .replace(
            "#22=IFCCARTESIANPOINT((0.,0.,0.));\n",
            "#22=IFCCARTESIANPOINT((0.,0.,0.));\n#26=IFCAXIS2PLACEMENT3D(#22,$,$);\n",
        )
        .into_bytes();
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let write = resolve_placement(&index, schema, 10, &identity_shifted(2.0), &mut ids).unwrap();

    assert!(write.orphaned.contains(&21), "the old axis placement is still orphaned");
    assert!(!write.orphaned.contains(&22), "the point is shared by #26, so it must survive");
}

#[test]
fn refuses_a_local_placement_shared_by_two_products() {
    let schema = "IFC4";
    // Make #20 shared by pointing wall #11's ObjectPlacement at it too.
    let from = format!("#11=IFCWALL('{}',$,'Wall 2',$,$,#23,$,$,$);", gid(11));
    let to = format!("#11=IFCWALL('{}',$,'Wall 2',$,$,#20,$,$,$);", gid(11));
    let content = String::from_utf8(two_walls_sharing_a_pset(schema)).unwrap().replace(&from, &to).into_bytes();
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let err = resolve_placement(&index, schema, 10, &identity_shifted(1.0), &mut ids).unwrap_err();
    assert!(err.contains("shared"), "{err}");
}

#[test]
fn refuses_grid_placement_with_a_reason() {
    let schema = "IFC4";
    let content = String::from_utf8(wall_with_own_pset(schema))
        .unwrap()
        .replace("#20=IFCLOCALPLACEMENT($,#21);", "#20=IFCGRIDPLACEMENT((#23,#24),$);\n#23=IFCVIRTUALGRIDINTERSECTION((#24),(0.));\n#24=IFCGRIDAXIS('A',$,.T.);")
        .into_bytes();
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let err = resolve_placement(&index, schema, 10, &identity_shifted(1.0), &mut ids).unwrap_err();
    assert!(err.contains("IfcGridPlacement"), "{err}");
}

/// A point the old axis placement shares with a surface's nested control
/// point list is still in use, so moving the wall keeps it.
#[test]
fn a_point_a_nested_list_also_names_is_not_swept() {
    let schema = "IFC4";
    let surface = "#95=IFCBSPLINESURFACE(1,1,((#22,#22),(#22,#22)),.UNSPECIFIED.,.F.,.F.,.F.);\n";
    let content = String::from_utf8(wall_with_own_pset(schema)).unwrap().replace("ENDSEC;\nEND-ISO", &format!("{surface}ENDSEC;\nEND-ISO"));
    assert!(content.contains("#95="), "the surface is in the fixture");
    let mut index = FileIndex::scan(content.as_bytes(), &Default::default());
    let mut ids = IdAllocator::after(index.max_id);
    let write = loop {
        let write = resolve_placement(&index, schema, 10, &identity_shifted(1.0), &mut ids).unwrap();
        if !index.collect_missing_referrers() {
            break write;
        }
        ids = IdAllocator::after(index.max_id);
    };
    assert!(write.orphaned.contains(&21), "the old axis placement goes: {:?}", write.orphaned);
    assert!(!write.orphaned.contains(&22), "the surface still names the point: {:?}", write.orphaned);
}

/// A reflection, a scale or a projective row has no IfcAxis2Placement3D form.
#[test]
fn refuses_a_matrix_that_is_not_a_rotation_and_a_translation() {
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let index = FileIndex::complete(&content);
    let identity = identity_shifted(0.0).matrix;
    let mut mirrored = identity;
    mirrored[1][1] = -1.0;
    let mut scaled = identity;
    scaled[0][0] = 2.0;
    let mut projective = identity;
    projective[3][0] = 0.5;
    for matrix in [mirrored, scaled, projective] {
        let mut ids = IdAllocator::after(index.max_id);
        let err = resolve_placement(&index, schema, 10, &PlacementPatch { matrix }, &mut ids).unwrap_err();
        assert!(err.contains("not a rotation"), "{matrix:?}: {err}");
    }
}

/// Rounding noise in a computed matrix's bottom row is still a rigid placement.
#[test]
fn accepts_rounding_noise_in_the_bottom_row() {
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let index = FileIndex::complete(&content);
    let mut matrix = identity_shifted(1.0).matrix;
    matrix[3] = [0.0, 0.0, 1e-17, 0.999_999_999_999_999_9];
    let mut ids = IdAllocator::after(index.max_id);
    assert!(resolve_placement(&index, schema, 10, &PlacementPatch { matrix }, &mut ids).is_ok());
}
