// SPDX-License-Identifier: MPL-2.0
//! Reached operations bind ordered live inputs from this transaction's ledger.
use super::*;
pub(super) enum PendingRetainedOperation<R: NumericalReceipt> {
    UnaryClip { expected: Box<RetainedPlanOperation>, input: BooleanInput<R> },
    Boolean { expected: Box<RetainedPlanOperation>, inputs: Box<[BooleanInput<R>; 2]>, operation: ifc_lite_geometry::BoolOp },
    Construction { expected: Box<RetainedPlanOperation>, document: GeometryDocument, request: RetainedRequest },
    Affine { expected: Box<RetainedPlanOperation>, input: Arc<RuntimeRealization<R>>, matrix: [f64; 16] },
}
impl<R: NumericalReceipt> PendingRetainedOperation<R> {
    pub(super) fn expected(&self) -> &RetainedPlanOperation {
        match self { Self::UnaryClip { expected, .. } | Self::Construction { expected, .. } | Self::Affine { expected, .. } | Self::Boolean { expected, .. } => expected }
    }
}
pub(super) enum IssuedRetainedOperation<R: NumericalReceipt> {
    UnaryClip { input: BooleanInput<R>, clip: Box<ifc_lite_geometry::program::RetainedUnaryClip>, definition: LogicalRetainedDefinition },
    Boolean { inputs: Box<[BooleanInput<R>; 2]>, operation: ifc_lite_geometry::BoolOp, definition: LogicalRetainedDefinition },
    Construction { request: RetainedRequest, definition: LogicalRetainedDefinition },
    Affine { input: Arc<RuntimeRealization<R>>, matrix: [f64; 16], definition: LogicalRetainedDefinition },
}
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    pub(super) fn input(&self, value: &LogicalRetainedValue) -> Result<Arc<RuntimeRealization<R>>, RetainedExecutionError> {
        for (definition, receipt) in &self.ledger {
            resource::charge(resource::Cost { work: 1, ..Default::default() }).map_err(RetainedExecutionError::Stopped)?.retain();
            if definition.definition() == value.definition() {
                receipt.validate_live().map_err(protocol)?;
                return Ok(receipt.clone());
            }
        }
        Err(protocol("undischarged retained input"))
    }
    pub(super) fn prepare_operations(&self, operations: Vec<RetainedPlanOperation>, worker: &impl RetainedRuntime<Receipt = R>)
        -> Result<Vec<PendingRetainedOperation<R>>, RetainedExecutionError> {
        let mut pending = Vec::new();
        self.resources.reserve_headers(&mut pending, operations.len()).map_err(RetainedExecutionError::Stopped)?.retain();
        for expected in operations {
            resource::charge(resource::Cost { live_bytes: std::mem::size_of::<RetainedPlanOperation>() as u64,
                work: 1, ..Default::default() }).map_err(RetainedExecutionError::Stopped)?.retain();
            let expected = Box::new(expected);
            let operation = match expected.kind() {
                RetainedOperationKind::UnaryClip { input, .. } => {
                    let input = BooleanInput::new(self.input(input)?, input)?;
                    if !input.realization.owner().same_domain(&worker.domain()) { return Err(protocol("foreign clip input runtime")); }
                    PendingRetainedOperation::UnaryClip { expected, input }
                }
                RetainedOperationKind::Construction(recipe) => {
                    let mut document = GeometryDocument::new();
                    let definition = match recipe {
                        RetainedRecipe::Extrusion(recipe) => document.add_retained_extrusion(recipe.clone()),
                        RetainedRecipe::RegularizedExtrusion(recipe) => document.add_retained_region_extrusion(recipe.clone()),
                        RetainedRecipe::SweptDisk(recipe) => document.add_retained_swept_disk(recipe.clone()),
                        _ => return Err(RetainedExecutionError::Unsupported("construction recipe")),
                    }.map_err(protocol)?;
                    let request = document.prepare_retained(definition, worker.incarnation()).map_err(protocol)?;
                    let request = if worker.source_face_binding() && request.payload().format==1 {
                        let LogicalRetainedDefinition::Source { source_epoch, source_revision, .. }=expected.value().definition() else {
                            return Err(protocol("construction lacks original source definition"));
                        };
                        request.with_source_contract(*source_epoch,*source_revision).map_err(protocol)?
                    } else { request };
                    PendingRetainedOperation::Construction { expected, document, request }
                }
                RetainedOperationKind::Boolean { inputs, operation } => {
                    let operation = boolean_input::operation(*operation)?;
                    let left = BooleanInput::new(self.input(&inputs[0])?, &inputs[0])?;
                    let right = BooleanInput::new(self.input(&inputs[1])?, &inputs[1])?;
                    for input in [&left, &right] {
                        if !input.realization.owner().same_domain(&worker.domain()) {
                            return Err(protocol("foreign Boolean input runtime"));
                        }
                    }
                    resource::charge(resource::Cost { live_bytes: std::mem::size_of::<[BooleanInput<R>; 2]>() as u64,
                        ..Default::default() }).map_err(RetainedExecutionError::Stopped)?.retain();
                    PendingRetainedOperation::Boolean { expected, inputs: Box::new([left, right]), operation }
                }
                RetainedOperationKind::Affine { input, matrix } => {
                    let input = self.input(input)?;
                    if !input.owner().same_domain(&worker.domain()) { return Err(protocol("foreign affine input runtime")); }
                    let matrix = *matrix;
                    PendingRetainedOperation::Affine { expected, input, matrix }
                }
            };
            pending.push(operation);
        }
        Ok(pending)
    }
    pub(super) fn copy_issued_operations(&self, operations: &[PendingRetainedOperation<R>])
        -> Result<Vec<IssuedRetainedOperation<R>>, RetainedExecutionError> {
        let mut issued = Vec::new();
        self.resources.reserve_headers(&mut issued, operations.len()).map_err(RetainedExecutionError::Stopped)?.retain();
        for operation in operations {
            if matches!(operation, PendingRetainedOperation::Boolean { .. }) {
                resource::charge(resource::Cost { live_bytes: std::mem::size_of::<[BooleanInput<R>; 2]>() as u64,
                    ..Default::default() }).map_err(RetainedExecutionError::Stopped)?.retain();
            }
            issued.push(match operation {
                PendingRetainedOperation::UnaryClip { expected, input } => {
                    let RetainedOperationKind::UnaryClip { clip, .. } = expected.kind() else { return Err(protocol("missing clip source")); };
                    resource::charge(resource::Cost { copy_bytes: std::mem::size_of_val(clip.as_ref()) as u64,
                        live_bytes: std::mem::size_of_val(clip.as_ref()) as u64, ..Default::default() })
                        .map_err(RetainedExecutionError::Stopped)?.retain();
                    IssuedRetainedOperation::UnaryClip { input: input.clone(), clip: clip.clone(), definition: expected.value().definition().clone() }
                }
                PendingRetainedOperation::Boolean { expected, inputs, operation } => IssuedRetainedOperation::Boolean {
                    inputs: inputs.clone(), operation: *operation, definition: expected.value().definition().clone() },
                PendingRetainedOperation::Construction { expected, request, .. } => IssuedRetainedOperation::Construction { request: request.clone(), definition: expected.value().definition().clone() },
                PendingRetainedOperation::Affine { expected, input, matrix } => IssuedRetainedOperation::Affine { input: input.clone(), matrix: *matrix, definition: expected.value().definition().clone() },
            });
        }
        Ok(issued)
    }
}

impl<R: NumericalReceipt> IssuedRetainedOperation<R> {
    pub(super) fn definition(&self) -> &LogicalRetainedDefinition {
        match self { Self::UnaryClip { definition, .. } | Self::Construction { definition, .. } | Self::Affine { definition, .. } | Self::Boolean { definition, .. } => definition }
    }
}

impl<R: NumericalReceipt> IssuedRetainedOperation<R> {
    pub(super) fn invocation(&self) -> runtime::Invocation<'_, R> {
        match self {
            Self::UnaryClip { input, clip, .. } => runtime::Invocation::UnaryClip { input: input.operand(), clip },
            Self::Boolean { inputs, operation, .. } => runtime::Invocation::Boolean {
                left: inputs[0].operand(), right: inputs[1].operand(), operation: *operation },
            Self::Construction { request, .. } => runtime::Invocation::Construction(request),
            Self::Affine { input, matrix, .. } => runtime::Invocation::Affine { input: &input.kind, column_major: *matrix },
        }
    }
}
