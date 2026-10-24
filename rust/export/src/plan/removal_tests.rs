// SPDX-License-Identifier: MPL-2.0
//! The removals a plan reports: every record it drops, once, by id, with the
//! reason it went. Synthetic fixtures only.

use std::collections::HashMap;

use super::{Removal, RemovalReason};
use crate::plan::test_fixtures::{host_with_port_type_and_body, wall_with_own_pset};
use crate::plan::types::*;
use crate::plan::{execute, GeometryPatch, PlacementPatch, TriangleMesh};

const SCHEMAS: [&str; 2] = ["IFC2X3", "IFC4"];

fn run(content: &[u8], dispositions: Vec<(ObjectRef, Disposition)>) -> WriteReport {
    let mut out = Vec::new();
    execute(content, &ExportPlan::new(dispositions), &mut out).expect("execute")
}

/// Reported once each, sorted, one per removed record.
fn by_id(report: &WriteReport) -> HashMap<u32, RemovalReason> {
    let ids: Vec<u32> = report.removed.iter().map(|r| r.express_id).collect();
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "sorted and unique: {ids:?}");
    assert_eq!(report.removed.len(), report.deleted);
    report.removed.iter().map(|r| (r.express_id, r.reason)).collect()
}

#[test]
fn deleting_a_host_reports_why_each_record_went() {
    use RemovalReason::*;
    for schema in SCHEMAS {
        let report = run(&host_with_port_type_and_body(schema), vec![(ObjectRef::Id(10), Disposition::Delete)]);
        let reasons = by_id(&report);
        let want = [
            (10, Requested),
            // Its voids relationship names it through a single-valued slot.
            (71, Dangling),
            // The opening it hosted.
            (70, Unhosted),
            // Relationships whose only related object it was.
            (43, Emptied),
            (35, Emptied),
            // What only it used.
            (34, Released),
            (33, Released),
            (60, Released),
        ];
        for (id, reason) in want {
            assert_eq!(reasons.get(&id), Some(&reason), "{schema}: #{id} in {reasons:?}");
        }
        assert!(!reasons.contains_key(&11) && !reasons.contains_key(&14) && !reasons.contains_key(&40), "{schema}: kept objects are not reported");
    }
}

#[test]
fn what_a_patch_replaces_is_reported_as_replaced() {
    for schema in SCHEMAS {
        let content = wall_with_own_pset(schema);
        let moved = Patch::new().with_placement(PlacementPatch::new([[1.0, 0.0, 0.0, 2.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]));
        let report = run(&content, vec![(ObjectRef::Id(10), Disposition::Patch(moved))]);
        let reasons = by_id(&report);
        assert!(!reasons.is_empty(), "{schema}: the old placement records go");
        assert!(reasons.values().all(|&r| r == RemovalReason::Replaced), "{schema}: {reasons:?}");

        let mesh = TriangleMesh::new(vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]]);
        let reshaped = Patch::new().with_geometry(GeometryPatch::new(mesh));
        let report = run(&host_with_port_type_and_body(schema), vec![(ObjectRef::Id(10), Disposition::Patch(reshaped))]);
        let reasons = by_id(&report);
        assert_eq!(reasons.get(&60), Some(&RemovalReason::Replaced), "{schema}: the old body: {reasons:?}");
        assert!(reasons.values().all(|&r| r == RemovalReason::Replaced), "{schema}: {reasons:?}");
    }
}

#[test]
fn a_removal_compares_by_value() {
    assert_eq!(Removal::new(5, RemovalReason::Released), Removal::new(5, RemovalReason::Released));
}

/// An annotation of the old body the sweep deletes (a styled item) is
/// reported as replaced, not as requested.
#[test]
fn a_swept_annotation_is_replaced_not_requested() {
    for schema in SCHEMAS {
        let styled = crate::plan::attrs::build_record(schema, 90, "IFCSTYLEDITEM", &[("Item", "#62".into()), ("Styles", "(#91)".into())]);
        let style = crate::plan::attrs::build_record(schema, 91, "IFCSURFACESTYLE", &[("Side", ".BOTH.".into()), ("Styles", "(#92)".into())]);
        let colour = crate::plan::attrs::build_record(schema, 92, "IFCSURFACESTYLESHADING", &[("SurfaceColour", "#93".into())]);
        let rgb = crate::plan::attrs::build_record(schema, 93, "IFCCOLOURRGB", &[("Red", "1.".into()), ("Green", "0.".into()), ("Blue", "0.".into())]);
        let content = String::from_utf8(host_with_port_type_and_body(schema))
            .unwrap()
            .replacen("ENDSEC;\nEND-ISO", &format!("{styled}\n{style}\n{colour}\n{rgb}\nENDSEC;\nEND-ISO"), 1);
        let mesh = TriangleMesh::new(vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]]);
        let report = run(content.as_bytes(), vec![(ObjectRef::Id(10), Disposition::Patch(Patch::new().with_geometry(GeometryPatch::new(mesh))))]);
        let reasons = by_id(&report);
        assert_eq!(reasons.get(&90), Some(&RemovalReason::Replaced), "{schema}: {reasons:?}");
    }
}
