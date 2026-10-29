// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use super::*;
use ifc_lite_geometry::resource::{BudgetStart, ProductBudget};

fn part(positions: Vec<f64>, indices: Vec<u32>, faces: Vec<u32>) -> ShapePart {
    ShapePart { positions, indices, revision_local_faces: faces,
        world_from_object: [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.],
        curved: true, normals: None, appearance: None, faces: None, instance_key: None }
}
fn normals(p: &ShapePart) -> Vec<f64> {
    corner_normals(p, 5., &OwnedResourceContext::capture_current(), &mut Storage::default()).unwrap()
}
fn near(actual: &[f64], expected: [f64; 3]) {
    for (a, b) in actual.iter().zip(expected) { assert!((a - b).abs() < 1e-12, "{actual:?} != {expected:?}"); }
}
fn fan(tilts: &[f64], angles: &[f64]) -> ShapePart {
    let mut positions = vec![0.,0.,0., 1.,0.,0.];
    let mut indices = Vec::new();
    for (i, (&tilt, &angle)) in tilts.iter().zip(angles).enumerate() {
        let (t, a) = (tilt.to_radians(), angle.to_radians());
        positions.extend([a.cos(), a.sin()*t.cos(), a.sin()*t.sin()]);
        indices.extend([0, 1, i as u32 + 2]);
    }
    part(positions, indices, vec![77; tilts.len()])
}

#[test]
fn m11_n_7955_cube_has_six_exact_normals_and_unchanged_topology() {
    let p = part(vec![0.,0.,0., 1.,0.,0., 1.,1.,0., 0.,1.,0.,
        0.,0.,1., 1.,0.,1., 1.,1.,1., 0.,1.,1.],
        vec![0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4,
             1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7],
        vec![10,10,20,20,30,30,40,40,50,50,60,60]);
    let (positions, indices, faces) = (p.positions.clone(), p.indices.clone(), p.revision_local_faces.clone());
    let result = normals(&p);
    let planes = [[0.,0.,-1.], [0.,0.,1.], [0.,-1.,0.], [1.,0.,0.], [0.,1.,0.], [-1.,0.,0.]];
    for (side, plane) in result.chunks_exact(18).zip(planes) {
        for n in side.chunks_exact(3) { near(n, plane); }
    }
    assert_eq!((p.positions, p.indices, p.revision_local_faces), (positions, indices, faces));
}

#[test]
fn m11_n_7955_crease_guard_is_relative_to_each_own_facet_not_transitive() {
    let p = fan(&[0., 8., 16., 30.], &[90.; 4]);
    let result = normals(&p);
    // 0 includes 8 but excludes 16; 8 includes 0 and 16; 30 is isolated.
    for (corner, degrees) in [(0,4_f64), (3,8.), (6,12.), (9,30.)] {
        let t = degrees.to_radians();
        near(&result[corner*3..corner*3+3], [0., -t.sin(), t.cos()]);
    }
}

#[test]
fn m11_n_7955_angle_weights_and_revision_local_face_boundaries() {
    let mut p = fan(&[0., 8.], &[30.,90.]);
    let result = normals(&p);
    let t = 8_f64.to_radians();
    let expected = [0., -3.*t.sin(), 1.+3.*t.cos()];
    let l = expected.iter().map(|v| v*v).sum::<f64>().sqrt();
    near(&result[..3], expected.map(|v| v/l));
    p.revision_local_faces[1] = 78;
    let result = normals(&p);
    near(&result[..3], [0.,0.,1.]);
    near(&result[9..12], [0.,-t.sin(),t.cos()]);
}

fn prism(n: u32) -> ShapePart {
    let mut positions = Vec::new();
    for z in [0., 2.] {
        for i in 0..n { let a = f64::from(i) * std::f64::consts::TAU / f64::from(n); positions.extend([a.cos(),a.sin(),z]); }
    }
    let mut indices = Vec::new();
    let mut faces = Vec::new();
    for i in 0..n { let j = (i+1)%n; indices.extend([i,j,j+n, i,j+n,i+n]); faces.extend([4,4]); }
    for i in 1..n-1 { indices.extend([0,i+1,i, n,n+i,n+i+1]); faces.extend([1,2]); }
    part(positions, indices, faces)
}

#[test]
fn m11_n_7955_fine_prism_smooths_radially_but_caps_stay_creased() {
    let p = prism(72);
    let result = normals(&p);
    for (corner, normal) in result.chunks_exact(3).enumerate() {
        let face = p.revision_local_faces[corner/3];
        let i = p.indices[corner] as usize * 3;
        let expected = match face { 1 => [0.,0.,-1.], 2 => [0.,0.,1.], _ => [p.positions[i],p.positions[i+1],0.] };
        near(normal, expected);
    }
}

