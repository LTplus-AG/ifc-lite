// SPDX-License-Identifier: MPL-2.0
//! Native and Worker share the same issued region, ordered inputs and checks.
use super::*;
use runtime::{RetainedExecutor,AsyncRetainedExecutor};
impl<R: NumericalReceipt> DerivedLayersIssued<R> {
    fn checkpoint(&self) -> Result<(),RetainedExecutionError> {
        if self.token.stage.load(Ordering::Acquire)==CANCELLED { return Err(protocol("J3 cancelled")); }
        self.resources.check().map_err(RetainedExecutionError::Stopped)?;
        self.lifecycle.validate().map_err(|_| RetainedExecutionError::Source)?;
        self.host.realization.validate_live().map_err(protocol)?;
        if self.domain.incarnation().is_none() { return Err(protocol("J3 retired domain")); }
        Ok(())
    }
    fn intersection<'a>(&'a self, region: &'a RegionRequest, receipt: &'a R) -> Invocation<'a,R> {
        Invocation::DerivedMaterialIntersection { binding:&region.binding,host:self.host.operand(),
            region:Operand::Source { receipt,world_from_source:region.world_from_region } }
    }
    fn reserve(&self) -> Result<Vec<DerivedLayerBandResult<R>>,RetainedExecutionError> {
        let mut bands = Vec::new();
        self.resources.reserve_headers(&mut bands,self.regions.len()).map_err(RetainedExecutionError::Stopped)?.retain();
        self.resources.with_scope(|| resource::charge(resource::Cost {
            live_bytes:R::heap_bytes().saturating_mul(2).saturating_mul(self.regions.len() as u64),
            work:self.regions.len() as u64,..Default::default() }))
            .map_err(RetainedExecutionError::Stopped)?.retain();
        Ok(bands)
    }
    pub fn execute(mut self, worker: &mut impl RetainedExecutor<Receipt=R>,limits:NumericalLimits)
        -> Result<DerivedLayersCompleted<R>,RetainedExecutionError> {
        self.checkpoint()?;
        if !self.domain.same_domain(&worker.domain()) { return Err(protocol("J3 foreign executor")); }
        self.token.stage.compare_exchange(ISSUED,EXECUTING,Ordering::AcqRel,Ordering::Acquire)
            .map_err(|_|protocol("J3 repeated execution"))?;
        let mut bands = self.reserve()?;
        for region in &self.regions {
            self.checkpoint()?;
            let receipt = worker.invoke(Invocation::DerivedMaterialRegion { request:&region.request,binding:&region.binding },limits,&self.resources)?;
            validate_region(region,&receipt,&self.domain)?;
            let result = worker.invoke(self.intersection(region,&receipt),limits,&self.resources)?;
            self.checkpoint()?;
            let empty = validate_intersection(&self.host,region,&receipt,&result,&self.domain)?;
            bands.push(DerivedLayerBandResult { region:receipt,result,empty });
        }
        self.token.stage.compare_exchange(EXECUTING,DELIVERED,Ordering::AcqRel,Ordering::Acquire)
            .map_err(|_|protocol("J3 cancelled execution"))?;
        self.armed = false;
        let completed = DerivedLayersCompleted { issued:self,bands };
        completed.validate()?;
        Ok(completed)
    }
    pub async fn execute_async(mut self, worker: &mut impl AsyncRetainedExecutor<Receipt=R>,limits:NumericalLimits)
        -> Result<DerivedLayersCompleted<R>,RetainedExecutionError> {
        self.checkpoint()?;
        if !self.domain.same_domain(&worker.domain()) { return Err(protocol("J3 foreign executor")); }
        self.token.stage.compare_exchange(ISSUED,EXECUTING,Ordering::AcqRel,Ordering::Acquire)
            .map_err(|_|protocol("J3 repeated execution"))?;
        let mut bands = self.reserve()?;
        for region in &self.regions {
            self.checkpoint()?;
            let receipt = worker.invoke(Invocation::DerivedMaterialRegion { request:&region.request,binding:&region.binding },limits,&self.resources).await?;
            self.checkpoint()?;
            validate_region(region,&receipt,&self.domain)?;
            let result = worker.invoke(self.intersection(region,&receipt),limits,&self.resources).await?;
            self.checkpoint()?;
            let empty = validate_intersection(&self.host,region,&receipt,&result,&self.domain)?;
            bands.push(DerivedLayerBandResult { region:receipt,result,empty });
        }
        self.token.stage.compare_exchange(EXECUTING,DELIVERED,Ordering::AcqRel,Ordering::Acquire)
            .map_err(|_|protocol("J3 cancelled execution"))?;
        self.armed = false;
        let completed = DerivedLayersCompleted { issued:self,bands };
        completed.validate()?;
        Ok(completed)
    }
}
impl<R: NumericalReceipt> DerivedLayersCompleted<R> {
    pub(super) fn validate(&self) -> Result<(),RetainedExecutionError> {
        self.issued.checkpoint()?;
        if self.bands.len()!=self.issued.regions.len() || self.bands.is_empty() {
            return Err(protocol("J3_PARTIAL_COMMIT: incomplete band manifest"));
        }
        for (ordinal,(region,band)) in self.issued.regions.iter().zip(&self.bands).enumerate() {
            if region.binding.ordinal != ordinal {
                return Err(protocol("J3_PARTIAL_COMMIT: material order/count"));
            }
            validate_region(region,&band.region,&self.issued.domain)?;
            let empty = validate_intersection(&self.issued.host,region,&band.region,&band.result,&self.issued.domain)?;
            if empty != band.empty { return Err(protocol("J3 outcome mismatch")); }
        }
        if self.bands.iter().all(|b| b.empty) {
            return Err(RetainedExecutionError::Unsupported("J3 authenticated Empty: whole-removal policy unproved"));
        }
        Ok(())
    }
}
fn validate_region<R: NumericalReceipt>(region:&RegionRequest,receipt:&R,domain:&R::Domain)
    -> Result<(),RetainedExecutionError> {
    receipt.validate_live().map_err(protocol)?;
    if !receipt.belongs_to_domain(domain) { return Err(protocol("J3_AUTHORITY: foreign region domain")); }
    let ReceiptEvidence::Construction(completion) = receipt.evidence() else { return Err(protocol("J3 region receipt kind")); };
    if !region.request.same_admission(completion.request()) { return Err(protocol("J3_AUTHORITY: foreign derived region")); }
    region.document.validate_retained_completion(completion,domain.incarnation().ok_or_else(||protocol("J3 retired"))?)
        .map_err(protocol)
}
fn bits(a:&[f64;16],b:&[f64;16]) -> bool { a.iter().zip(b).all(|(a,b)|a.to_bits()==b.to_bits()) }
fn validate_intersection<R: NumericalReceipt>(host:&BooleanInput<R>,region:&RegionRequest,cutter:&R,result:&R,domain:&R::Domain)
    -> Result<bool,RetainedExecutionError> {
    result.validate_live().map_err(protocol)?;
    if !result.belongs_to_domain(domain) || !host.realization.kind.belongs_to_domain(domain) {
        return Err(protocol("J3_AUTHORITY: foreign intersection domain"));
    }
    let ReceiptEvidence::Boolean { operation,left,right,world_from_left,world_from_right,world_from_evaluation,empty } = result.evidence()
        else { return Err(protocol("J3 intersection receipt kind")); };
    let frame = ifc_lite_geometry::document::retained_frames::multiply(region.world_from_region,region.request.payload().source_from_evaluation);
    if operation!=ifc_lite_geometry::BoolOp::Intersection || left!=host.realization.kind.object()
        || right!=cutter.object() || result.object()==left || result.object()==right
        || !bits(world_from_left,&host.frame) || !bits(world_from_right,&frame)
        || !bits(world_from_evaluation,&region.binding.frame) {
        return Err(protocol("J3_AUTHORITY: ordered net-host/region/frame"));
    }
    Ok(empty)
}
