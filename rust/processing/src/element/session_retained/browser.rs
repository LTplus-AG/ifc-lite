// SPDX-License-Identifier: MPL-2.0
//! Only numerical calls await. No source/router/TLS capability enters a batch.
use super::*;
use super::issuance::IssuedRetainedOperation;
use super::value::RealizationKind;
use target::{ConstructionReceipt, AffineReceipt, BooleanReceipt};

enum NumericalReply {
    Construction(ConstructionReceipt), Affine(AffineReceipt), Boolean(BooleanReceipt),
}
impl NumericalReply {
    fn seal(self, resources: OwnedResourceContext) -> CommonRetainedRealization {
        let kind = match self {
            Self::Construction(value)=>RealizationKind::Construction(Box::new(value)),
            Self::Affine(value)=>RealizationKind::Affine(Box::new(value)),
            Self::Boolean(value)=>RealizationKind::Boolean(Box::new(value)),
        };
        CommonRetainedRealization::new(kind, resources)
    }
}
impl IssuedCommonConstruction {
    /// One immutable ordered common batch; never a product source walk or publication.
    /// Dropping even an unpolled future retires only its captured domain.
    pub async fn execute_browser(mut self, worker: &mut SelectedWorker, chord: f64, angle: f64, max_bytes: u32)
        -> Result<CompletedCommonConstruction, RetainedExecutionError> {
        if let Err(error) = self.check_worker(worker) {
            self.armed = false;
            return Err(error);
        }
        self.validate_limits(chord, angle, max_bytes as usize)?;
        let mut values = self.start()?;
        for operation in &self.operations {
            self.checkpoint()?;
            // All resource/lexical scopes end before invoking the actual Worker.
            let permit = self.reserve_receipt()?;
            let result = match operation {
                IssuedRetainedOperation::Construction(request) => {
                    let request = self.resources.with_scope(|| request.clone());
                    worker.evaluate(request, chord, angle, max_bytes).await.map(NumericalReply::Construction)
                }
                IssuedRetainedOperation::Affine { input, matrix } =>
                    worker.copy_retained_affine(input.transform_input(), *matrix).await.map(NumericalReply::Affine),
                IssuedRetainedOperation::Boolean { inputs, values, operation } =>
                    worker.evaluate_retained_boolean(inputs[0].dependency(&values[0])?,
                        inputs[1].dependency(&values[1])?, *operation, chord, angle, max_bytes).await.map(NumericalReply::Boolean),
            };
            // The captured account is authoritative, including on a JS error.
            let result = self.preserve_fault(result.map_err(|error|
                RetainedExecutionError::Runtime(format!("{error:?}"))))?;
            self.checkpoint()?;
            let value = self.resources.with_scope(|| result.seal(self.resources.clone()));
            value.validate_live().map_err(protocol)?;
            permit.retain();
            self.resources.with_scope(|| values.push(Arc::new(value)));
        }
        let completed = self.finish(values)?;
        self.armed = false;
        Ok(completed)
    }
}
