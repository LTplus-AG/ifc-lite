// SPDX-License-Identifier: MPL-2.0
//! Engine-neutral authored-source plans.
//!
//! A source construction is deliberately distinct from an evaluated product.
//! The existing analytic walk covers extrusions and swept disks only; it cannot
//! certify that every item in a product representation has been lowered.

mod inventory;
mod planning;

use std::collections::BTreeMap;
use serde::Serialize;
use crate::{AnalyticSourceKey, ExtrusionDefinition, SweptDiskDefinition, SweptDiskInstance};

pub use planning::plan_authored_geometry;

/// Existing authored definitions, retained verbatim in IFC file length units.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "definition", rename_all = "snake_case")]
pub enum AuthoredDefinition {
    Extrusion(Box<ExtrusionDefinition>),
    SweptDisk(SweptDiskDefinition),
}

impl AuthoredDefinition {
    pub fn key(&self) -> &AnalyticSourceKey {
        match self {
            Self::Extrusion(source) => &source.key,
            Self::SweptDisk(source) => &source.key,
        }
    }
}

/// Construction semantics, independent of numerical engine and tessellation.
/// Exact source descriptions do not imply an exact-arithmetic BRep evaluator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthoredConstruction { Extrusion, SweptDisk }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthoredEvaluationContract {
    /// Evaluate the named raw authored solid only. No enclosing CSG or external
    /// opening is implied. Consumers must not publish this as final net geometry.
    AuthoredSourceOnly,
}

/// A complete source and usable placed occurrence. The matrix is column-major;
/// it maps raw solid-local coordinates into absolute IFC Z-up world metres.
/// Extrusion profile/solid Position matrices remain in the definition and must
/// be applied in authored order before this occurrence matrix.
#[derive(Debug, Clone, Serialize)]
pub struct AuthoredRecipe {
    pub source: AnalyticSourceKey,
    pub product_id: u32,
    pub source_ordinal: usize,
    pub construction: AuthoredConstruction,
    pub contract: AuthoredEvaluationContract,
    pub world_from_source: [f64; 16],
}

/// Work still required before a product can have final evaluated geometry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvaluationRequirement {
    /// The analytic extractor omits other representation families. Even a
    /// product with complete source recipes has not passed complete lowering.
    RepresentationCoverageUnverified,
    EnclosingBoolean { solid_id: u32 },
    ExternalOpening { relationship_id: u32, opening_id: u32 },
    UnsupportedSource { solid_id: u32, reason: String },
    NoSupportedAuthoredSources,
    RequestedProductUnavailable,
    OpeningRelationshipsUnverified,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthoredProductPlan {
    pub product_id: u32,
    /// All discovered occurrences, including unsupported and modified sources.
    /// Family-local ordinals retain the existing analytic API's convention.
    pub occurrences: Vec<SweptDiskInstance>,
    pub requirements: Vec<EvaluationRequirement>,
}

/// A partial source plan, never a declaration of complete IFC coverage.
#[derive(Debug, Clone, Serialize)]
pub struct AuthoredGeometryPlan {
    pub model_sha256: String,
    pub schema: Option<String>,
    pub source_units: &'static str,
    pub world_units: &'static str,
    pub up_axis: &'static str,
    pub length_unit_scale: f64,
    pub definitions: Vec<AuthoredDefinition>,
    pub recipes: Vec<AuthoredRecipe>,
    pub products: BTreeMap<u32, AuthoredProductPlan>,
    pub diagnostics: Vec<String>,
}
