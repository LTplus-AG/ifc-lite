// SPDX-License-Identifier: MPL-2.0
//! #7955 pure cap conformity on hand-built closed meshes; no kernel mock.
use super::*;
use ifc_lite_geometry::program::transactions::ShapeLayer;
fn cube(x: f64, split_edge: bool) -> ShapePart {
    let mut positions: Vec<f64> = [[x,0.,0.],[x+1.,0.,0.],[x+1.,1.,0.],[x,1.,0.],
        [x,0.,1.],[x+1.,0.,1.],[x+1.,1.,1.],[x,1.,1.]].into_iter().flatten().collect();
    let mut faces = vec![vec![0,3,2,1],vec![4,5,6,7],vec![0,1,5,4],vec![3,7,6,2],vec![0,4,7,3],vec![1,2,6,5]];
    // Split the x-low/y=0 vertical edge, affecting both adjacent faces. The
    // opposite band has one whole edge, so retaining either cap cannot pass.
    if split_edge {
        positions.extend([x,0.,0.5]);
        faces[2]=vec![0,1,5,4,8]; faces[4]=vec![0,8,4,7,3];
    }
    let mut indices = Vec::new();
    let mut revision_local_faces = Vec::new();
    for (face_id, face) in faces.into_iter().enumerate() {
        let n = face.len() as f64;
        let center: [f64;3] = std::array::from_fn(|i| face.iter().map(|&j|positions[j as usize*3+i]).sum::<f64>()/n);
        let id = positions.len() as u32/3; positions.extend(center);
        for i in 0..face.len() { indices.extend([id,face[i],face[(i+1)%face.len()]]); revision_local_faces.push(face_id as u32); }
    }
    ShapePart { positions,indices, world_from_object:[1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.],
        halfspace_clipped:false,layer:None,capped_volume_m3:None,curved:false, revision_local_faces,
        normals:None,appearance:None,faces:None,instance_key:None, source_exact: false, surface: None }
}
fn layers() -> LayerCompletion { LayerCompletion {
    tags: vec![ShapeLayer{index:0,material_id:1},ShapeLayer{index:1,material_id:2}],
    interfaces:vec![LayerInterface::Plane{normal:[1.,0.,0.],distance:1.}],
} }
#[test]
fn m4_boxes_remove_caps_and_conform_t_junction() {
    for split in [false,true] {
        let mut parts = [cube(0.,false),cube(1.,split)];
        assert!((volume(&parts,[0.;3])-2.).abs()<1e-12);
        let before:usize = parts.iter().map(|p|p.indices.len()).sum();
        assert_eq!(remove(&mut parts,&layers()).unwrap(),0.);
        closed(&parts).unwrap(); assert!((volume(&parts,[0.;3])-2.).abs()<1e-12);
        // #7955 M11-F: stripped triangles disappear from the partition and
        // every child of a rim split retains its original supporting face.
        for (band, part) in parts.iter().enumerate() {
            assert_eq!(part.revision_local_faces.len(), part.indices.len()/3);
            for (t, &face) in part.indices.chunks_exact(3).zip(&part.revision_local_faces) {
                let (axis, expected) = match face {
                    0 => (2, 0.), 1 => (2, 1.), 2 => (1, 0.), 3 => (1, 1.),
                    4 => { assert_eq!(band, 0); (0, 0.) },
                    5 => { assert_eq!(band, 1); (0, 2.) },
                    _ => panic!("invented face id"),
                };
                assert!(t.iter().all(|&i| point(part, i)[axis] == expected));
            }
        }
        assert!(parts.iter().all(|p| !boundary(p).unwrap().is_empty()),"published bands must be open");
        assert!(parts.iter().map(|p|p.indices.len()).sum::<usize>()<before+12);
    }
}
#[test]
fn m4_rim_grid_extreme_coordinates_preserve_closed_skin() {
    // #7955: two unit cubes still have volume 2 after a shared translation.
    // At y=+/-1e13 m, y / the fixed 1e-6 m weld grid exceeds i64's range.
    // The float-to-integer cell saturates; visiting neighbours must not wrap
    // or panic, and the exactly coincident rims still need zero displacement.
    for offset in [-1e13,1e13] {
        let mut parts = [cube(0.,false),cube(1.,false)];
        for part in &mut parts {
            for p in part.positions.chunks_exact_mut(3) { p[1] += offset; }
        }
        assert_eq!(remove(&mut parts,&layers()).unwrap(),0.);
        closed(&parts).unwrap();
        assert!((volume(&parts,[0.,offset,0.])-2.).abs()<1e-12);
        assert!(parts.iter().all(|p| !boundary(p).unwrap().is_empty()));
    }
}
#[test]
fn m4_cap_area_and_wrong_sign_refuse() {
    for wrong_sign in [false,true] {
        let mut parts = [cube(0.,false),cube(1.,false)];
        let cap:Vec<_> = parts[1].indices.chunks_exact(3).filter(|t|t.iter().all(|&i|point(&parts[1],i)[0]==1.)).map(|t|[t[0],t[1],t[2]]).collect();
        if wrong_sign {
            for t in parts[1].indices.chunks_exact_mut(3) {
                if cap.iter().any(|c|c==t) { t.swap(1,2); }
            }
        } else { parts[1].indices.extend(cap[0]); parts[1].revision_local_faces.push(4); }
        let error = remove(&mut parts,&layers()).unwrap_err();
        assert_eq!(error.refusal().0.code(),"layer_caps_unresolved");
        assert!(matches!(error,RetainedExecutionError::LayerCaps(reason) if reason==if wrong_sign {"opposite_cap"} else {"cap_area"}));
    }
}
#[test]
fn m4_off_surface_rim_refuses() {
    let mut parts = [cube(0.,false),cube(1.,false)];
    parts[0].indices.drain(..3); parts[0].revision_local_faces.remove(0); // a bottom face; neither exposed edge is on x=1.
    assert!(matches!(remove(&mut parts,&layers()),Err(RetainedExecutionError::LayerCaps("rim_off_surface"))));
}
#[test]
fn m4_flat_snap_limit_is_bounded_and_reports_displacement() {
    for delta in [0.5e-6,2e-6] {
        let mut parts = [cube(0.,false),cube(1.+delta,false)];
        let result = remove(&mut parts,&layers());
        if delta<1e-6 {
            let distance=result.unwrap(); assert!(distance<=1e-6 && distance>=0.49e-6); closed(&parts).unwrap();
        } else { assert!(result.is_err()); }
    }
}

