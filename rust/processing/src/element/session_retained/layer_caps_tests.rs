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
    for face in faces {
        let n = face.len() as f64;
        let center: [f64;3] = std::array::from_fn(|i| face.iter().map(|&j|positions[j as usize*3+i]).sum::<f64>()/n);
        let id = positions.len() as u32/3; positions.extend(center);
        for i in 0..face.len() { indices.extend([id,face[i],face[(i+1)%face.len()]]); }
    }
    ShapePart { positions,indices, world_from_object:[1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.],
        layer:None,capped_volume_m3:None,curved:false }
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
        assert!(parts.iter().all(|p| !boundary(p).unwrap().is_empty()),"published bands must be open");
        assert!(parts.iter().map(|p|p.indices.len()).sum::<usize>()<before+12);
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
        } else { parts[1].indices.extend(cap[0]); }
        let error = remove(&mut parts,&layers()).unwrap_err();
        assert_eq!(error.refusal().0.code(),"layer_caps_unresolved");
        assert!(matches!(error,RetainedExecutionError::LayerCaps(reason) if reason==if wrong_sign {"opposite_cap"} else {"cap_area"}));
    }
}
#[test]
fn m4_off_surface_rim_refuses() {
    let mut parts = [cube(0.,false),cube(1.,false)];
    parts[0].indices.drain(..3); // a bottom face; neither exposed edge is on x=1.
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
