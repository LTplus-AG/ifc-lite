// SPDX-License-Identifier: MPL-2.0
//! #7955: equivalent source boundaries must qualify independently of encoding.
use ifc_lite_retained_native::oracle::{bounded, normals};
const SOURCE: &str = include_str!("../../../../tests/fixtures/synthetic-retained/m6-equivalent-boundaries.ifc");
const IDS: [u32;6] = [1002,1012,1022,1032,1042,1052];

#[test]
fn m6_7955_equivalent_boundaries_have_source_clearance_and_normals() {
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(SOURCE.as_bytes(),None);
    for (i,id) in IDS.into_iter().enumerate() {
        let e=bounded::expected(SOURCE.as_bytes(),&sources,id).unwrap_or_else(||panic!("#{id}: independent boundary source decode"));
        let curved=i>=3;
        assert_eq!(e.curved,curved,"#{id}");
        if !curved {assert!((e.section_volume.unwrap()-56.).abs()<1e-10);}
        assert!(e.removed_clearance([1.,1.,3.])>0.4,"#{id}: interior");
        assert_eq!(e.removed_clearance([3.,1.,3.]),0.,"#{id}: outside");
        assert_eq!(e.removed_clearance([1.,1.,1.]),0.,"#{id}: kept halfspace");
        let surfaces=normals::surfaces(SOURCE.as_bytes(),&sources,id).expect("Clip::read normal source");
        let (point,normal)=if curved {
            let q=std::f64::consts::FRAC_1_SQRT_2;
            ([2.*q,2.*q,3.],[-q,-q,0.])
        }else{([0.5,1.,3.],[1.,0.,0.])};
        assert!(surfaces.iter().any(|s|s.sample(point).is_some_and(|(n,d)|d<1e-12&&normals::angle(n,normal)<1e-12)),"#{id}: boundary normal");
    }
}

#[test]
fn m6_native_equivalent_boundary_publication_clearance_and_normals() {
    if super::worker().is_none(){return;}
    let outcomes=super::run(SOURCE,&IDS);
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(SOURCE.as_bytes(),None);
    for (i,id) in IDS.into_iter().enumerate() {
        let shape=super::shape(&outcomes,id);
        super::verify(SOURCE,shape,Some(if i<3 {56.}else{64.-2.*std::f64::consts::PI}));
        let surfaces=normals::surfaces(SOURCE.as_bytes(),&sources,id).expect("independent normal oracle");
        let check=normals::check(shape,&surfaces).unwrap();
        assert_eq!(check.unattributed,0,"#{id}: {check:?}");
        assert!(check.planar_radians<1e-9&&check.curved_radians<0.0873&&check.unit_error<1e-12,"#{id}: {check:?}");
    }
    println!("sdk witness executed: m6_equivalent_boundaries");
}
