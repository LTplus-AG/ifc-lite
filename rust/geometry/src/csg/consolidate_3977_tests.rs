// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn add_face(mesh: &mut Mesh, points: [Point3<f64>; 3]) {
    let normal = (points[1] - points[0])
        .cross(&(points[2] - points[0]))
        .normalize();
    emit_triangle(mesh, &points, &normal);
}

#[test]
fn raw_plan_is_an_insertion_target_3977() {
    let (a, b, d) = (
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
        Point3::new(0.0, 0.0, 2.0),
    );
    for (start, end) in [(a, b), (b, d), (d, a)] {
        let midpoint = Point3::from((start.coords + end.coords) / 2.0);
        let mut plans = vec![PlanBucket {
            bid: 0,
            normal: Vector3::new(0.0, -1.0, 0.0),
            origin: a,
            u_axis: Vector3::new(1.0, 0.0, 0.0),
            v_axis: Vector3::new(0.0, 0.0, 1.0),
            raw: vec![[a, b, d]],
            raw_conformed: None,
            regions: Vec::new(),
        }];
        let source = PlanBucket {
            bid: 1,
            normal: Vector3::new(0.0, 0.0, 1.0),
            origin: midpoint,
            u_axis: Vector3::new(1.0, 0.0, 0.0),
            v_axis: Vector3::new(0.0, 1.0, 0.0),
            raw: vec![[
                midpoint,
                midpoint + Vector3::new(0.0, 1.0, 0.0),
                midpoint + Vector3::new(0.25, 1.0, 0.25),
            ]],
            raw_conformed: None,
            regions: Vec::new(),
        };
        plans.push(source);
        let seam = build_seam_map(&plans);

        assert!(conform_plans(&mut plans, &seam));
        let triangles = plans[0]
            .raw_conformed
            .as_ref()
            .expect("peer midpoint must conform the raw target");
        let has_edge = |x: Point3<f64>, y: Point3<f64>| {
            triangles.iter().any(|triangle| {
                [(0, 1), (1, 2), (2, 0)].iter().any(|&(i, j)| {
                    (triangle[i] == x && triangle[j] == y) || (triangle[i] == y && triangle[j] == x)
                })
            })
        };
        assert!(has_edge(start, midpoint));
        assert!(has_edge(midpoint, end));
        assert!(!has_edge(start, end), "the unsplit long edge must be gone");
    }
}

#[test]
fn conform_skips_an_empty_plan_3977() {
    let mut plans = vec![PlanBucket {
        bid: 0,
        normal: Vector3::new(0.0, 0.0, 1.0),
        origin: Point3::origin(),
        u_axis: Vector3::new(1.0, 0.0, 0.0),
        v_axis: Vector3::new(0.0, 1.0, 0.0),
        raw: Vec::new(),
        raw_conformed: None,
        regions: Vec::new(),
    }];
    let seam = build_seam_map(&plans);
    assert!(!conform_plans(&mut plans, &seam));
}

#[test]
fn raw_plan_preserves_three_simultaneously_split_edges_3977() {
    let vertices = [
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
        Point3::new(0.0, 0.0, 2.0),
    ];
    let mut split_points = Vec::new();
    for (start, end) in [
        (vertices[0], vertices[1]),
        (vertices[1], vertices[2]),
        (vertices[2], vertices[0]),
    ] {
        split_points.push(Point3::from((start.coords * 2.0 + end.coords) / 3.0));
        split_points.push(Point3::from((start.coords + end.coords * 2.0) / 3.0));
    }
    let mut plans = vec![PlanBucket {
        bid: 0,
        normal: Vector3::new(0.0, -1.0, 0.0),
        origin: vertices[0],
        u_axis: Vector3::new(1.0, 0.0, 0.0),
        v_axis: Vector3::new(0.0, 0.0, 1.0),
        raw: vec![vertices],
        raw_conformed: None,
        regions: Vec::new(),
    }];
    for (index, split_point) in split_points.iter().enumerate() {
        plans.push(PlanBucket {
            bid: index as u32 + 1,
            normal: Vector3::new(0.0, 0.0, 1.0),
            origin: *split_point,
            u_axis: Vector3::new(1.0, 0.0, 0.0),
            v_axis: Vector3::new(0.0, 1.0, 0.0),
            raw: vec![[
                *split_point,
                *split_point + Vector3::new(0.0, 1.0, 0.0),
                *split_point + Vector3::new(0.25, 1.0, 0.25),
            ]],
            raw_conformed: None,
            regions: Vec::new(),
        });
    }
    let seam = build_seam_map(&plans);
    assert!(conform_plans(&mut plans, &seam));

    let triangles = plans[0].raw_conformed.as_ref().expect("conformed target");
    assert_eq!(triangles.len(), 9);
    let area: f64 = triangles
        .iter()
        .map(|triangle| {
            (triangle[1] - triangle[0])
                .cross(&(triangle[2] - triangle[0]))
                .norm()
                * 0.5
        })
        .sum();
    assert!(
        (area - 2.0).abs() < 1.0e-12,
        "conforming must preserve area"
    );
    let mut mesh = Mesh::new();
    for triangle in triangles {
        add_face(&mut mesh, *triangle);
    }
    mesh.clean_degenerate();
    assert_eq!(mesh.triangle_count(), 9);
    assert_eq!(count_open_boundary_edges_exact(&mesh), 9);
}

#[test]
fn conformed_candidate_is_cleaned_before_acceptance_3977() {
    // An arbitrary closed tetrahedron plus a sub-reconcile-grid collinear
    // sliver models the second #3977 residual: triangulation preserved all
    // real faces but also emitted a zero-geometry seam triangle.
    let (a, b, c, d) = (
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
        Point3::new(0.0, 2.0, 0.0),
        Point3::new(0.0, 0.0, 2.0),
    );
    let mut candidate = Mesh::new();
    for face in [[a, c, b], [a, b, d], [a, d, c], [b, c, d]] {
        add_face(&mut candidate, face);
    }
    add_face(
        &mut candidate,
        [
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(0.5, 5.0e-6, 0.0),
        ],
    );
    assert_eq!(
        candidate.triangle_count(),
        5,
        "the long-edge sliver must reach canonical altitude cleanup"
    );
    assert!(count_open_boundary_edges_at(&candidate, 1.0e4) > 0);

    let accepted = complete_conformed_candidate(candidate, true, true)
        .expect("canonical cleanup must expose the closed real solid");
    assert_eq!(count_open_boundary_edges_at(&accepted, 1.0e4), 0);
    assert_eq!(accepted.triangle_count(), 4);
}

#[test]
fn raw_candidate_requires_exact_closure_3977() {
    let (a, b, c, d) = (
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
        Point3::new(0.0, 2.0, 0.0),
        Point3::new(0.0, 0.0, 2.0),
    );
    let shifted_a = Point3::new(0.0, 5.0e-6, 0.0);
    let mut candidate = Mesh::new();
    for face in [[a, c, b], [shifted_a, b, d], [a, d, c], [b, c, d]] {
        add_face(&mut candidate, face);
    }
    assert_eq!(count_open_boundary_edges_at(&candidate, 1.0e4), 0);
    assert!(count_open_boundary_edges_exact(&candidate) > 0);
    assert!(complete_conformed_candidate(candidate.clone(), true, false).is_some());
    assert!(complete_conformed_candidate(candidate, true, true).is_none());
}