#[test]
fn m11_n_7955_sixteen_gon_exceeds_ten_degree_crease_guard() {
    // 22.5 degree dihedrals exceed the normative guard, even on a single face.
    let p = prism(16);
    let result = normals(&p);
    for i in 0..16 { let a = (i as f64 + 0.5) * std::f64::consts::TAU / 16.;
        for normal in result[i*18..i*18+18].chunks_exact(3) { near(normal, [a.cos(),a.sin(),0.]); }
    }
}

#[test]
fn m11_n_7955_frame_scale_mirror_and_large_translation_precede_normals() {
    let mut p = fan(&[30.], &[90.]);
    p.world_from_object = [-2.,0.,0.,0., 0.,3.,0.,0., 0.,0.,4.,0., 2.6e6,-1e20,7e15,1.];
    // Low-level normals follow the transformed triangle winding. This is NOT
    // an outward-normal claim: mirrored publication refuses until M10 flips
    // winding and normals together. Translation cancels before this transform.
    assert!(!positive_frame(&p).unwrap());
    // Transformed cross product: (0, 4*sin(30), -3*cos(30)).
    let expected = [0.,2.,-3.*30_f64.to_radians().cos()];
    let l = expected.iter().map(|v| v*v).sum::<f64>().sqrt();
    let winding = cross(world_vector(&p.world_from_object,[1.,0.,0.]),
        world_vector(&p.world_from_object,[0.,30_f64.to_radians().cos(),0.5]));
    for normal in normals(&p).chunks_exact(3) {
        near(normal, expected.map(|v| v/l));
        assert!(dot([normal[0],normal[1],normal[2]],winding) > 0.);
    }
}

#[test]
fn m11_n_7955_invalid_and_degenerate_meshes_refuse_without_nan_normals() {
    let mut p = fan(&[0.], &[90.]);
    for fault in 0..4 {
        match fault { 0 => p.revision_local_faces.clear(), 1 => {p.revision_local_faces.push(77); p.indices[0]=99;},
            2 => p.indices[0]=1, _ => {p.indices[0]=0; p.positions[0]=f64::NAN;} }
        assert_eq!(corner_normals(&p, 5., &OwnedResourceContext::capture_current(), &mut Storage::default())
            .unwrap_err().refusal().0.code(), "contract_breach");
    }
}

#[test]
fn m11_n_7955_budget_bounds_backing_and_high_valence_work() {
    // The same triangle count with separate vertices fits the allowance,
    // including charged allocations and all linear processing. Sharing two
    // vertices instead creates quadratic adjacency scans that must refuse.
    let separate = part([0.,0.,0., 1.,0.,0., 0.,1.,0.].repeat(1_000),
        (0..3_000).collect(), (0..1_000).collect());
    ProductBudget::new(BudgetStart::now(), 100_000, 10_000_000, 10000).scope(|| {
        for n in normals(&separate).chunks_exact(3) { near(n, [0.,0.,1.]); }
    });
    // Two nonplanar faces retain quadratic scans, including rejected neighbours.
    for (work, bytes) in [(1_000_000, 1), (45_000, 10_000_000)] {
        let budget = ProductBudget::new(BudgetStart::now(), work, bytes, 10000);
        let started = std::time::Instant::now();
        budget.scope(|| {
            let tilts: Vec<_> = (0..1_000).map(|i| (i%4) as f64*8.).collect();
            let mut p = fan(&tilts, &[90.; 1_000]);
            p.revision_local_faces = (0..1_000).map(|i| i%2).collect();
            assert_eq!(corner_normals(&p, 5., &OwnedResourceContext::capture_current(), &mut Storage::default())
                .unwrap_err().refusal().0.code(), "resource_exhausted");
        });
        assert!(!budget.deadline_fired(), "work/backing must refuse before the deadline");
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "bounded high-valence refusal");
    }
}


#[test]
fn m11_n_7955_planar_face_slivers_use_one_verified_plane_normal() {
    // The source plane is z=0. One interior tessellation vertex is 70 nm off
    // that plane; a 10 micrometre altitude amplifies its facet-normal error.
    // The entire face boundary still defines the exact plane normal.
    let mut p = part(vec![0.,0.,0., 1.,0.,0., 1.,1.,0., 0.,1.,0., 0.5,1e-5,7e-8],
        vec![0,1,4, 1,2,4, 2,3,4, 3,0,4],vec![7;4]);
    let facet = unit(cross([1.,0.,0.],[0.5,1e-5,7e-8])).unwrap();
    assert!(length(cross(facet,[0.,0.,1.])) > 1e-3);
    let scattered = normals(&p);
    assert!(scattered.chunks_exact(3).any(|n| length(cross([n[0],n[1],n[2]],[0.,0.,1.])) > 1e-9));
    p.normals = Some(scattered);
    let frame = p.world_from_object;
    plane::apply(&mut p,&frame,[0.;3],[0.,0.,-1.],&[0,1,2,3],&OwnedResourceContext::capture_current()).unwrap();
    for normal in p.normals.as_ref().unwrap().chunks_exact(3) {near(normal,[0.,0.,1.]);}
}

