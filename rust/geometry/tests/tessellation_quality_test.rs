// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Consumer-configurable tessellation quality (issue #976).
//!
//! The quality knob deliberately splits two worlds:
//!
//! * **Profile-plane tessellation** (extruded caps / opening cutters) is pinned
//!   to the historical fixed density at every level — denser opening circles
//!   only multiply earcut cap-bridge slivers on plates with bolt holes. The
//!   `IfcCircleProfileDef` outline therefore stays at 36 segments regardless of
//!   the requested level.
//! * **Curved 3D surfaces** (swept pipes, cylinders, NURBS, brep edges) DO scale
//!   — that is where faceting is visible. A swept-disk tube's ring count must
//!   rise monotonically across levels.

use ifc_lite_core::{EntityDecoder, IfcSchema};
use ifc_lite_geometry::{GeometryRouter, ProfileProcessor, TessellationQuality};

/// IfcCircleProfileDef(ProfileType, ProfileName, Position, Radius).
const CIRCLE_PROFILE: &str = r#"
#1=IFCCIRCLEPROFILEDEF(.AREA.,$,$,10.0);
"#;

/// A straight swept-disk solid (pipe): directrix polyline + radius. The tube
/// ring count is what scales with quality.
const SWEPT_DISK: &str = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,0.0,1000.0));
#3=IFCPOLYLINE((#1,#2));
#4=IFCSWEPTDISKSOLID(#3,50.0,$,$,$);
"#;

const LEVELS: [TessellationQuality; 5] = [
    TessellationQuality::Lowest,
    TessellationQuality::Low,
    TessellationQuality::Medium,
    TessellationQuality::High,
    TessellationQuality::Highest,
];

fn circle_profile_segments(q: TessellationQuality) -> usize {
    let mut decoder = EntityDecoder::new(CIRCLE_PROFILE);
    let processor = ProfileProcessor::new(IfcSchema::new());
    let entity = decoder.decode_by_id(1).expect("decode circle profile");
    processor
        .process(&entity, &mut decoder, q)
        .expect("process circle profile")
        .outer
        .len()
}

fn swept_disk_vertices(q: TessellationQuality) -> usize {
    let mut decoder = EntityDecoder::new(SWEPT_DISK);
    let router = GeometryRouter::with_quality(q);
    let item = decoder.decode_by_id(4).expect("decode swept disk");
    let mesh = router
        .process_representation_item(&item, &mut decoder)
        .expect("route swept disk");
    mesh.positions.len() / 3
}

#[test]
fn default_router_quality_is_medium() {
    assert_eq!(
        GeometryRouter::new().tessellation_quality(),
        TessellationQuality::Medium
    );
}

#[test]
fn profile_circle_coarsens_below_medium_and_never_exceeds_36() {
    // Opening/profile circles: 8/16 segments at Lowest/Low (preview), the
    // historical 36 at Medium, and NO finer above Medium (denser caps only add
    // earcut bridge slivers on plates with bolt holes). issue #976.
    let expected = [
        (TessellationQuality::Lowest, 8usize),
        (TessellationQuality::Low, 16),
        (TessellationQuality::Medium, 36),
        (TessellationQuality::High, 36),
        (TessellationQuality::Highest, 36),
    ];
    for (q, want) in expected {
        assert_eq!(
            circle_profile_segments(q),
            want,
            "circle profile segments at {q:?}"
        );
    }
}

#[test]
fn swept_pipe_scales_monotonically() {
    // Curved surfaces DO scale: the tube ring count (and thus vertex count) of a
    // swept-disk pipe must be non-decreasing across levels and strictly larger
    // at Highest than Lowest.
    let counts: Vec<usize> = LEVELS.iter().map(|&q| swept_disk_vertices(q)).collect();
    for w in counts.windows(2) {
        assert!(
            w[0] <= w[1],
            "swept-pipe vertex counts must be non-decreasing: {counts:?}"
        );
    }
    assert!(
        counts.first() < counts.last(),
        "expected more vertices at Highest than Lowest: {counts:?}"
    );
}

#[test]
fn swept_pipe_medium_matches_default_router() {
    // The explicit-Medium router and the default router must agree on the pipe's
    // vertex count (no divergence introduced by the enum).
    let default_count = {
        let mut decoder = EntityDecoder::new(SWEPT_DISK);
        let router = GeometryRouter::new();
        let item = decoder.decode_by_id(4).expect("decode swept disk");
        router
            .process_representation_item(&item, &mut decoder)
            .expect("route swept disk")
            .positions
            .len()
            / 3
    };
    assert_eq!(default_count, swept_disk_vertices(TessellationQuality::Medium));
}

#[test]
fn unset_quality_is_byte_identical_to_medium() {
    // The epic's regression guarantee (#976 step 5): a consumer that never
    // selects a level must get output BYTE-FOR-BYTE identical to explicit
    // Medium — positions, normals and indices compared bitwise, not by
    // float-epsilon.
    let route = |router: GeometryRouter| {
        let mut decoder = EntityDecoder::new(SWEPT_DISK);
        let item = decoder.decode_by_id(4).expect("decode swept disk");
        router
            .process_representation_item(&item, &mut decoder)
            .expect("route swept disk")
    };
    let unset = route(GeometryRouter::new());
    let medium = route(GeometryRouter::with_quality(TessellationQuality::Medium));

    let bits = |v: &[f32]| v.iter().map(|f| f.to_bits()).collect::<Vec<u32>>();
    assert_eq!(
        bits(&unset.positions),
        bits(&medium.positions),
        "positions must be bitwise identical when quality is unset"
    );
    assert_eq!(
        bits(&unset.normals),
        bits(&medium.normals),
        "normals must be bitwise identical when quality is unset"
    );
    assert_eq!(
        unset.indices, medium.indices,
        "indices must be identical when quality is unset"
    );
}
