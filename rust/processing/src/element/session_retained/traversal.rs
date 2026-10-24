// SPDX-License-Identifier: MPL-2.0
//! Advance canonical product/type-map strategies under one retained domain.
use super::*;
impl<'a, R: NumericalReceipt> RuntimeProductExecution<'a, R> {
    pub(super) fn init_type_maps(&mut self) -> Result<(),RetainedExecutionError> {
        if !matches!(&self.state.stage,Stage::TypeMaps(_)) { return Ok(()); }
        let Some(ifc_lite_core::AttributeValue::List(ids)) = self.state.job.entity.get(
            ifc_lite_core::slot::IfcTypeProduct::REPRESENTATION_MAPS.index()) else {
            return Err(RetainedExecutionError::Source);
        };
        self.traversal.charge_source_work(ids.len() as u64).map_err(common)?;
        self.resources.with_scope(|| resource::charge(resource::Cost {
            live_bytes: ids.len() as u64 * std::mem::size_of::<u32>() as u64,
            work: ids.len() as u64, ..Default::default()
        })).map_err(RetainedExecutionError::Stopped)?.retain();
        self.type_map_members.try_reserve(ids.len())
            .map_err(|_| RetainedExecutionError::Stopped(resource::allocation_failure()))?;
        for id in ids {
            let ifc_lite_core::AttributeValue::EntityRef(id) = id else { return Err(RetainedExecutionError::Source) };
            self.type_map_members.insert(*id);
        }
        Ok(())
    }

    pub(super) fn start_next_program(&mut self, decoder: &mut EntityDecoder, router: &GeometryRouter)
        -> Result<(), RetainedExecutionError> {
        self.validate(decoder,router)?;
        self.state.protocol.idle().map_err(protocol)?;
        let Some(kind) = self.state.stage.next_kind() else {
            let values = std::mem::take(&mut self.type_values);
            let plan = self.resources.with_scope(|| RetainedProductPlan::from_type_values(values)).map_err(geometry)?;
            if let Err(error) = self.validate_manifest(&plan) { self.failed = true; return Err(error); }
            self.plan = Some(plan);
            self.outer = None;
            return Ok(());
        };
        let resources = self.resources.clone();
        let prepared = resources.with_scope(|| self.owner.work(decoder,router,|decoder,_| {
            self.scopes.with_scope(|| {
                let textures = self.context.borrowed().texture_index;
                match kind {
                    WorkKind::TypeMap { map_id, class } => {
                        if !self.type_map_members.contains(&map_id) || !matches!(class,1|2) {
                            return Err(RetainedExecutionError::Source);
                        }
                        let map = decoder.decode_by_id(map_id).map_err(|_| RetainedExecutionError::Source)?;
                        if map.ifc_type != IfcType::IfcRepresentationMap { return Err(RetainedExecutionError::Source); }
                        Ok(self.traversal.type_map(map,Some(textures)))
                    }
                    WorkKind::Primary { strategy: super::super::plan::PrimaryStrategy::VoidedSubmeshes, .. }
                    | WorkKind::VoidedParts => {
                        let ids = self.context.borrowed().void_index.get(&self.state.job.id)
                            .map(Vec::as_slice).unwrap_or(&[]);
                        Ok(self.traversal.voided_product(self.state.job.entity, ids))
                    }
                    WorkKind::Primary { .. } => Ok(self.traversal.product_submeshes(self.state.job.entity,true,Some(textures))),
                    WorkKind::PlainParts => Ok(self.traversal.product_parts(self.state.job.entity)),
                }
            })
        })).map_err(protocol).and_then(|(result,_)|result);
        let program = match prepared {
            Ok(program) => program,
            Err(error) => { self.failed = true; return Err(error); }
        };
        self.outer = Some(self.state.protocol.issue(kind));
        self.program = Some(program);
        Ok(())
    }
    pub(super) fn finish_current_program(&mut self, outer: WorkRequest, decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<(), RetainedExecutionError> {
        let resources = self.resources.clone();
        let result = resources.with_scope(|| self.complete_current_program(outer, decoder, router));
        if result.is_err() { self.failed = true; }
        result
    }
    fn complete_current_program(&mut self, outer: WorkRequest, decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<(), RetainedExecutionError> {
        let program = self.program.take().ok_or_else(|| protocol("missing program"))?;
        let mut plan = self.resources.with_scope(|| match outer.kind {
            WorkKind::TypeMap { class, .. } => program.finish_type_map(self.state.job.id,class,self.state.element_color),
            _ => program.finish(),
        }).map_err(geometry)?;
        self.validate_manifest(&plan)?;
        if let Some(source) = &self.layer_source { source.validate(self.context, self.state.job.id)?; }
        self.authenticate_openings(&plan)?;
        self.authenticate_removal(&plan, decoder, router)?;
        if plan.opening_completion.is_some() || matches!(outer.kind,
            WorkKind::Primary { strategy: super::super::plan::PrimaryStrategy::TexturedSubmeshes, .. }
            | WorkKind::PlainParts) {
            plan.remaining.retain(|requirement| *requirement != RetainedRequirement::OpeningClosure);
        }
        self.state.protocol.executed(outer);
        self.state.protocol.accepted();
        self.outer = None;
        match outer.kind {
            WorkKind::TypeMap { .. } => {
                self.resources.reserve_headers(&mut self.type_values,plan.values.len())
                    .map_err(RetainedExecutionError::Stopped)?.retain();
                self.type_values.extend(plan.values);
            }
            WorkKind::Primary { .. } if plan.values.is_empty() => self.state.stage = Stage::PlainParts,
            _ => {
                if self.layer_pending && !plan.remaining.contains(&RetainedRequirement::MaterialLayers) {
                    self.resources.reserve_headers(&mut plan.remaining, 1).map_err(RetainedExecutionError::Stopped)?.retain();
                    plan.remaining.push(RetainedRequirement::MaterialLayers);
                }
                self.plan = Some(plan);
                self.state.stage = Stage::Complete;
            }
        }
        Ok(())
    }
}
