// SPDX-License-Identifier: MPL-2.0
//! Advance canonical product/type-map strategies under one retained domain.
use super::*;
impl<'a, R: NumericalReceipt> RuntimeProductExecution<'a, R> {
    pub(super) fn init_type_maps(&mut self) -> Result<(),RetainedExecutionError> {
        if !matches!(&self.state.stage,Stage::TypeMaps(_)) { return Ok(()); }
        let Some(ifc_lite_core::AttributeValue::List(ids)) = self.state.job.entity.get(
            ifc_lite_core::slot::IfcTypeProduct::REPRESENTATION_MAPS.index()) else {
            return Err(RetainedExecutionError::Source(RetainedContextError::Mismatched));
        };
        self.scratch.reserve(&self.resources, &mut self.type_map_members, ids.len())?;
        self.resources.with_scope(|| resource::charge(resource::Cost {
            work: ids.len() as u64, ..Default::default()
        })).map_err(RetainedExecutionError::Stopped)?.retain();
        for id in ids {
            let ifc_lite_core::AttributeValue::EntityRef(id) = id else { return Err(RetainedExecutionError::Source(RetainedContextError::Mismatched)) };
            self.type_map_members.push(*id);
        }
        Ok(())
    }

    pub(super) fn start_next_program(&mut self, decoder: &mut EntityDecoder, router: &GeometryRouter)
        -> Result<(), RetainedExecutionError> {
        self.validate(decoder,router)?;
        self.state.protocol.idle().map_err(protocol)?;
        let Some(kind) = self.state.stage.next_kind() else {
            let values = std::mem::take(&mut self.type_values);
            let plan = self.resources.with_scope(|| RetainedProductPlan::type_maps(values)).map_err(common)?;
            if let Err(error) = self.validate_manifest(&plan) { self.failed = true; return Err(error); }
            self.plan = Some(plan);
            self.outer = None;
            return Ok(());
        };
        if !matches!(kind, WorkKind::Primary { strategy: super::super::plan::PrimaryStrategy::TexturedSubmeshes, .. }
            | WorkKind::PlainParts | WorkKind::TypeMap { .. }) {
            self.failed = true;
            return Err(RetainedExecutionError::Unsupported(Unsupported::RetainedOpeningStrategy));
        }
        if matches!(kind, WorkKind::Primary { layer_class, .. } if layer_class != 0) {
            self.failed = true;
            return Err(RetainedExecutionError::Unsupported(Unsupported::RetainedMaterialLayerStrategy));
        }
        let resources = self.resources.clone();
        let prepared = resources.with_scope(|| self.owner.work(decoder,router,|decoder,_| {
            self.scopes.with_scope(|| {
                let textures = self.context.borrowed().texture_index;
                match kind {
                    WorkKind::TypeMap { map_id, class } => {
                        if !self.type_map_members.contains(&map_id) || !matches!(class,1|2) {
                            return Err(RetainedExecutionError::Source(RetainedContextError::Mismatched));
                        }
                        let map = decoder.decode_by_id(map_id).map_err(RetainedExecutionError::Core)?;
                        if map.ifc_type != IfcType::IfcRepresentationMap { return Err(RetainedExecutionError::Source(RetainedContextError::Mismatched)); }
                        Ok(self.traversal.type_map(map, textures))
                    }
                    WorkKind::Primary { .. } => Ok(self.traversal.product_submeshes(self.state.job.entity, textures)),
                    WorkKind::PlainParts => Ok(self.traversal.product_parts(self.state.job.entity)),
                    _ => Err(RetainedExecutionError::Unsupported(Unsupported::RetainedStrategy)),
                }
            })
        })).map_err(protocol).and_then(|(result,_)|result);
        check_resources(&self.resources)?;
        self.context.validate_decoder(decoder).map_err(RetainedExecutionError::Source)?;
        let program = match prepared {
            Ok(program) => program,
            Err(error) => { self.failed = true; return Err(error); }
        };
        self.outer = Some(self.state.protocol.issue(kind));
        self.program = Some(program);
        Ok(())
    }
    pub(super) fn finish_current_program(&mut self, outer: WorkRequest) -> Result<(), RetainedExecutionError> {
        let result = self.complete_current_program(outer);
        if result.is_err() { self.failed = true; }
        result
    }
    fn complete_current_program(&mut self, outer: WorkRequest) -> Result<(), RetainedExecutionError> {
        let program = self.program.take().ok_or_else(|| protocol(ReceiptFailure::MissingProgram))?;
        let plan = self.resources.with_scope(|| match outer.kind {
            WorkKind::TypeMap { class, .. } => program.finish_type_map(self.state.job.id,class,self.state.element_color),
            _ => program.finish(),
        }).map_err(common)?;
        self.validate_manifest(&plan)?;
        self.state.protocol.executed(outer);
        self.state.protocol.accepted();
        self.outer = None;
        match outer.kind {
            WorkKind::TypeMap { .. } => {
                self.scratch.reserve(&self.resources, &mut self.type_values, 1)?;
                self.type_values.push(plan);
            }
            WorkKind::Primary { .. } if plan.values().len() == 0 => self.state.stage = Stage::PlainParts,
            _ => {
                self.plan = Some(plan);
                self.state.stage = Stage::Complete;
            }
        }
        Ok(())
    }
}
