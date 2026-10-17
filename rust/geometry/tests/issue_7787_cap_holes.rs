// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7787: cap triangulation was superlinear on repeated or overlapping profile
//! voids. `IfcArbitraryProfileDefWithVoids.InnerCurves` can list one
//! `IfcCircle` N times at ~4 bytes per void; 200 of them stalled an extrusion
//! cap for ~10 s, a sectioned cap for ~26 s (minutes at 1000), because
//! earcutr bridges coincident rings. Every cap that triangulates holes goes
//! through the one `safe_earcut`, which now drops exact duplicate rings,
//! refuses overlapping or nested ones (D3) and bounds its pairwise work.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Point2, Profile2D};
use std::time::{Duration, Instant};

/// A regular `n`-gon ring of radius `r` about `(cx, cy)`.
fn ring(cx: f64, cy: f64, r: f64, n: usize) -> Vec<Point2<f64>> {
    (0..n)
        .map(|k| {
            let t = std::f64::consts::TAU * k as f64 / n as f64;
            Point2::new(cx + r * t.cos(), cy + r * t.sin())
        })
        .collect()
}

/// The profile cap triangulation every swept cap uses (extrusion, tapered,
/// revolve, sectioned), through the public `Profile2D`. Indices address
/// `outer ++ holes`.
fn triangulate_polygon_with_holes(
    outer: &[Point2<f64>],
    holes: &[Vec<Point2<f64>>],
) -> Result<Vec<usize>, String> {
    let mut profile = Profile2D::new(outer.to_vec());
    for hole in holes {
        profile.add_hole(hole.clone());
    }
    profile.triangulate().map(|t| t.indices).map_err(|e| e.to_string())
}

/// Area covered by the triangles `idx` over `[outer ++ holes]`.
fn covered_area(outer: &[Point2<f64>], holes: &[Vec<Point2<f64>>], idx: &[usize]) -> f64 {
    let all: Vec<Point2<f64>> = outer.iter().chain(holes.iter().flatten()).copied().collect();
    idx.chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (all[t[0]], all[t[1]], all[t[2]]);
            ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs() / 2.0
        })
        .sum()
}

fn polygon_area(p: &[Point2<f64>]) -> f64 {
    (0..p.len())
        .map(|i| {
            let (a, b) = (p[i], p[(i + 1) % p.len()]);
            a.x * b.y - b.x * a.y
        })
        .sum::<f64>()
        .abs()
        / 2.0
}

#[test]
fn n_identical_holes_triangulate_as_one_hole_7787() {
    let outer = ring(0.0, 0.0, 2.0, 32);
    let hole = ring(0.0, 0.0, 0.5, 32);
    let expected = polygon_area(&outer) - polygon_area(&hole);

    let holes: Vec<Vec<Point2<f64>>> = vec![hole; 200];
    let started = Instant::now();
    let idx = triangulate_polygon_with_holes(&outer, &holes).expect("duplicates are one hole");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "200 identical holes took {:?} (superlinear)",
        started.elapsed()
    );
    let area = covered_area(&outer, &holes, &idx);
    assert!((area - expected).abs() < 1e-9, "area {area}, expected {expected}");
}

#[test]
fn duplicate_hole_rotated_or_reversed_is_still_a_duplicate_7787() {
    let outer = ring(0.0, 0.0, 2.0, 16);
    let hole = ring(0.0, 0.0, 0.5, 16);
    let mut rotated = hole.clone();
    rotated.rotate_left(5);
    let mut reversed = hole.clone();
    reversed.reverse();
    let holes = vec![hole.clone(), rotated, reversed];
    let idx = triangulate_polygon_with_holes(&outer, &holes).expect("duplicates are one hole");
    let expected = polygon_area(&outer) - polygon_area(&hole);
    assert!((covered_area(&outer, &holes, &idx) - expected).abs() < 1e-9);
}

#[test]
fn overlapping_holes_refuse_the_cap_7787() {
    let outer = ring(0.0, 0.0, 4.0, 32);
    // 40 circles whose centres step 0.05 apart: every neighbour overlaps.
    let holes: Vec<Vec<Point2<f64>>> =
        (0..40).map(|k| ring(k as f64 * 0.05, 0.0, 0.5, 24)).collect();
    let started = Instant::now();
    assert!(triangulate_polygon_with_holes(&outer, &holes).is_err());
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
}

#[test]
fn a_hole_nested_in_a_hole_refuses_the_cap_7787() {
    let outer = ring(0.0, 0.0, 4.0, 32);
    let holes = vec![ring(0.0, 0.0, 2.0, 24), ring(0.0, 0.0, 1.0, 24)];
    assert!(triangulate_polygon_with_holes(&outer, &holes).is_err());
}

