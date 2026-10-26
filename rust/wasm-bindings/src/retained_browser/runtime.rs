// SPDX-License-Identifier: MPL-2.0
//! Target-neutral executor seam over the one private wasm32 Worker driver.
use super::{
    bridge::{driver_error, Mesh},
    receipt::{BrowserReceipt, Lease},
    *,
};
use ifc_lite_geometry::{
    document::{retained_wire as wire, RetainedTessellation},
    BoolOp,
};
use ifc_lite_processing::element::retained_runtime::{
    AsyncRetainedExecutor, Invocation, NumericalLimits, NumericalReceipt, Operand, RetainedRuntime,
    RuntimeFault,
};
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

impl RetainedRuntime for BrowserWorker {
    type Receipt = BrowserReceipt;
    fn domain(&self) -> BrowserCancellation {
        self.cancellation()
    }
    fn incarnation(&self) -> u64 {
        BrowserWorker::incarnation(self)
    }
}
impl AsyncRetainedExecutor for BrowserWorker {
    async fn invoke(
        &mut self,
        call: Invocation<'_, BrowserReceipt>,
        limits: NumericalLimits,
    ) -> Result<BrowserReceipt, RuntimeFault> {
        let max_bytes = u32::try_from(limits.max_bytes)
            .map_err(|_| RuntimeFault::resource_limit("wasm mesh byte budget exceeds u32"))?;
        evaluation_limits(limits.chord_metres, limits.angle_degrees, max_bytes)?;
        match call {
            Invocation::Construction(request) => self
                .evaluate_retained(
                    request.clone(),
                    limits.chord_metres,
                    limits.angle_degrees,
                    max_bytes,
                )
                .await
                .map(BrowserReceipt::Construction)
                .map_err(Into::into),
            Invocation::Affine {
                input,
                column_major,
            } => self.affine(input, column_major).await,
            Invocation::Boolean {
                left,
                right,
                operation,
            } => {
                self.boolean(left, right, operation, limits, max_bytes)
                    .await
            }
        }
    }
}

fn field(value: &JsValue, name: &str) -> Result<JsValue, BrowserError> {
    js_sys::Reflect::get(value, &JsValue::from_str(name)).map_err(driver_error)
}
fn invalid(message: &'static str) -> RuntimeFault {
    RuntimeFault::transport(message)
}
impl BrowserWorker {
    fn validate_input(&self, input: &BrowserReceipt) -> Result<(), RuntimeFault> {
        input.validate_live()?;
        if !input.belongs_to_domain(&self.cancellation()) {
            return Err(BrowserError::WrongWorker.into());
        }
        Ok(())
    }
    fn seal(&self, value: &JsValue) -> Result<Lease, BrowserError> {
        let object = field(value, "object")?;
        self.owner.validate()?;
        if !self.owner.driver.object_live(&object) {
            return Err(BrowserError::WrongWorker);
        }
        Ok(Lease {
            domain: self.cancellation(),
            object,
        })
    }
    async fn affine(
        &mut self,
        input: &BrowserReceipt,
        matrix: [f64; 16],
    ) -> Result<BrowserReceipt, RuntimeFault> {
        self.validate_input(input)?;
        wire::validate_affine(&matrix).map_err(invalid)?;
        let mut flight = InFlight::new(&self.owner);
        let response = JsFuture::from(self.owner.driver.affine(&input.object(), &matrix)).await;
        let value = match response {
            Ok(value) => value,
            Err(error) => {
                let error = driver_error(error);
                // Known pre-copy kernel refusal leaves the source domain live.
                if matches!(&error, BrowserError::Kernel { status, .. } if (1..=7).contains(status))
                {
                    flight.disarm();
                }
                return Err(error.into());
            }
        };
        let certificate = js_sys::Uint8Array::new(&field(&value, "certificate")?).to_vec();
        wire::AffineCertificate::decode(&certificate).map_err(invalid)?;
        let lease = self.seal(&value)?;
        flight.disarm();
        Ok(BrowserReceipt::Affine {
            lease,
            input: input.object(),
            matrix,
        })
    }
    async fn boolean(
        &mut self,
        left: Operand<'_, BrowserReceipt>,
        right: Operand<'_, BrowserReceipt>,
        operation: BoolOp,
        limits: NumericalLimits,
        max_bytes: u32,
    ) -> Result<BrowserReceipt, RuntimeFault> {
        let (left, world_left) = operand(left)?;
        let (right, world_right) = operand(right)?;
        self.validate_input(left)?;
        self.validate_input(right)?;
        let relative = wire::relative(world_left, world_right).map_err(invalid)?;
        let opcode = match operation {
            BoolOp::Union => 1,
            BoolOp::Intersection => 2,
            BoolOp::Difference => 3,
            BoolOp::Unknown => return Err(invalid("unknown Boolean operation")),
        };
        let mut flight = InFlight::new(&self.owner);
        let value = JsFuture::from(self.owner.driver.boolean_call(
            &left.object(),
            &right.object(),
            &relative,
            opcode,
            limits.chord_metres,
            limits.angle_degrees,
            max_bytes,
        ))
        .await
        .map_err(driver_error)?;
        let empty = field(&value, "empty")?
            .as_bool()
            .ok_or_else(|| invalid("invalid empty certificate"))?;
        let mesh = field(&value, "mesh")?;
        let mesh = if empty {
            if !mesh.is_null() {
                return Err(invalid("empty result carried a mesh"));
            }
            None
        } else {
            let mesh: Mesh = serde_wasm_bindgen::from_value(mesh)
                .map_err(|e| RuntimeFault::transport(e.to_string()))?;
            Some(RetainedTessellation {
                positions: mesh.positions,
                indices: mesh.indices,
                flat_corner_normals: mesh.flat_corner_normals,
                revision_local_faces: mesh.revision_local_faces,
                source_face_count: mesh.source_face_count,
                boundary_edges: mesh.boundary_edges,
                spine_edges: mesh.spine_edges,
            })
        };
        let lease = self.seal(&value)?;
        flight.disarm();
        Ok(BrowserReceipt::Boolean {
            lease,
            operation,
            left: left.object(),
            right: right.object(),
            world_left,
            world_right,
            mesh,
        })
    }
}
fn operand(
    input: Operand<'_, BrowserReceipt>,
) -> Result<(&BrowserReceipt, [f64; 16]), RuntimeFault> {
    let (receipt, frame) = match input {
        Operand::Source {
            receipt,
            world_from_source,
        } => {
            let BrowserReceipt::Construction(value) = receipt else {
                return Err(invalid("source operand is not a construction receipt"));
            };
            // Source frame is in raw file units; the sealed request supplies the
            // conversion into evaluation metres. The evaluator never sees a survey origin.
            (
                receipt,
                wire::multiply(world_from_source, value.completion.source_from_evaluation),
            )
        }
        Operand::Placed {
            receipt,
            world_from_object,
        } => (receipt, world_from_object),
    };
    wire::rigid(frame).map_err(invalid)?;
    Ok((receipt, frame))
}
