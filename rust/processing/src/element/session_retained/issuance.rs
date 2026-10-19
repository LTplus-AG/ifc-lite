// SPDX-License-Identifier: MPL-2.0
//! Bind each reached common operation to ordered live sealed operands.
use super::*;
use super::value::RealizationKind;
use ifc_lite_geometry::program::{LogicalRetainedValue, RetainedOperationKind};

pub(super) enum IssuedRetainedOperation {
    Construction(RetainedRequest),
    Affine { input: Arc<CommonRetainedRealization>, matrix: [f64;16] },
    Boolean { inputs: [Arc<CommonRetainedRealization>;2], values: Box<[LogicalRetainedValue;2]>,
        operation: ifc_lite_geometry::document::BooleanOperation },
}
impl RetainedProductExecution {
    fn input(&self, value: &LogicalRetainedValue) -> Result<Arc<CommonRetainedRealization>, RetainedExecutionError> {
        for entry in &self.ledger {
            ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                work:1,..Default::default() }).map_err(RetainedExecutionError::Stopped)?.retain();
            if entry.operation.value().definition() == value.definition() {
                entry.receipt.validate_live().map_err(protocol)?;
                return Ok(entry.receipt.clone());
            }
        }
        Err(protocol("undischarged retained operation input"))
    }
    pub(super) fn prepare_operations(&self, operations: Vec<RetainedPlanOperation>, worker: &SmlibWorker)
        -> Result<Vec<PendingRetainedOperation>, RetainedExecutionError> {
        let mut pending = Vec::new();
        self.resources.reserve_headers(&mut pending, operations.len())
            .map_err(RetainedExecutionError::Stopped)?.retain();
        for expected in operations {
            ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                live_bytes: std::mem::size_of::<RetainedPlanOperation>() as u64,..Default::default()
            }).map_err(RetainedExecutionError::Stopped)?.retain();
            let expected=Box::new(expected);
            let operation = match expected.kind() {
                RetainedOperationKind::Construction(source) => {
                    let mut document = GeometryDocument::new();
                    let definition = document.add_retained_construction(source.clone())
                        .map_err(|e|RetainedExecutionError::Unsupported(e.to_string()))?;
                    let request = document.prepare_retained_extrusion(definition,
                        EvaluationContract::RetainedBrep, worker.incarnation())
                        .map_err(|e|RetainedExecutionError::Unsupported(e.to_string()))?;
                    PendingRetainedOperation::Construction {expected,request,document}
                }
                RetainedOperationKind::Affine {input,matrix} => {
                    let input = self.input(input)?;
                    let matrix = *matrix;
                    PendingRetainedOperation::Affine {expected,input,matrix}
                }
                RetainedOperationKind::Boolean {inputs,..} => {
                    let inputs = [self.input(&inputs[0])?,self.input(&inputs[1])?];
                    PendingRetainedOperation::Boolean {expected,inputs}
                }
            };
            pending.push(operation);
        }
        Ok(pending)
    }
    pub(super) fn copy_issued_operations(&self, operations: &[PendingRetainedOperation])
        -> Result<Vec<IssuedRetainedOperation>, RetainedExecutionError> {
        let mut issued = Vec::new();
        self.resources.reserve_headers(&mut issued, operations.len())
            .map_err(RetainedExecutionError::Stopped)?.retain();
        for operation in operations {
            issued.push(match operation {
                PendingRetainedOperation::Construction {request,..}=>IssuedRetainedOperation::Construction(request.clone()),
                PendingRetainedOperation::Affine {input,matrix,..}=>IssuedRetainedOperation::Affine {input:input.clone(),matrix:*matrix},
                PendingRetainedOperation::Boolean {expected,inputs}=> {
                    let RetainedOperationKind::Boolean {inputs:values,operation}=expected.kind() else {unreachable!()};
                    ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                        live_bytes:std::mem::size_of::<[LogicalRetainedValue;2]>() as u64,..Default::default()
                    }).map_err(RetainedExecutionError::Stopped)?.retain();
                    IssuedRetainedOperation::Boolean {inputs:inputs.clone(),values:Box::new([
                        values[0].try_copy().map_err(protocol)?,values[1].try_copy().map_err(protocol)?]),operation:*operation}
                }
            });
        }
        Ok(issued)
    }
}
impl IssuedRetainedOperation {
    pub(super) fn execute(self, worker: &mut SmlibWorker, chord: f64, angle: f64,
        limits: ifc_lite_geometry_runtime::MeshLimits, resources: OwnedResourceContext) -> Result<CommonRetainedRealization, RetainedExecutionError> {
        let result = match self {
            Self::Construction(request)=>worker.evaluate_retained_extrusion(request,chord,angle,limits)
                .map(|v|RealizationKind::Construction(Box::new(v))),
            Self::Affine {input,matrix}=>worker.copy_retained_affine(input.transform_input(),matrix)
                .map(|v|RealizationKind::Affine(Box::new(v))),
            Self::Boolean {inputs,values,operation}=>worker.evaluate_retained_boolean(
                inputs[0].dependency(&values[0])?, inputs[1].dependency(&values[1])?,operation,chord,angle,limits)
                .map(|v|RealizationKind::Boolean(Box::new(v))),
        };
        result.map(|kind|CommonRetainedRealization::new(kind,resources))
            .map_err(|e|RetainedExecutionError::Runtime(e.to_string()))
    }
}