fn sector(inner: f64, outer: f64, angles: &[f64]) -> ShapePart {
    let mut mesh=cube(0.,false);
    mesh.positions.clear(); mesh.indices.clear(); mesh.curved=true;
    for &a in angles {
        for (r,z) in [(inner,0.),(outer,0.),(inner,1.),(outer,1.)] {
            mesh.positions.extend([r*a.cos(),r*a.sin(),z]);
        }
    }
    let mut quad=|v:[u32;4]|mesh.indices.extend([v[0],v[1],v[2],v[0],v[2],v[3]]);
    for i in 0..angles.len()-1 {
        let a=4*i as u32; let b=a+4;
        quad([a,b,b+1,a+1]); // bottom -Z
        quad([a+2,a+3,b+3,b+2]); // top +Z
        quad([a,a+2,b+2,b]); // inner cylinder
        quad([a+1,b+1,b+3,a+3]); // outer cylinder
    }
    quad([0,1,3,2]);
    let end=4*(angles.len()-1) as u32;
    quad([end,end+2,end+3,end+1]);
    mesh.revision_local_faces = (0..mesh.indices.len()/3).map(|t| (t/2) as u32).collect();
    mesh
}

#[test]
fn m4_curved_chord_conformity_obeys_one_millimetre_limit() {
    for sagitta in [0.0005_f64,0.002] {
        // Radius10: midpoint-to-chord distance is R*(1-cos(angle/2)).
        // Solve for angle; the fine rim has a midpoint the coarse rim lacks.
        let angle=2.*(1.-sagitta/10.).acos();
        let mut parts=[sector(9.9,10.,&[0.,angle]),sector(10.,10.1,&[0.,angle/2.,angle])];
        let mut manifest=layers();
        manifest.interfaces=vec![LayerInterface::Cylinder {
            center:[0.;3],axis:[0.,0.,1.],radius:10.,outward:1.,
        }];
        let result=remove(&mut parts,&manifest);
        if sagitta<1e-3 {
            let displacement=result.unwrap();
            assert!((displacement-sagitta).abs()<1e-12);
            assert!(displacement<=1e-3); closed(&parts).unwrap();
        } else {
            assert!(matches!(result,Err(RetainedExecutionError::LayerCaps(_))));
        }
    }
}

// #7955 review: runtime policy and preregistration must move together.
#[test]
fn m4_runtime_tolerances_match_preregistered_json() {
    let limits: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../tests/fixtures/cli-retained/tolerances.d/m4.json")).unwrap();
    assert_eq!(ON_SURFACE_METRES, limits["layerCapOnSurfaceMetres"].as_f64().unwrap());
    for (name, curved) in [("linear", false), ("curved", true)] {
        for key in ["layerCapAreaRelative", "layerBandSumRelative"] {
            assert_eq!(relative_tolerance(curved), limits[key][name].as_f64().unwrap());
        }
        assert_eq!(super::super::layer_rims::weld_tolerance(curved),
            limits["layerCapWeldMetres"][name].as_f64().unwrap());
    }
}
