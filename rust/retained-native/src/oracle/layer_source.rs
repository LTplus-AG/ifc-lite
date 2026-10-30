// SPDX-License-Identifier: MPL-2.0
//! Independent IFC usage reader: no retained LayerSpec or cutter is an input.
use ifc_lite_core::{slot,EntityDecoder,EntityScanner,IfcType};
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
            if usage.is_none() && e.get_list(slot::IfcRelAssociatesMaterial::RELATED_OBJECTS.index())?.iter().any(|v|v.as_entity_ref()==Some(id)) {
                let m=decoder.decode_by_id(e.ref_at(slot::IfcRelAssociatesMaterial::RELATING_MATERIAL)?).ok()?;
                if m.ifc_type==IfcType::IfcMaterialLayerSetUsage {
                    // Independently select the first plain multi-layer usage. A
                    // single-layer or malformed earlier association cannot win.
                    if let Some(thickness)=plain_layers(&m,decoder,scale) {
                        usage=Some((m,thickness));
                    }
                }
            }
        } else if ifc_lite_core::keyword_eq(kind,"IFCRELVOIDSELEMENT") {
            let e=decoder.decode_by_id(key).ok()?;
            if e.ref_at(slot::IfcRelVoidsElement::RELATING_BUILDING_ELEMENT)==Some(id) { openings.push(e.ref_at(slot::IfcRelVoidsElement::RELATED_OPENING_ELEMENT)?); }
        }
    }
    let (usage,mut thickness)=usage?;
    let axis=match usage.enum_at(slot::IfcMaterialLayerSetUsage::LAYER_SET_DIRECTION)? {"AXIS1"=>0,"AXIS2"=>1,"AXIS3"=>2,_=>return None};
    let sense=match usage.enum_at(slot::IfcMaterialLayerSetUsage::DIRECTION_SENSE)? {"POSITIVE"=>1.,"NEGATIVE"=>-1.,_=>return None};
    let offset=usage.real_at(slot::IfcMaterialLayerSetUsage::OFFSET_FROM_REFERENCE_LINE)?*scale;
    if !offset.is_finite() || thickness.len()>128 {return None;}
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
        let mut reps=shape.select(&element,Select::Where(|_,r,_|r.string_at(slot::IfcRepresentation::REPRESENTATION_IDENTIFIER)==Some("Axis")));
        if let Some(rep)=reps.next() {
            if reps.next().is_some() {return None;}
            let items=rep.get_list(slot::IfcRepresentation::ITEMS.index())?; if items.len()!=1 {return None;}
            let curve=decoder.decode_by_id(items[0].as_entity_ref()?).ok()?;
            if curve.ifc_type==IfcType::IfcTrimmedCurve {
                let basis=decoder.decode_by_id(curve.ref_at(slot::IfcTrimmedCurve::BASIS_CURVE)?).ok()?;
                if basis.ifc_type==IfcType::IfcCircle {
                    let position=decoder.decode_by_id(basis.ref_at(slot::IfcCircle::POSITION)?).ok()?;
                    if position.ifc_type!=IfcType::IfcAxis2Placement2D {return None;}
                    let center=decoder.point3(position.ref_at(slot::IfcAxis2Placement2D::LOCATION)?).ok()?.map(|x|x*scale);
                    circle=Some((center,basis.real_at(slot::IfcCircle::RADIUS)?*scale,if curve.logical_at(slot::IfcTrimmedCurve::SENSE_AGREEMENT)? {1.} else {-1.}));
                }
            }
        }
    }
    Some(Usage{axis,sense,offset,thickness,frame,circle,openings})
}

fn plain_layers(usage: &ifc_lite_core::DecodedEntity, decoder: &mut EntityDecoder, scale: f64) -> Option<Vec<f64>> {
    if !matches!(usage.enum_at(slot::IfcMaterialLayerSetUsage::LAYER_SET_DIRECTION)?,"AXIS1"|"AXIS2"|"AXIS3")
        || !matches!(usage.enum_at(slot::IfcMaterialLayerSetUsage::DIRECTION_SENSE)?,"POSITIVE"|"NEGATIVE") {return None;}
    let set=decoder.decode_by_id(usage.ref_at(slot::IfcMaterialLayerSetUsage::FOR_LAYER_SET)?).ok()?;
    if set.ifc_type!=IfcType::IfcMaterialLayerSet {return None;}
    let mut thickness=Vec::new();
    for value in set.get_list(slot::IfcMaterialLayerSet::MATERIAL_LAYERS.index())? {
        let Some(id)=value.as_entity_ref() else {continue;};
        let layer=decoder.decode_by_id(id).ok()?;
        if layer.ifc_type!=IfcType::IfcMaterialLayer {return None;}
        let t=layer.real_at(slot::IfcMaterialLayer::LAYER_THICKNESS).unwrap_or(0.);
        if t.is_finite() && t>0. {thickness.push(t*scale);}
    }
    (thickness.len()>=2).then_some(thickness)
}
