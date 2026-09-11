// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Explicit error accounting for post-CSG f64-origin → IFC → f32 tessellation.

/// Tessellation parsing first stores product-local IFC coordinates in f32.
/// A rigid placement coefficient has absolute value at most one, so the sum of
/// the three actual cast errors bounds each world-axis error after rotation.
/// This initial slice requires metre units; an additional f32 scale operation
/// must be accounted for before enabling other unit systems.
pub(super) fn local_cast_bounds(points: &[[f64;3]], scale:f64)->Result<Vec<f64>,String> {
    if scale!=1. {return Err("Post-opening conversion currently requires metre model units".into());}
    points.iter().map(|point| {
        let bound=point.iter().map(|&v|(v-f64::from(v as f32)).abs()).sum::<f64>();
        if bound.is_finite() {Ok(bound)}else{Err("Post-opening coordinate exceeds f32 range".into())}
    }).collect()
}

pub(super) fn same_corner(
    before:&[f32], before_origin:[f64;3], after:&[f32], after_origin:[f64;3],
    local_cast_bound:f64,
)->bool {
    (0..3).all(|axis| {
        let old=f64::from(before[axis])+before_origin[axis];
        let new=f64::from(after[axis])+after_origin[axis];
        // The target stores its final relative (or absolute) coordinate in f32.
        // Half the larger adjacent spacing covers round-to-nearest on either
        // side of a power-of-two boundary, including subnormals.
        let value=after[axis];
        let spacing=(f64::from(value.next_up())-f64::from(value))
            .max(f64::from(value)-f64::from(value.next_down()));
        // Inverse rigid placement, forward placement and frame reconstruction
        // use at most 32 double operations per coordinate. Standard gamma_n
        // bounds their accumulated rounding; no fixed metre epsilon is used.
        let gamma=32.*f64::EPSILON/(1.-32.*f64::EPSILON);
        let arithmetic=gamma*(old.abs()+new.abs()+before_origin[axis].abs()+after_origin[axis].abs()+1.);
        let bound=local_cast_bound+spacing*0.5+arithmetic;
        old.is_finite() && new.is_finite() && bound.is_finite() && (old-new).abs()<=bound
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_4404_frame_bound_accepts_rounding_but_refuses_one_ulp_deformation() {
        let origin=[6.,5.,2.6];
        let before=[0.1f32,0.2,0.3];
        let world: [f64;3]=std::array::from_fn(|axis|f64::from(before[axis])+origin[axis]);
        let after=world.map(|value|value as f32);
        assert!(same_corner(&before,origin,&after,[0.;3],0.));
        let mut changed=after;
        changed[0]=changed[0].next_up().next_up();
        assert!(!same_corner(&before,origin,&changed,[0.;3],0.));
        let bounds=local_cast_bounds(&[world],1.).unwrap();
        assert_eq!(bounds[0],world.iter().zip(after).map(|(a,b)|(a-f64::from(b)).abs()).sum::<f64>());
    }

    #[test]
    fn issue_4404_frame_bound_refuses_unaccounted_scale_and_nonfinite_coordinates() {
        assert!(local_cast_bounds(&[[1.,2.,3.]],0.001).is_err());
        assert!(local_cast_bounds(&[[f64::MAX,0.,0.]],1.).is_err());
        assert!(local_cast_bounds(&[[f64::NAN,0.,0.]],1.).is_err());
        assert!(!same_corner(&[0.;3],[0.;3],&[f32::INFINITY,0.,0.],[0.;3],0.));
    }
}