#[test]
fn m11_n_7955_nonplanar_face_retains_per_corner_crease_rule() {
    let mut p = fan(&[0.,8.],&[90.;2]);
    // The whole face is far outside faceIncidence, so four-degree smoothing
    // at the shared edge remains; it must not collapse to one plane normal.
    p.normals = Some(normals(&p));
    let frame = p.world_from_object;
    plane::apply(&mut p,&frame,[0.;3],[0.,0.,1.],&[0,1],&OwnedResourceContext::capture_current()).unwrap();
    let result = p.normals.unwrap();
    near(&result[..3],[0.,-4_f64.to_radians().sin(),4_f64.to_radians().cos()]);
    near(&result[6..9],[0.,0.,1.]);
    near(&result[15..18],[0.,-8_f64.to_radians().sin(),8_f64.to_radians().cos()]);
}


#[test]
fn m11_n_7955_source_plane_verifies_every_vertex_before_replacing_normals() {
    let mut p = part(vec![0.,0.,0., 1.,0.,0., 1.,1.,0., 0.,1.,0., 0.5,0.5,2e-6],
        vec![0,1,2, 0,2,4, 2,3,4, 3,0,4],vec![7;4]);
    let before = normals(&p);
    p.normals = Some(before.clone());
    let frame = p.world_from_object;
    assert!(plane::apply(&mut p,&frame,[0.;3],[0.,0.,1.],&[0,1,2,3],&OwnedResourceContext::capture_current()).unwrap(),
        "off-plane fallback reports the M8 geometry defect");
    assert_eq!(p.normals.unwrap(),before,"a late off-plane vertex leaves every corner unchanged");
}

#[test]
fn m11_n_7955_source_plane_uses_composed_frame_under_scale_and_survey_translation() {
    let mut p = fan(&[30.],&[90.]);
    p.world_from_object = [2.,0.,0.,0., 0.,3.,0.,0., 0.,0.,4.,0., 2.6e6,-1e20,7e15,1.];
    let from_part = [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.];
    p.normals = Some(normals(&p));
    let n = [0.,-30_f64.to_radians().sin(),30_f64.to_radians().cos()];
    plane::apply(&mut p,&from_part,[0.;3],n,&[0],&OwnedResourceContext::capture_current()).unwrap();
    let expected = unit([0.,-2.,3.*30_f64.to_radians().cos()]).unwrap();
    for normal in p.normals.unwrap().chunks_exact(3) {near(normal,expected);}
}

#[test]
fn m11_n_7955_zero_area_cap_corner_uses_the_verified_plane() {
    // A mid-edge profile vertex leaves an exactly collinear cap triangle.
    let mut p = part(vec![0.,0.,0., 1.,0.,0., 2.,0.,0., 0.,1.,0.],
        vec![0,1,2, 0,2,3],vec![7,7]);
    p.normals = Some(vec![0.;18]);
    let frame = p.world_from_object;
    assert!(!plane::apply(&mut p,&frame,[0.;3],[0.,0.,1.],&[0,1],
        &OwnedResourceContext::capture_current()).unwrap());
    for n in normals(&p).chunks_exact(3) {near(n,[0.,0.,1.]);}
}

