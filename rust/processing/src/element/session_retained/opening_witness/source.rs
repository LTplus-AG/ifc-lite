// SPDX-License-Identifier: MPL-2.0
//! Deliberately closed fixture domain. A different source is an assertion failure.
use super::analytic::{q, remaining, section, Oracle, Prism};
use ifc_lite_core::{slot, EntityDecoder, IfcType, SourceBundle};
use ifc_lite_geometry::{placement::Axis2Placement, GeometryRouter};
use nalgebra::Matrix4;

fn bits(values: &[f64], expected: &serde_json::Value) {
    let expected:Vec<_>=expected.as_array().unwrap().iter()
        .map(|v|u64::from_str_radix(v.as_str().unwrap(),16).unwrap()).collect();
    assert_eq!(values.iter().map(|v|v.to_bits()).collect::<Vec<_>>(),expected,
        "canonical decoder coefficient/raw frame bits changed");
}
fn prism(d: &mut EntityDecoder<'_>, id: u32) -> Prism {
    let e=d.decode_by_id(id).unwrap();assert_eq!(e.ifc_type,IfcType::IfcExtrudedAreaSolid);
    assert_eq!(d.direction3(e.get_ref(slot::IfcExtrudedAreaSolid::EXTRUDED_DIRECTION.index()).unwrap()).unwrap(),[0.,0.,1.]);
    let p=d.decode_by_id(e.get_ref(slot::IfcExtrudedAreaSolid::SWEPT_AREA.index()).unwrap()).unwrap();
    assert_eq!(p.ifc_type,IfcType::IfcRectangleProfileDef);
    let profile=Axis2Placement::read_id(p.get_ref(slot::IfcRectangleProfileDef::POSITION.index()).unwrap(),d).unwrap();
    let placement=Axis2Placement::read_id(e.get_ref(slot::IfcExtrudedAreaSolid::POSITION.index()).unwrap(),d).unwrap();
    let m=profile.matrix();let s=placement.matrix();
    let mut untranslated=s;untranslated[(2,3)]=0.;assert_eq!(untranslated,Matrix4::identity());
    let [w,h,depth]=[p.get_float(slot::IfcRectangleProfileDef::X_DIM.index()).unwrap(),p.get_float(slot::IfcRectangleProfileDef::Y_DIM.index()).unwrap(),e.get_float(slot::IfcExtrudedAreaSolid::DEPTH.index()).unwrap()];
    assert!([w,h,depth].iter().all(|v|v.is_finite() && *v>0.));
    let table:serde_json::Value=serde_json::from_str(include_str!("decoded-bits.json")).unwrap();
    let expected=&table[(if id==126 {26} else {id}).to_string()];
    bits(&profile.location[..2],&expected["centre"]);
    bits(&placement.location,&expected["origin"]);
    bits(&[w,h],&expected["dims"]);bits(&[depth],&expected["depth"]);
    let basis=[m[(0,0)],m[(1,0)],m[(0,1)],m[(1,1)]];
    bits(&basis,&expected["basis"]);
    let direction=profile.ref_direction.unwrap();
    bits(&direction[..2],&serde_json::json!([
        expected["basis"][0],expected["basis"][1]
    ]));
    assert_eq!(direction[2].to_bits(),0);
    let polygon=[(-1.,-1.),(1.,-1.),(1.,1.),(-1.,1.)].iter().map(|&(u,v)| {
        [q(s[(0,3)])+q(m[(0,3)])+q(basis[0])*q(w/2.)*q(u)+q(basis[2])*q(h/2.)*q(v),
         q(s[(1,3)])+q(m[(1,3)])+q(basis[1])*q(w/2.)*q(u)+q(basis[3])*q(h/2.)*q(v)]
    }).collect();
    Prism {polygon,lo:q(s[(2,3)]),hi:q(s[(2,3)])+q(depth)}
}
pub(in super::super) fn oracle(source: &str) -> Oracle {
    use sha2::{Digest, Sha256};
    assert_eq!(format!("{:x}",Sha256::digest(super::OVERLAP.as_bytes())),
        "21625ddf0c241cd7562cc2b2fa0ab49a0d2218ba32da37b2ef4d34f1143c146f");
    let repeated=source==super::repeated_mapped_source();let reference=source==super::reference_source();
    assert!(source==super::OVERLAP || repeated || reference,"unsupported oracle source; never skip");
    let bundle=SourceBundle::new(source.as_bytes().to_vec());let mut d=bundle.decoder();
    assert_eq!(d.length_unit_scale(),1.);let router=GeometryRouter::with_scale(1.);
    for id in [30,50,70,100] {
        let e=d.decode_by_id(id).unwrap();
        assert_eq!(router.resolve_scaled_placement_strict(&e,&mut d).unwrap().as_slice(),Matrix4::<f64>::identity().as_slice());
    }
    let host=prism(&mut d,26);let mut cuts=Vec::new();
    if !reference {cuts.push(prism(&mut d,46));}
    if repeated {
        let second=prism(&mut d,126);assert_eq!(second.polygon,host.polygon);
        assert_eq!((&second.lo,&second.hi),(&host.lo,&host.hi));
        let map=d.decode_by_id(200).unwrap();assert_eq!(map.get_ref(slot::IfcRepresentationMap::MAPPING_ORIGIN.index()),Some(5));
        for id in [201,202] {
            let item=d.decode_by_id(id).unwrap();assert_eq!(item.get_ref(slot::IfcMappedItem::MAPPING_SOURCE.index()),Some(200));
            let frame=router.resolve_scaled_mapped_item_transform(&item,&map,&mut d).unwrap().unwrap();
            let target=d.decode_by_id(item.get_ref(slot::IfcMappedItem::MAPPING_TARGET.index()).unwrap()).unwrap();
            let translation=d.point3(target.get_ref(slot::IfcCartesianTransformationOperator3D::LOCAL_ORIGIN.index()).unwrap()).unwrap();
            let mut expected=Matrix4::<f64>::identity();
            for i in 0..3 {expected[(i,3)]=translation[i];}
            assert_eq!(frame.as_slice(),expected.as_slice());
            if id==201 {assert_eq!(expected,Matrix4::identity());} else {
                bits(&translation,&serde_json::json!(["3fc999999999999a","0000000000000000","0000000000000000"]));
                let mut a=cuts[0].clone();
                for p in &mut a.polygon {p[0]+=q(frame[12]);p[1]+=q(frame[13]);}
                cuts.push(a);
            }
        }
    }
    cuts.push(prism(&mut d,66));cuts.push(prism(&mut d,96));
    let stages=(1..=cuts.len()).map(|n|remaining(&host,&cuts[..n])).collect::<Vec<_>>();
    let y=Axis2Placement::read_id(22,&mut d).unwrap().location[1];
    // Probe coordinates are specified by the review; all geometry endpoints are derived.
    let sections=[0.1,0.4,0.7,1.7].into_iter().map(|z|(z,section(&host,&cuts,y,z))).collect();
    use num_traits::ToPrimitive;
    let axis=|i:usize,minimum:bool| {
        let values=host.polygon.iter().map(|p|p[i].clone());
        (if minimum {values.min()} else {values.max()}).unwrap().to_f64().unwrap()
    };
    Oracle {total:stages.last().unwrap()*(if repeated {2.} else {1.}),stages,sections,y,
        bounds:[axis(0,true),axis(1,true),host.lo.to_f64().unwrap(),axis(0,false),axis(1,false),host.hi.to_f64().unwrap()]}
}
