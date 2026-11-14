// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The analytic prism cut on hosts that are axis-aligned.
//!
//! `various/rvt01.ifc` sits under a site rotated 48 degrees, so its walls
//! reach the cut with f32 vertices scattered about every face plane. Put the
//! site at the origin and the same walls are exactly axis-aligned: a cutter
//! face flush with a host face then lies half an f32 step from it all the way
//! along, and the cut bridges that gap with zero-area triangles. These hosts
//! came back with open edges from that input and closed from the rotated one.

#[path = "corpus/rtc_frame.rs"]
mod census_rtc;

use census_rtc::ModelFrame;
use ifc_lite_core::{EntityDecoder, EntityScanner};
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::mesh_check::{Degenerate, EdgeLedger, VertexKey};
use ifc_lite_geometry::{propagate_voids_to_parts, Mesh};
use rustc_hash::FxHashMap;

const FIXTURE: &str = "various/rvt01.ifc";
/// The site's placement, the root of every placement chain in the file.
const SITE_PLACEMENT: &str = "#151=IFCLOCALPLACEMENT($,#150);";

/// The fixture with its site placed at the origin, unrotated.
fn site_at_origin() -> Option<String> {
    let content = ifc_lite_testkit::fixture_text(FIXTURE)?;
    assert!(content.contains(SITE_PLACEMENT), "the fixture's site placement moved");
    let origin = "#151=IFCLOCALPLACEMENT($,#9000001);\n\
                  #9000001=IFCAXIS2PLACEMENT3D(#9000002,$,$);\n\
                  #9000002=IFCCARTESIANPOINT((0.,0.,0.));";
    Some(content.replacen(SITE_PLACEMENT, origin, 1))
}

fn void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut decoder = EntityDecoder::new(content);
    let mut index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((_id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCRELVOIDSELEMENT" {
            continue;
        }
        if let Ok(entity) = decoder.decode_at(start, end) {
            if let (Some(host), Some(opening)) = (entity.get_ref(4), entity.get_ref(5)) {
                index.entry(host).or_default().push(opening);
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut index, content, &mut decoder);
    index
}

fn cut(content: &str, host: u32) -> Mesh {
    let frame = ModelFrame::new(content);
    let mut decoder = frame.decoder();
    let entity = decoder.decode_by_id(host).expect("host decodes");
    let router = frame.router(&mut decoder);
    router.process_element_with_voids(&entity, &mut decoder, &void_index(content)).expect("host meshes")
}

/// Open boundary edges as the watertightness census reads them: the signed
/// per-edge balance on a 1 mm grid, collapsed triangles skipped.
fn open_edges(mesh: &Mesh) -> usize {
    EdgeLedger::build(mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle).unbalanced().count()
}

/// Walls whose opening has a face flush with a face of the wall. The cut
/// leaves zero-area triangles along it; the sliver refinement bisected them,
/// and the final cleanup dropped the pieces without closing the T-junctions
/// (#6934: 33 open edges, #7700: 10). Volumes are IfcOpenShell 0.8.2's.
#[test]
fn flush_opening_faces_leave_axis_aligned_walls_closed() {
    let Some(content) = site_at_origin() else {
        eprintln!("Skipping: run pnpm fixtures");
        return;
    };
    for (host, reference_m3) in [(6934, 3.552_926), (7700, 0.266_116)] {
        let mesh = cut(&content, host);
        assert_eq!(open_edges(&mesh), 0, "#{host} must stay closed");
        let volume = mesh_volume(&mesh);
        assert!(
            (volume - reference_m3).abs() < 2.0e-4,
            "#{host} volume {volume} m3 against the reference {reference_m3}"
        );
    }
}
