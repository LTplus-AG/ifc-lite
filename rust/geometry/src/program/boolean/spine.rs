// SPDX-License-Identifier: MPL-2.0
//! One spine node, innermost first: its operator and SecondOperand admitted
//! at source, then the cut applied as owned arithmetic.
//!
//! A plane half-space is lowered at source and clipped numerically. A
//! polygonal-bounded half-space (#3923) has its plane lowered at source,
//! the kept-side check run numerically, its prism boundary read at source,
//! and the prism built and subtracted numerically, falling back to the
//! unbounded clip on record. A solid operand is meshed on the stack and the
//! solid/solid boolean runs as its own numerical step.
//!
//! `solo_step`: true when this is the ONLY node the spine walk deferred to (a
//! genuine single-PBHS-cutter DIFFERENCE, #3923's target shape); false when it
//! is one of several nodes from a longer authored chain that could not be
//! batched and is applied one cutter at a time. It gates the
//! accept-gate-rejection fallback (see `single_cutter_gate.rs`).
use super::state::{Cut, CutPlane, Frame, Steps};
use super::BooleanMachine;
use crate::processors::boolean::{
    boolean_operator, host_stays_on_kept_side, BoundedPrismPlan, HalfSpacePlan, SingleCutterSubtract,
};
use crate::processors::BooleanClippingProcessor;
use crate::{BoolFailureReason, BoolOp, Mesh, Result};
use ifc_lite_core::{EntityDecoder, IfcType};

impl BooleanMachine {
    /// Admit the next spine node's source, innermost first.
    pub(super) fn steps(&mut self, mut steps: Steps, recorder: &BooleanClippingProcessor,
        decoder: &mut EntityDecoder) -> Result<()> {
        if steps.retained.is_some() { return self.retained_steps(steps, recorder, decoder); }
        let Some(node) = steps.nodes.pop() else {
            self.value = Some((steps.mesh, steps.empty_recorded));
            return Ok(());
        };
        if steps.mesh.is_empty() {
            match boolean_operator(&node) {
                // DIFFERENCE or INTERSECTION of nothing is nothing: skip the
                // step (a UNION higher up still gets its second operand).
                Ok(BoolOp::Difference | BoolOp::Intersection) => {
                    self.frames.push(Frame::Steps(steps));
                    return Ok(());
                }
                // UNION(empty, B) = B: the step runs on the second operand
                // alone, and the emptied first operand is on record once.
                Ok(BoolOp::Union) => {
                    recorder.record_empty_operand(BoolOp::Union, steps.empty_recorded);
                    steps.empty_recorded = true;
                }
                // Unknown or unreadable: the step records it, mesh unchanged.
                Ok(BoolOp::Unknown) | Err(_) => {}
            }
        }
        let host = std::mem::take(&mut steps.mesh);
        // An unknown or unreadable operator is recorded BEFORE SecondOperand is
        // resolved: that operand is unused, and a `$` there must not turn the
        // record into an `Err` that drops the parent's host.
        let operator = match boolean_operator(&node) {
            Ok(op @ (BoolOp::Difference | BoolOp::Union | BoolOp::Intersection)) => op,
            other => {
                let keyword = other.map_or_else(str::to_string, |op| op.to_string());
                recorder.record_failure(BoolOp::Unknown, BoolFailureReason::UnknownBooleanOperator(keyword));
                return self.applied(steps, (host, false));
            }
        };
        // Sequential, one step per spine node (web-ifc's behaviour): the
        // per-step cutter is always a single closed manifold prism, so the
        // non-manifold-cutter artefacts of mesh-merged batching (#583) cannot
        // arise. Grouped batching of provably safe PBHS chains is the batched
        // chain (#960).
        let Some(second) = recorder.second_operand_or_record(operator, &node, decoder) else {
            // INTERSECTION with nothing is nothing; the loss is on record.
            let dropped = operator == BoolOp::Intersection;
            return self.applied(steps, if dropped { (Mesh::new(), true) } else { (host, false) });
        };
        if operator == BoolOp::Difference {
            let polygonal = second.ifc_type == IfcType::IfcPolygonalBoundedHalfSpace;
            // Any other IfcHalfSpaceSolid is a plane clip: an IfcBoxedHalfSpace's
            // Enclosure is only a computation hint (#7688 PROC-S19).
            if polygonal || second.ifc_type.is_subtype_of(IfcType::IfcHalfSpaceSolid) {
                let Some(plane) = recorder.half_space_plane_or_record(&second, decoder) else {
                    return self.applied(steps, (host, false));
                };
                let cut = Cut { steps, host };
                self.frames.push(match polygonal {
                    true => Frame::Polygonal { cut, cutter: second, plane },
                    false => Frame::HalfSpace { cut, plan: HalfSpacePlan::new(plane.0, plane.1, plane.2) },
                });
                return Ok(());
            }
            // Solid-solid difference on the exact kernel (no operand-size
            // cap); see `solid_execution.rs` for the admission policy.
        }
        // UNION (a real CSG union, overlap removed) and INTERSECTION (the
        // overlap volume) on the pure-Rust exact kernel: mesh the operand.
        let depth = steps.depth;
        self.frames.push(Frame::AfterStep { steps, operator, host });
        self.frames.push(Frame::Operand { entity: second, operator, depth });
        Ok(())
    }

