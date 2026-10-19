// SPDX-License-Identifier: MPL-2.0
//! Synchronous numerical adapter; control and acceptance are shared.
use super::*;
use super::issuance::IssuedRetainedOperation;
use super::value::RealizationKind;
use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker};
impl IssuedRetainedOperation {
    pub(super) fn execute(&self, worker: &mut SmlibWorker, chord: f64, angle: f64,
        limits: ifc_lite_geometry_runtime::MeshLimits, resources: OwnedResourceContext) -> Result<CommonRetainedRealization, RetainedExecutionError> {
        let result = match self {
            Self::Construction(request)=>worker.evaluate_retained_extrusion(request.clone(),chord,angle,limits)
                .map(|v|RealizationKind::Construction(Box::new(v))),
            Self::Affine {input,matrix}=>worker.copy_retained_affine(input.transform_input(),*matrix)
                .map(|v|RealizationKind::Affine(Box::new(v))),
            Self::Boolean {inputs,values,operation}=>worker.evaluate_retained_boolean(
                inputs[0].dependency(&values[0])?, inputs[1].dependency(&values[1])?,*operation,chord,angle,limits)
                .map(|v|RealizationKind::Boolean(Box::new(v))),
        };
        result.map(|kind|CommonRetainedRealization::new(kind,resources))
            .map_err(|e|RetainedExecutionError::Runtime(e.to_string()))
    }
}

impl IssuedCommonConstruction {
    /// Execute the immutable ordered numerical batch under captured resources.
    pub fn execute(mut self, worker: &mut SmlibWorker, chord: f64, angle: f64, limits: MeshLimits)
        -> Result<CompletedCommonConstruction, RetainedExecutionError> {
        if let Err(error) = self.check_worker(worker) {
            self.armed = false; // A foreign supplied worker grants no retirement authority.
            return Err(error);
        }
        self.validate_limits(chord, angle, limits.max_bytes)?;
        let mut values = self.start()?;
        for operation in &self.operations {
            self.checkpoint()?;
            let permit = self.reserve_receipt()?;
            let value = self.resources.with_scope(|| operation.execute(worker, chord, angle, limits, self.resources.clone()));
            let value = self.preserve_fault(value)?;
            self.checkpoint()?;
            value.validate_live().map_err(protocol)?;
            permit.retain();
            values.push(Arc::new(value));
        }
        let completed = self.finish(values)?;
        self.armed = false;
        Ok(completed)
    }
}