#[test]
fn m11_n_7955_curved_slivers_have_neither_weight_nor_crease_authority() {
    for degrees in [8_f64,18.] {
        let mut p = prism(72);
        let h = 1e-8;
        // Split the first cylinder wall quad with a vertex almost on its
        // vertical edge. The last triangle's facet tilts 8/18 degrees, while
        // the two non-slivers retain the cylinder's 2.5-degree secant normal.
        p.positions.extend([1.-h*degrees.to_radians().tan(),h,1.]);
        p.indices[3..6].copy_from_slice(&[0,73,144]);
        p.indices.extend([73,72,144, 72,0,144]);
        p.revision_local_faces.extend([4,4]);
        let output = normals(&p);
        let angle = |n: &[f64]| libm::atan2(n[1],n[0]).to_degrees();
        let last = output.len()-9;
        // Sliver corners use the vertex/face mean. Its interior corner has
        // only the two reliable side facets: exactly the 2.5-degree secant.
        assert!((angle(&output[last+6..last+9])-2.5).abs() < 1e-4,
            "{degrees}-degree sliver retained its own normal: {:?}",&output[last+6..last+9]);
        // Every wall corner still meets the analytic radial oracle, including
        // the two good triangles adjacent to that noisy sliver.
        for (corner,n) in output.chunks_exact(3).enumerate() {
            if p.revision_local_faces[corner/3] != 4 {continue;}
            let i = p.indices[corner] as usize*3;
            let radial = unit([p.positions[i],p.positions[i+1],0.]).unwrap();
            assert!(libm::atan2(length(cross([n[0],n[1],n[2]],radial)),dot([n[0],n[1],n[2]],radial)) < 0.0873);
        }
        // At the interior vertex, the two reliable triangle corners must not
        // be dragged towards the sliver, even while it is within the guard.
        for corner in [5,p.indices.len()-4] {
            assert!((angle(&output[corner*3..corner*3+3])-2.5).abs() < 1e-4);
        }
    }
}

#[test]
fn m11_n_7955_planar_cap_with_thousands_of_vertices_needs_no_adjacency_scan() {
    let count = 4_000;
    let mut p = prism(count);
    p.indices.drain(..count as usize*6);
    p.revision_local_faces.drain(..count as usize*2);
    p.normals = Some(vec![0.;p.indices.len()*3]);
    ProductBudget::new(BudgetStart::now(), 500_000, 20_000_000, 10_000).scope(|| {
        let resources = OwnedResourceContext::capture_current();
        let frame = p.world_from_object;
        for (face,z,normal) in [(1,0.,[0.,0.,-1.]),(2,2.,[0.,0.,1.])] {
            let triangles: Vec<_> = p.revision_local_faces.iter().enumerate()
                .filter_map(|(i,&id)| (id == face).then_some(i)).collect();
            assert!(!plane::apply(&mut p,&frame,[0.,0.,z],normal,&triangles,&resources).unwrap());
        }
        let result = normals(&p);
        for (t,values) in result.chunks_exact(9).enumerate() {
            for n in values.chunks_exact(3) {near(n,[0.,0.,if p.revision_local_faces[t]==1 {-1.} else {1.}]);}
        }
    });
}

#[test]
fn m11_n_7955_crease_uses_the_runs_tessellation_angle() {
    let p = fan(&[0.,8.],&[90.;2]);
    let n = corner_normals(&p,3.,&OwnedResourceContext::capture_current(),&mut Storage::default()).unwrap();
    near(&n[..3],[0.,0.,1.]); // 2 * 3 degrees excludes the eight-degree neighbour.
    let n = corner_normals(&p,5.,&OwnedResourceContext::capture_current(),&mut Storage::default()).unwrap();
    near(&n[..3],[0.,-4_f64.to_radians().sin(),4_f64.to_radians().cos()]);
}

#[test]
fn m11_n_7955_zero_area_facet_has_no_weight_in_a_vertex_face_group() {
    let p = part(vec![0.,0.,0., 1.,0.,0., 2.,0.,0., 0.,1.,0.],
        vec![0,1,3, 1,2,3, 0,1,2],vec![4;3]);
    for n in normals(&p).chunks_exact(3) {near(n,[0.,0.,1.]);}
}

#[test]
fn m11_n_7955_shared_vertices_on_thousands_of_distinct_faces_are_bucketed() {
    let p = part(vec![0.,0.,0., 1.,0.,0., 0.,1.,0.],
        [0,1,2].repeat(4_000),(0..4_000).collect());
    ProductBudget::new(BudgetStart::now(), 400_000, 10_000_000, 10_000).scope(|| {
        for n in normals(&p).chunks_exact(3) {near(n,[0.,0.,1.]);}
    });
}

#[test]
fn m11_n_7955_cancelling_orientation_votes_report_a_planar_fallback() {
    // One facet wound +Z, one -Z on the same attributed plane: no polarity can be chosen.
    let mut p = part(vec![0.,0.,0., 1.,0.,0., 1.,1.,0., 0.,1.,0.], vec![0,1,2, 0,3,2], vec![7,7]);
    let before = normals(&p);
    p.normals = Some(before.clone());
    let frame = p.world_from_object;
    assert!(plane::apply(&mut p,&frame,[0.;3],[0.,0.,1.],&[0,1],&OwnedResourceContext::capture_current()).unwrap(),
        "an orientation tie is a counted fallback, never a silent success");
    assert_eq!(p.normals.unwrap(), before, "no corner changes when the plane is not applied");
}