    /// The plane clip. Reads no source.
    pub(super) fn half_space(&mut self, Cut { steps, host }: Cut, plan: HalfSpacePlan,
        recorder: &BooleanClippingProcessor) -> Result<()> {
        let clipped = plan.clip(&host)?;
        let kept = recorder.guard_against_full_host_removal(host, clipped, plan.point, plan.normal);
        self.applied(steps, (kept, false))
    }

    /// A host that never reaches the removed side loses nothing; otherwise
    /// its cutter's boundary is read next. Reads no source.
    pub(super) fn polygonal(&mut self, cut: Cut, cutter: ifc_lite_core::DecodedEntity, plane: CutPlane)
        -> Result<()> {
        if host_stays_on_kept_side(&cut.host, plane.0, plane.1, plane.2) {
            return self.applied(cut.steps, (cut.host, false));
        }
        self.frames.push(Frame::PolygonalPrism { cut, cutter, plane });
        Ok(())
    }

    /// The bounded prism's boundary and Position, read at source.
    pub(super) fn polygonal_prism(&mut self, cut: Cut, cutter: ifc_lite_core::DecodedEntity, plane: CutPlane,
        recorder: &BooleanClippingProcessor, decoder: &mut EntityDecoder) -> Result<()> {
        let prism = match BoundedPrismPlan::lower(recorder, &cutter, decoder, self.quality) {
            // Boundary over the vertex cap, refused on record (#7786).
            Ok(None) => return self.applied(cut.steps, (cut.host, false)),
            Ok(Some(prism)) => Some(prism),
            Err(_) => None,
        };
        // The gate's unit scale is read with the cutter.
        let length_unit_scale = decoder.length_unit_scale();
        self.frames.push(Frame::PolygonalCut { cut, plane, prism, length_unit_scale });
        Ok(())
    }

    /// Build and subtract the bounded prism, or clip by the unbounded plane
    /// on record. Reads no source.
    pub(super) fn polygonal_cut(&mut self, Cut { steps, host }: Cut, plane: CutPlane,
        prism: Option<BoundedPrismPlan>, length_unit_scale: f64, recorder: &BooleanClippingProcessor)
        -> Result<()> {
        let (point, normal, agreement) = plane;
        if let Some(Ok(bound)) = prism.map(|prism| prism.build_mesh(&host, plane)) {
            // `single_cutter_gate.rs`: the #3919/#3923 gate and `solo_step`.
            match recorder.resolve_single_cutter_subtract(&host, &bound, steps.solo_step, length_unit_scale) {
                SingleCutterSubtract::Clipped(clipped) => {
                    let kept = recorder.guard_against_full_host_removal(host, clipped, point, normal);
                    return self.applied(steps, (kept, false));
                }
                SingleCutterSubtract::KeepUncut => return self.applied(steps, (host, false)),
                SingleCutterSubtract::FallThrough => {}
            }
        }
        // The bounded prism subtract (or its build) failed. The unbounded
        // plane clip IS applied, but it is a strict superset of the bounded
        // cut: the polygonal boundary is silently dropped. Flag the loss.
        recorder.record_failure(BoolOp::Difference, BoolFailureReason::PolygonalBoundedHalfSpaceFallback);
        let clipped = HalfSpacePlan::new(point, normal, agreement).clip(&host)?;
        let kept = recorder.guard_against_full_host_removal(host, clipped, point, normal);
        self.applied(steps, (kept, false))
    }

    /// One step's result: continue with the next node.
    pub(super) fn applied(&mut self, mut steps: Steps, result: (Mesh, bool)) -> Result<()> {
        steps.accept(result);
        self.frames.push(Frame::Steps(steps));
        Ok(())
    }
}
