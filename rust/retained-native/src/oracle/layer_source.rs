// SPDX-License-Identifier: MPL-2.0
//! Independent IFC usage reader: no retained LayerSpec or cutter is an input.
use ifc_lite_core::{EntityDecoder,EntityScanner,IfcType};
use ifc_lite_geometry::{GeometryRouter,representation::{product_shape,Select}};
pub(super) struct Usage {
    pub axis: usize, pub sense: f64, pub offset: f64, pub thickness: Vec<f64>,
    pub frame: [f64;16], pub circle: Option<([f64;3],f64,f64)>, pub openings: Vec<u32>,
}
pub(super) fn read(bytes: &[u8], id: u32, decoder: &mut EntityDecoder) -> Option<Usage> {
    let text=std::str::from_utf8(bytes).ok()?;
    let router=GeometryRouter::with_units(text,decoder); let scale=router.unit_scale();
    let mut scanner=EntityScanner::new(bytes); let mut usage=None; let mut openings=Vec::new();
    while let Some((key,kind,_,_))=scanner.next_entity() {
        if ifc_lite_core::keyword_eq(kind,"IFCRELASSOCIATESMATERIAL") {
            let e=decoder.decode_by_id(key).ok()?;
            if e.get_list(4)?.iter().any(|v|v.as_entity_ref()==Some(id)) {
                let m=decoder.decode_by_id(e.get_ref(5)?).ok()?;
                if m.ifc_type==IfcType::IfcMaterialLayerSetUsage { usage=Some(m); }
            }
        } else if ifc_lite_core::keyword_eq(kind,"IFCRELVOIDSELEMENT") {
            let e=decoder.decode_by_id(key).ok()?;
            if e.get_ref(4)==Some(id) { openings.push(e.get_ref(5)?); }
        }
    }
    let usage=usage?;
    let axis=match usage.get(1)?.as_enum()? {"AXIS1"=>0,"AXIS2"=>1,"AXIS3"=>2,_=>return None};
    let sense=match usage.get(2)?.as_enum()? {"POSITIVE"=>1.,"NEGATIVE"=>-1.,_=>return None};
    let offset=usage.get_float(3)?*scale;
    let set=decoder.decode_by_id(usage.get_ref(0)?).ok()?;
    let mut thickness=Vec::new();
    for l in set.get_list(0)? { thickness.push(decoder.decode_by_id(l.as_entity_ref()?).ok()?.get_float(1)?*scale); }
    if thickness.is_empty() || thickness.len()>128 || thickness.iter().any(|t| !t.is_finite() || *t<0.) {return None;}
    // Independent scalar merge: thinnest <2 mm into thicker neighbour; ties left.
    while thickness.len()>1 {
        let Some(i)=(0..thickness.len()).filter(|&i|thickness[i]<0.002).min_by(|&i,&j|thickness[i].total_cmp(&thickness[j])) else {break;};
        let neighbour=if i==0 {1} else if i+1==thickness.len() || thickness[i-1]>=thickness[i+1] {i-1} else {i+1};
        thickness[neighbour]+=thickness[i]; thickness.remove(i);
    }
    let element=decoder.decode_by_id(id).ok()?;
    let frame=router.resolve_scaled_placement_strict(&element,decoder).ok()?;
    let mut circle=None;
    if axis==1 {
        let shape=product_shape(&element,decoder).ok()??;
        let mut reps=shape.select(&element,Select::Where(|_,r,_|r.get_string(1)==Some("Axis")));
        if let Some(rep)=reps.next() {
            if reps.next().is_some() {return None;}
            let items=rep.get_list(3)?; if items.len()!=1 {return None;}
            let curve=decoder.decode_by_id(items[0].as_entity_ref()?).ok()?;
            if curve.ifc_type==IfcType::IfcTrimmedCurve {
                let basis=decoder.decode_by_id(curve.get_ref(0)?).ok()?;
                if basis.ifc_type==IfcType::IfcCircle {
                    let position=decoder.decode_by_id(basis.get_ref(0)?).ok()?;
                    if position.ifc_type!=IfcType::IfcAxis2Placement2D {return None;}
                    let center=decoder.point3(position.get_ref(0)?).ok()?.map(|x|x*scale);
                    circle=Some((center,basis.get_float(1)?*scale,if curve.get_bool(3)? {1.} else {-1.}));
                }
            }
        }
    }
    Some(Usage{axis,sense,offset,thickness,frame,circle,openings})
}
