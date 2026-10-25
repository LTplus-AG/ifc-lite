// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One boolean operand -> one mesh.
//!
//! Split out of `boolean/mod.rs` (module-size ratchet) when the unsupported-
//! operand arm gained its diagnostic record (#3821).

use super::brep_voids::brep_with_voids_shell_kind;
use super::half_space_plan::HalfSpacePlan;
use super::BooleanClippingProcessor;
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::router::builtin_processor;
use crate::{Error, Mesh, Point3, Result, TessellationQuality, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

/// Boolean/CSG operand nodes one `process` call (one representation item)
/// may ENTER, every path counted.
///
/// The third bound from AGENTS.md "Bounding walks over file-supplied
/// references": `MAX_BOOLEAN_DEPTH` bounds nesting, `MAX_OPERAND_PATH_NODES`
/// bounds one path's length, and the path-scoped set breaks cycles, but none
/// of them sees a DAG that fans out. `m` spine nodes per level whose
/// SecondOperands all point at the same next-level boolean re-mesh that
/// boolean `m` times, `m^levels` in all, from a few dozen STEP entities and
/// with nothing repeating on any path. `kernel::budget` cannot help: it
/// counts exact-tier predicate escalations, and a fan-out of cheap box
/// booleans escalates zero times.
///
/// Why 1024: spine (FirstOperand) nodes are walked iteratively and never
/// charged, so an unshared tree of spine width `w` under
/// `MAX_BOOLEAN_DEPTH` (10) charges about `w^10` SecondOperand entries;
/// 1024 is that bound at width 2, and a wider unshared tree that deep is
/// not a shape files have (real items enter this walk a handful of times;
/// a CSG tree enters each primitive once, so this is roughly a thousand
/// primitives under one item). The adversarial DAG crosses it at fan-out 4
/// by the fifth level.
///
/// Every attempt is charged monotonically, including provisional PBHS batch
/// attempts that later defer. Refunding completed work lets nested deferrals
/// repeat the same subtree exponentially while retaining only linear visits.
/// A future memo may make that work cheap; until then the budget refuses it.
pub(crate) const MAX_OPERAND_VISITS: u32 = 1024;

/// Entity ids on the CURRENT operand path — inserted on the way in, removed on
/// the way out, so `len()` is live recursion depth. The two accumulate-only
/// sets in `boolean/mod.rs` (`collect_polygonal_chain`'s, and the spine
/// walk's `spine_seen`) are NOT frame counts and must not be compared to the
/// bound. Carries the per-item visit budget alongside, because the two
/// travel together through every operand hop (the `IfcCsgSolid` hop threads
/// it without charging; its tree root re-enters the continuation's boolean entry, which
/// does) and a budget on a separate parameter would be one more thing a new
/// hop could forget to thread.
#[derive(Default)]
pub(crate) struct OperandPath {
    path: rustc_hash::FxHashSet<u32>,
    visits: u32,
}

impl OperandPath {
    /// Push `id` onto the current path; `false` if it is already on it.
    pub(crate) fn insert(&mut self, id: u32) -> bool {
        self.path.insert(id)
    }

    /// Pop `id` off the current path on the way out.
    pub(crate) fn remove(&mut self, id: u32) {
        self.path.remove(&id);
    }

    /// Live recursion depth.
    pub(crate) fn len(&self) -> usize {
        self.path.len()
    }

    /// Charge one node visit against [`MAX_OPERAND_VISITS`]; `false` once
    /// the budget is spent.
    pub(crate) fn charge(&mut self) -> bool {
        if self.visits >= MAX_OPERAND_VISITS {
            return false;
        }
        self.visits += 1;
        true
    }
}

/// The node's operator. `Err` carries what the `UnknownBooleanOperator`
/// record names: the keyword as authored when it is none of the three, or
/// `<unreadable>` when the attribute is not an enum (`$`, `*`, a string) on
/// an `IfcBooleanResult`, where UNION and INTERSECTION are as legal as
/// DIFFERENCE and defaulting would execute a subtraction the file never
/// asked for. An `IfcBooleanClippingResult` has DIFFERENCE as its only legal
/// operator, so there the default is what the schema says.
pub(crate) fn boolean_operator(entity: &DecodedEntity) -> std::result::Result<BoolOp, &str> {
    let Some(keyword) = entity.get(0).and_then(|v| v.as_enum()) else {
        return match entity.ifc_type {
            IfcType::IfcBooleanClippingResult => Ok(BoolOp::Difference),
            _ => Err("<unreadable>"),
        };
    };
    match keyword.trim_matches('.') {
        "DIFFERENCE" => Ok(BoolOp::Difference),
        "UNION" => Ok(BoolOp::Union),
        "INTERSECTION" => Ok(BoolOp::Intersection),
        _ => Err(keyword),
    }
}

impl BooleanClippingProcessor {
    /// The DIFFERENCE step's SecondOperand, or `None` with the dropped step on
    /// record when the reference does not resolve. A `?` here returned `Err`
    /// and deleted the HOST with its unreadable cutter (#7688, the PROC-S17
    /// shape): the caller keeps the mesh it has, like any dropped operand.
    pub(crate) fn second_operand_or_record(
        &self,
        op: BoolOp,
        node: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<DecodedEntity> {
        self.second_operand_result_or_record(op, node, decoder).ok().flatten()
    }

    /// Preserve the actual decoder result for retained admission. The exact
    /// wrapper still recovers with None, and both callers record the same loss.
    pub(crate) fn second_operand_result_or_record(
        &self,
        op: BoolOp,
        node: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> ifc_lite_core::Result<Option<DecodedEntity>> {
        let resolved = match node.get(2) {
            Some(attr) => decoder.resolve_ref(attr),
            None => Ok(None),
        };
        if !matches!(resolved, Ok(Some(_))) {
            self.record_failure(op, BoolFailureReason::EmptyOperand);
        }
        resolved
    }

    /// A half-space cutter's plane, or `None` with the dropped cut on record
    /// (#7688 PROC-S17). `HalfSpacePlan::lower` refuses a base surface that
    /// is not an `IfcPlane` or a plane without a usable Position; through `?`
    /// that refusal deleted the host. Now the host stays uncut, exactly as for
    /// every other unreadable cutter (see `leaf_operand`).
    pub(crate) fn half_space_plane_or_record(
        &self,
        half_space: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(Point3<f64>, Vector3<f64>, bool)> {
        let plane = HalfSpacePlan::lower(half_space, decoder)
            .map(HalfSpacePlan::components)
            .ok();
        if plane.is_none() {
            self.record_failure(
                BoolOp::Difference,
                BoolFailureReason::UnsupportedOperand(half_space.ifc_type.to_string()),
            );
        }
        plane
    }

    /// Mesh one non-recursive operand with a FRESH built-in processor, never a
    /// router override, reporting whether it meshed empty with that loss
    /// already on record: its type had NO meshing branch here.
    ///
    /// The flag exists because one dropped operand must produce ONE record. An
    /// unsupported SECOND operand meshes empty, so the `EmptyOperand` arm at
    /// the caller would fire straight after the `UnsupportedOperand` record
    /// below, counting the same step twice -- and since the reason breakdown
    /// breaks ties alphabetically, the viewer's "top failure reason" would name
    /// `EmptyOperand`, the CONSEQUENCE, over `UnsupportedOperand`, the cause.
    /// Callers pass this to [`Self::record_empty_operand`]. The continuation
    /// carries the same flag out of a nested boolean or `IfcCsgSolid` whose own
    /// walk ended empty on a loss it recorded (#4691).
    ///
    /// `op` is the operation whose operand this is, and it goes into the
    /// `UnsupportedOperand` record. Since that record is then the ONLY one for
    /// the dropped step, recording `Unknown` for an operand of an authored
    /// `.DIFFERENCE.` would render "UNKNOWN failed" as the whole story a
    /// consumer of `take_csg_failures` ever gets for it. The BASE solid at the
    /// bottom of a left spine passes [`BoolOp::Unknown`]: it is read before any
    /// node's operator is, so naming one would claim an attribution that path
    /// does not have.
    ///
    /// `IfcCsgSolid` and the boolean types never arrive here: the continuation
    /// dispatches them as frames, carrying `depth` and the cycle guard.
    pub(crate) fn leaf_operand(
        &self,
        op: BoolOp,
        operand: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<(Mesh, bool)> {
        match &operand.ifc_type {
            IfcType::IfcCsgSolid | IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                Err(Error::geometry("Recursive operand requires continuation dispatch"))
            }
            // An open swept surface bounds no volume and is not an
            // `IfcBooleanOperand`. Main refused it here (the type had no
            // built-in); since #7688 registered it, meshing it would cut the
            // host open along the strip. It stays an unsupported operand.
            IfcType::IfcSurfaceOfLinearExtrusion => {
                self.record_failure(
                    op,
                    BoolFailureReason::UnsupportedOperand(operand.ifc_type.to_string()),
                );
                Ok((Mesh::new(), true))
            }
            other => match builtin_processor(other.clone(), &self.schema) {
                Some(processor) => {
                    let outer = processor.process(operand, decoder, &self.schema, quality)?;
                    // A cutter is the solid IFC defines, not its Outer shell
                    // alone (#7786). The BASE operand (`BoolOp::Unknown`) keeps
                    // the shell: the same item meshes that way outside a boolean.
                    if op != BoolOp::Unknown {
                        if let Some(kind) = brep_with_voids_shell_kind(other) {
                            return Ok(self.without_voids(kind, op, operand, outer, decoder, quality));
                        }
                    }
                    Ok((outer, false))
                }
                // No built-in meshes this operand type: the operand resolves to
                // an EMPTY mesh. As a FIRST operand that empties the whole
                // boolean result and the element's item renders nothing; as a
                // SECOND operand it means an unsupported cutter and the host
                // renders un-cut. Returning `Err` here would be wrong for the
                // second case -- it would delete the host as well -- so the arm
                // keeps returning an empty mesh and RECORDS the loss instead
                // (#3821).
                None => {
                    self.record_failure(op, BoolFailureReason::UnsupportedOperand(other.to_string()));
                    Ok((Mesh::new(), true))
                }
            },
        }
    }
}
