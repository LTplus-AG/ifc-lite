// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One boolean operand -> one mesh.
//!
//! Split out of `boolean/mod.rs` (module-size ratchet) when the unsupported-
//! operand arm gained its diagnostic record (#3821).

use super::{BooleanClippingProcessor, CsgSolidProcessor};
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::router::builtin_processor;
use crate::{Mesh, Result, TessellationQuality};
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
/// it without charging; its tree root re-enters `process_with_depth`, which
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
pub(super) fn boolean_operator(entity: &DecodedEntity) -> std::result::Result<BoolOp, &str> {
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
    /// Process a solid operand, reporting whether its type had NO meshing
    /// branch here.
    ///
    /// The flag exists because one dropped operand must produce ONE record. An
    /// unsupported SECOND operand meshes empty, so the `EmptyOperand` arm at
    /// the caller would fire straight after the `UnsupportedOperand` record
    /// below, counting the same step twice — and since the reason breakdown
    /// breaks ties alphabetically, the viewer's "top failure reason" would name
    /// `EmptyOperand`, the CONSEQUENCE, over `UnsupportedOperand`, the cause.
    /// Callers pass this to [`Self::record_empty_operand`].
    ///
    /// `op` is the operation whose operand this is, and it goes into the
    /// `UnsupportedOperand` record. Since that record is then the ONLY one for
    /// the dropped step, recording `Unknown` for an operand of an authored
    /// `.DIFFERENCE.` would render "UNKNOWN failed" as the whole story a
    /// consumer of `take_csg_failures` ever gets for it.
    ///
    /// The BASE solid at the bottom of a left spine passes [`BoolOp::Unknown`]:
    /// it is read before any node's operator is, so naming one would claim an
    /// attribution that path does not have.
    pub(super) fn process_operand_checked(
        &self,
        op: BoolOp,
        operand: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
        quality: TessellationQuality,
        visited: &mut OperandPath,
    ) -> Result<(Mesh, bool)> {
        let mut unsupported = false;
        // Only the two arms that must NOT run on a fresh processor are spelled
        // out here: both carry `depth` and the cycle guard across the hop.
        // Every other operand type goes to the same built-in table the router
        // dispatches representation items from (#4560), so an operand is
        // supported exactly when the engine can mesh it at all. This path used
        // to keep its own six-arm copy of that table; `IfcPolygonalFaceSet`,
        // the tessellated cutter Bonsai/IfcOpenShell emits for a wall clipped
        // by a roof, was never in it and the wall rendered up to the ridge.
        let mesh = match operand.ifc_type {
            // `CsgSolidProcessor::process` builds a FRESH BooleanClippingProcessor
            // for a boolean TreeRootExpression, so routing through it used to reset
            // both `depth` and the cycle guard. `#10 IfcBooleanResult -> FirstOperand
            // #20 IfcCsgSolid -> TreeRootExpression #10` then recursed forever with
            // depth never passing 1, and a Rust stack overflow ABORTS (#2866).
            // `depth` restarts at 0 here, as it did before this guard existed
            // (the hop built a fresh processor). Carrying it would tighten
            // MAX_BOOLEAN_DEPTH, which #960 calibrated against a per-processor
            // reset: 8 booleans + a CsgSolid + 8 more is valid, resolves on
            // main, and would error as "depth 11 exceeds limit 10", dropping
            // the element. MAX_OPERAND_PATH_NODES bounds the stack across the
            // hop instead, counting frames of both kinds.
            IfcType::IfcCsgSolid => {
                // Transient, like the `ClippingProcessor`s below: it is not on
                // any router, so its log has to come back here or it dies with
                // it. `self` IS router-held, so this is the whole route out
                // (#3821) — no thread-local, no cross-router leak.
                let csg = CsgSolidProcessor::with_skip_small_cuts(self.skip_small_cuts);
                let out = csg.process_with_boolean_cycle_guard(
                    operand,
                    decoder,
                    &self.schema,
                    0,
                    quality,
                    visited,
                );
                self.absorb_failures(csg.take_failures());
                out
            }
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                // Recursive case with depth tracking
                self.process_with_depth(operand, decoder, &self.schema, depth + 1, quality, visited)
            }
            other => match builtin_processor(other, &self.schema) {
                Some(processor) => processor.process(operand, decoder, &self.schema, quality),
                // No built-in meshes this operand type: the operand resolves to
                // an EMPTY mesh. As a FIRST operand that empties the whole
                // boolean result and the element's item renders nothing; as a
                // SECOND operand it means an unsupported cutter and the host
                // renders un-cut. Returning `Err` here would be wrong for the
                // second case — it would delete the host as well — so the arm
                // keeps returning an empty mesh and RECORDS the loss instead
                // (#3821). Before this, the only base-operand drop in the whole
                // boolean path left no trace at all, not even in a debug build.
                None => {
                    self.record_failure(
                        op,
                        BoolFailureReason::UnsupportedOperand(other.to_string()),
                    );
                    unsupported = true;
                    Ok(Mesh::new())
                }
            },
        }?;
        Ok((mesh, unsupported))
    }
}
