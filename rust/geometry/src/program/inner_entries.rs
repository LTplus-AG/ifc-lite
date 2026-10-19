// SPDX-License-Identifier: MPL-2.0
//! Entry policies and typed completion of the same opaque inner program.
use super::inner::{GeometryProgram,GeometryOutput};
use super::item::ItemStep;
use crate::{GeometryRouter,Mesh,Result};
use ifc_lite_core::DecodedEntity;
impl GeometryProgram {
    pub(crate) fn opening_context(element:DecodedEntity,ids:Vec<u32>)->Self {
        let mut program=Self::from_step(None);
        program.opening=Some(Box::new(super::inner_opening::OpeningAdapter::new(element,ids)));program
    }
    pub fn parts(element:DecodedEntity)->Self {
        Self::product(element,super::product_control::ProductConsumer::Merged,crate::router::processing::SourceHygiene::Watertight)
    }
    pub fn submeshes(element:DecodedEntity)->Self {
        Self::product(element,super::product_control::ProductConsumer::Styled {allow_instancing:true},crate::router::processing::SourceHygiene::Watertight)
    }
    pub fn voided_parts(element:DecodedEntity)->Self {
        let mut program=Self::from_step(None);
        program.voids=Some(Box::new(super::inner_voids::VoidControl::new(element,super::inner_voids::VoidConsumer::Parts)));program
    }
    pub fn voided_submeshes(element:DecodedEntity)->Self {
        let mut program=Self::from_step(None);
        program.voids=Some(Box::new(super::inner_voids::VoidControl::new(element,super::inner_voids::VoidConsumer::Styled)));program
    }
    pub(crate) fn layer_attempt(element:DecodedEntity,use_openings:bool)->Self {
        let mut program=Self::from_step(None);
        program.layers=Some(Box::new(super::inner_layers::LayerControl::from_index(element,use_openings)));program
    }
    pub(crate) fn material_layers(element:DecodedEntity,buildup:crate::material_layer_index::LayerBuildup)->Self {
        let mut program=Self::from_step(None);
        program.layers=Some(Box::new(super::inner_layers::LayerControl::from_buildup(element,buildup)));program
    }
    pub(crate) fn opening_body(element:DecodedEntity)->Self {
        let mut program=Self::from_step(None);
        program.product=Some(Box::new(super::inner_product_adapter::ProductRootAdapter::without_layers(element,
            super::product_control::ProductConsumer::Merged,crate::router::processing::SourceHygiene::BooleanOperand)));program
    }
    pub(crate) fn finish_layer_candidate(self)->Result<Option<crate::SubMeshCollection>> {
        match self.outcome.expect("completed layer outcome")? {GeometryOutput::LayerCandidate(value)=>Ok(value),_=>Err(crate::Error::geometry("Wrong layer outcome"))}
    }
    pub(super) fn take_geometry_output(&mut self)->Result<GeometryOutput> {
        assert!(self.pending.is_none(),"outstanding geometry request");
        if let Some(output)=self.outcome.take(){return output}
        match self.step.take() {
            Some(ItemStep::Complete(value))=>value.result.and_then(|value|Ok(match value {
                super::retained::ItemValue::Mesh(mesh)=>GeometryOutput::Mesh(mesh),
                super::retained::ItemValue::Retained(value)=> {
                    let mut values=Vec::new();crate::resource::reserve_headers(&mut values,1)?.retain();
                    values.push(value);GeometryOutput::Retained(values)
                }
            })),
            _=>Err(crate::Error::geometry("Geometry output pending")),
        }
    }
    pub fn type_map_id(id:u32)->Self {
        let mut program=Self::from_step(None);
        program.type_map=Some(Box::new(super::inner_type_map::TypeMapControl::from_id(id)));
        program
    }
    pub(crate) fn type_map_entity(entity:DecodedEntity)->Self {
        let mut program=Self::from_step(None);
        program.type_map=Some(Box::new(super::inner_type_map::TypeMapControl::from_entity(entity)));
        program
    }
    pub fn finish_type_parts(self)->Result<Vec<(Mesh,Vec<f32>,Option<crate::processors::texture::TextureAttachment>)>> {
        assert!(self.pending.is_none(),"outstanding geometry request");
        match self.outcome.expect("completed geometry outcome")? {
            GeometryOutput::TypeParts(parts)=>Ok(parts),_=>Err(crate::Error::geometry("Geometry output is not type parts")),
        }
    }
    pub(crate) fn product(element:DecodedEntity,consumer:super::product_control::ProductConsumer,
        hygiene:crate::router::processing::SourceHygiene)->Self {
        let mut program=Self::from_step(None);
        program.product=Some(Box::new(super::inner_product_adapter::ProductRootAdapter::new(element,consumer,hygiene)));
        program
    }
    pub(crate) fn representation_item(item:DecodedEntity,offset:(f64,f64,f64))->Self {
        let mut program=Self::from_step(None);
        program.cache=Some(Box::new(super::inner_cache::CacheControl::new(item,offset)));
        program
    }
    pub(crate) fn mapped_merged(item:&DecodedEntity,router:&GeometryRouter)->Result<Self> {
        let mut program=Self::from_step(None);
        program.mapping=Some(Box::new(super::inner_mapping::MappingControl::merged(item,router,program.id)?));
        Ok(program)
    }
    pub(crate) fn mapped_styled(item:&DecodedEntity,allow_instancing:bool,router:&GeometryRouter)->Result<Self> {
        let mut program=Self::from_step(None);
        program.mapping=Some(Box::new(super::inner_mapping::MappingControl::styled(item,allow_instancing,router,program.id)?));
        Ok(program)
    }
    pub fn finish_parts(self)->Result<Vec<Mesh>> {
        assert!(self.pending.is_none(),"outstanding geometry request");
        match self.outcome.expect("completed geometry outcome")? {
            GeometryOutput::Parts(parts)=>Ok(parts),GeometryOutput::Mesh(mesh)=>Ok(vec![mesh]),
            _=>Err(crate::Error::geometry("Geometry output is not frame parts")),
        }
    }
    pub fn finish_submeshes(self)->Result<crate::SubMeshCollection> {
        assert!(self.pending.is_none(),"outstanding geometry request");
        match self.outcome.expect("completed geometry outcome")? {
            GeometryOutput::Submeshes(parts)=>Ok(parts),_=>Err(crate::Error::geometry("Geometry output is not submeshes")),
        }
    }
}