/// Holes that share an edge (adjacent openings) are NOT overlapping, and a
/// grid of thousands of disjoint holes stays fast: the realistic cases the
/// overlap check must leave alone.
#[test]
fn touching_and_gridded_holes_are_untouched_7787() {
    let outer = vec![
        Point2::new(0.0, 0.0),
        Point2::new(10.0, 0.0),
        Point2::new(10.0, 10.0),
        Point2::new(0.0, 10.0),
    ];
    let a = vec![Point2::new(1.0, 1.0), Point2::new(2.0, 1.0), Point2::new(2.0, 2.0), Point2::new(1.0, 2.0)];
    let b = vec![Point2::new(2.0, 1.0), Point2::new(3.0, 1.0), Point2::new(3.0, 2.0), Point2::new(2.0, 2.0)];
    let holes = vec![a, b];
    let idx = triangulate_polygon_with_holes(&outer, &holes).expect("shared edge is not overlap");
    assert!((covered_area(&outer, &holes, &idx) - 98.0).abs() < 1e-9);

    let big = vec![
        Point2::new(0.0, 0.0),
        Point2::new(600.0, 0.0),
        Point2::new(600.0, 600.0),
        Point2::new(0.0, 600.0),
    ];
    let grid: Vec<Vec<Point2<f64>>> = (0..50)
        .flat_map(|i| (0..50).map(move |j| ring(5.0 + i as f64 * 10.0, 5.0 + j as f64 * 10.0, 2.0, 8)))
        .collect();
    let started = Instant::now();
    let idx = triangulate_polygon_with_holes(&big, &grid).expect("disjoint grid triangulates");
    assert!(!idx.is_empty());
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
}

fn extrusion_with_voids(n: usize, offset_step: f64) -> String {
    let mut s = String::from(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCAXIS2PLACEMENT2D(#1,$);\n#3=IFCCIRCLE(#2,2.);\n\
         #4=IFCCARTESIANPOINT((0.,0.,0.));\n#5=IFCAXIS2PLACEMENT3D(#4,$,$);\n#6=IFCDIRECTION((0.,0.,1.));\n",
    );
    let mut voids = Vec::new();
    for k in 0..n {
        if offset_step == 0.0 {
            voids.push("#9".to_string());
        } else {
            let id = 100 + 3 * k;
            s.push_str(&format!(
                "#{id}=IFCCARTESIANPOINT(({:.4},0.));\n#{}=IFCAXIS2PLACEMENT2D(#{id},$);\n#{}=IFCCIRCLE(#{},0.5);\n",
                k as f64 * offset_step,
                id + 1,
                id + 2,
                id + 1
            ));
            voids.push(format!("#{}", id + 2));
        }
    }
    s.push_str("#7=IFCCARTESIANPOINT((0.,0.));\n#8=IFCAXIS2PLACEMENT2D(#7,$);\n#9=IFCCIRCLE(#8,0.5);\n");
    s.push_str(&format!(
        "#10=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#3,({}));\n#11=IFCEXTRUDEDAREASOLID(#10,#5,#6,1.);\n",
        voids.join(",")
    ));
    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

/// (triangle count, elapsed, refused) for `#11`: a refused cap is an `Err`
/// from the item processor, which the element walks count as a dropped item
/// (D3, `router::instancing`'s Err arm).
fn extrude(content: &str) -> (usize, Duration, bool) {
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(11).expect("decode");
    let started = Instant::now();
    let result = router.process_representation_item(&entity, &mut decoder);
    let elapsed = started.elapsed();
    (result.as_ref().map_or(0, |m| m.indices.len() / 3), elapsed, result.is_err())
}

#[test]
fn extruded_profile_with_200_identical_voids_matches_one_void_7787() {
    let (one, _, _) = extrude(&extrusion_with_voids(1, 0.0));
    let (many, elapsed, refused) = extrude(&extrusion_with_voids(200, 0.0));
    assert!(elapsed < Duration::from_secs(3), "200 identical voids took {elapsed:?}");
    assert!(!refused);
    // Caps match the one-void profile; the duplicated void walls are the only
    // extra geometry, so the many-void mesh has at least the one-void caps.
    assert!(many >= one && one > 0, "one {one}, many {many}");
}

#[test]
fn extruded_profile_with_overlapping_voids_is_refused_7787() {
    let (tris, elapsed, refused) = extrude(&extrusion_with_voids(200, 0.01));
    assert_eq!((tris, refused), (0, true));
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
}
