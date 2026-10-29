// SPDX-License-Identifier: MPL-2.0
//! #7955: every F-A source side, including its unsmoothed terminal corners.
use ifc_lite_processing::element::retained_runtime::ShapeOnlyProduct;
use ifc_lite_retained_native::oracle::normals::{self, Surface};
use super::fi::metrics;

pub fn check(product: &ShapeOnlyProduct, source: &[Surface], limit: f64) {
    let mut counts = vec![(0_usize,0_usize);source.len()];
    for part in &product.parts {
        let normals = part.normals.as_ref().unwrap();
        let check = normals::check_mesh(&part.positions,&part.indices,&part.world_from_object,normals,source).unwrap();
        for (t,triangle) in part.indices.chunks_exact(3).enumerate() {
            let id = check.surface_indices[t].expect("every source side attributed");
            if !source[id].curved() { continue; }
            let p: [[f64;3];3] = std::array::from_fn(|c| {
                let i = triangle[c] as usize*3;
                metrics::transform(&part.world_from_object,[part.positions[i],part.positions[i+1],part.positions[i+2]])
            });
            let a: [f64;3] = std::array::from_fn(|i| p[1][i]-p[0][i]);
            let b: [f64;3] = std::array::from_fn(|i| p[2][i]-p[0][i]);
            let facet = [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
            for (c,point) in p.into_iter().enumerate() {
                let i = t*9+c*3;
                let n = [normals[i],normals[i+1],normals[i+2]];
                let expected = source[id].sample(point).unwrap().0;
                assert!(normals::angle(n,expected) <= limit,"#{} source side {id}, corner {}",product.product_id,t*3+c);
                counts[id].0 += 1;
                counts[id].1 += usize::from(normals::angle(n,facet)>1e-9);
            }
        }
    }
    // Hand-derived terminal count for the quarter-annulus controls: each of
    // two radial ends has a two-triangle strip with three one-secant corners.
    // A bottom-reaching door adds one one-secant corner at each of its two jambs
    // on this curved side; its lintel does not terminate the entire side.
    let terminal = if product.cuts == 0 { 2 * 3 } else { 2 * 3 + 2 };
    let mut sides = 0;
    for (id,&(corners,smoothed)) in counts.iter().enumerate() {
        if !source[id].curved() {continue;}
        sides += 1;
        assert!(corners > terminal,"#{} side {id} must execute",product.product_id);
        assert_eq!(smoothed,corners-terminal,"#{} side {id}: hand-derived terminal corners",product.product_id);
        println!("F-A #{} source side {id}: {corners} corners, {smoothed} smoothed, {terminal} terminal",product.product_id);
    }
    assert_eq!(sides,2,"inner and outer source side must both execute");
}
