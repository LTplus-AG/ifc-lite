// SPDX-License-Identifier: MPL-2.0
//! Contract selection on the existing product, mapping and type-map entries.
use super::{GeometryProgram,retained::{RetainedContract,RetainedProductPlan,remaining_requirements}};
use ifc_lite_core::DecodedEntity;

impl GeometryProgram {
    /// Explicit logical contract on the same product/representation admissions.
    /// Processing alone may bind sealed runtime results to its admitted slots.
    pub fn retained_parts(element: DecodedEntity, contract: RetainedContract) -> Self {
        let walk=super::retained_walk::RetainedWalk::root(element.id);
        let mut program = Self::parts(element);
        program.retained = Some(contract);
        program.retained_walk=Some(walk);
        program
            .product
            .as_mut()
            .expect("product root")
            .select_retained(contract);
        program
    }
    pub fn finish_retained(self) -> crate::Result<RetainedProductPlan> {
        if let Some(walk)=&self.retained_walk {walk.check()?;}
        if self.pending.is_some() {
            return Err(crate::Error::geometry("retained request outstanding"));
        }
        match self.outcome {
            Some(Ok(super::inner::GeometryOutput::Retained(values))) if values.iter().all(|v| v.is_product_placed()) => Ok(RetainedProductPlan {
                opening_completion:None, values,
                remaining: remaining_requirements()?,
            }),
            Some(Ok(super::inner::GeometryOutput::RetainedVoided(values,completion))) if values.iter().all(|v|v.is_product_placed())=> {
                let mut remaining=remaining_requirements()?;
                // Only this product's terminal original void control owns this fact.
                remaining.retain(|requirement|*requirement!=super::retained::RetainedRequirement::OpeningClosure);
                Ok(RetainedProductPlan {values,remaining,opening_completion:Some(completion)})
            }
            Some(Err(error)) => Err(error),
            _ => Err(crate::Error::geometry("retained product incomplete")),
        }
    }
    pub fn retained_submeshes(element: DecodedEntity, contract: RetainedContract) -> Self {
        let walk=super::retained_walk::RetainedWalk::root(element.id);
        let mut program=Self::submeshes(element); program.retained=Some(contract);program.retained_walk=Some(walk);
        program.product.as_mut().expect("product root").select_retained(contract); program
    }
    pub(super) fn retained_styled(item:&DecodedEntity,allow_instancing:bool,contract:RetainedContract,
        router:&crate::GeometryRouter,cache:super::mapping::SharedRetainedCache)->crate::Result<Self> {
        let walk=if item.ifc_type==ifc_lite_core::IfcType::IfcMappedItem {
            super::retained_walk::RetainedWalk::child(item.id)?
        } else {super::retained_walk::RetainedWalk::wrapper()};
        let mut program=Self::mapped_styled(item,allow_instancing,router)?;program.retained=Some(contract);program.retained_walk=Some(walk);
        program.mapping.as_mut().expect("styled mapping root").select_retained(contract,cache);Ok(program)
    }
    pub fn retained_type_map_id(id:u32,contract:RetainedContract)->Self {
        let walk=super::retained_walk::RetainedWalk::child(id);
        let mut program=Self::type_map_id(id);program.retained=Some(contract);
        program.type_map.as_mut().expect("type-map root").select_retained(contract);
        match walk {
            Ok(walk)=>program.retained_walk=Some(walk),
            Err(error)=>{program.retained_walk=super::retained_walk::current();program.type_map=None;program.outcome=Some(Err(error));}
        }
        program
    }
    pub fn finish_retained_type_map(mut self,type_product:u32,class:u8,color:[f32;4])->crate::Result<RetainedProductPlan> {
        let _walk=self.retained_walk.as_ref().map(|walk|walk.scope()).transpose()?;
        if self.pending.is_some() {return Err(crate::Error::geometry("retained type-map request outstanding"))}
        match self.take_geometry_output()? {
            super::inner::GeometryOutput::Retained(mut values)=> {
                for value in &mut values {
                    let mut binding=super::retained_presentation::RetainedPresentation::occurrence(type_product,type_product,None,true);
                    binding.type_product=Some((type_product,class));binding.fallback_color=Some(color);value.present(binding)?;
                }
                Ok(RetainedProductPlan {opening_completion:None,values,remaining:remaining_requirements()?})},
            _=>Err(crate::Error::geometry("retained type-map incomplete")),
        }
    }
    pub(super) fn retained_mapped(item: &DecodedEntity, contract: RetainedContract,
        router: &crate::GeometryRouter, cache: super::mapping::SharedRetainedCache) -> crate::Result<Self> {
        let walk=super::retained_walk::RetainedWalk::child(item.id)?;
        let mut program=Self::mapped_merged(item,router)?;
        program.retained=Some(contract);
        program.retained_walk=Some(walk);
        program.mapping.as_mut().expect("mapped root").select_retained(contract,cache);
        Ok(program)
    }
    pub(super) fn retained_item(item: DecodedEntity, contract: RetainedContract) -> Self {
        let walk=super::retained_walk::RetainedWalk::child(item.id);
        let mut program = Self::item(item, (0., 0., 0.));
        program.retained = Some(contract);
        match walk {
            Ok(walk)=>program.retained_walk=Some(walk),
            Err(error)=>program.step=Some(super::item::ItemStep::Complete(super::item::ItemResult {
                result:Err(error),reports:Default::default(),emitter:None})),
        }
        program
    }
}

impl GeometryProgram {
    pub(super) fn select_retained_product(&mut self,contract:RetainedContract) {
        self.retained=Some(contract);self.retained_walk=Some(super::retained_walk::RetainedWalk::wrapper());
        self.product.as_mut().expect("product controller").select_retained(contract);
    }
    pub(super) fn retained_opening_body(element:DecodedEntity,contract:RetainedContract)->crate::Result<Self> {
        let walk=super::retained_walk::RetainedWalk::child(element.id)?;
        let mut program=Self::opening_body(element);program.select_retained_product(contract);
        program.retained_walk=Some(walk);Ok(program)
    }
    pub(super) fn select_retained_opening_context(&mut self,contract:RetainedContract) {
        self.retained=Some(contract);self.retained_walk=Some(super::retained_walk::RetainedWalk::wrapper());
        self.opening.as_mut().expect("opening controller").select_retained(contract);
    }
    pub(super) fn select_retained_layer(&mut self,contract:RetainedContract) {
        self.retained=Some(contract);self.retained_walk=Some(super::retained_walk::RetainedWalk::wrapper());
        self.layers.as_mut().expect("layer controller").select_retained();
    }
    pub fn retained_voided_parts(element:DecodedEntity,contract:RetainedContract)->Self {
        let walk=super::retained_walk::RetainedWalk::root(element.id);
        let mut program=Self::voided_parts(element);program.retained=Some(contract);program.retained_walk=Some(walk);
        program.voids.as_mut().expect("void controller").select_retained(contract,program.id);program
    }
    pub fn retained_voided_submeshes(element:DecodedEntity,contract:RetainedContract)->Self {
        let walk=super::retained_walk::RetainedWalk::root(element.id);
        let mut program=Self::voided_submeshes(element);program.retained=Some(contract);program.retained_walk=Some(walk);
        program.voids.as_mut().expect("void controller").select_retained(contract,program.id);program
    }
}
