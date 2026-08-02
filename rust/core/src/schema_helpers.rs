// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Hand-maintained schema helpers built on top of the auto-generated
//! `IfcType` enum.
//!
//! These helpers used to live appended to `generated/schema.rs` despite that
//! file's "DO NOT EDIT" header. Moving them here keeps them safe from a
//! re-run of `@ifc-lite/codegen` and lets us derive answers from the EXPRESS
//! inheritance graph instead of maintaining a leaf-level allow-list that has
//! to be amended every time a new IFC4X3 subtype shows up (see PR #585 for
//! `IfcSolarDevice`, which inherits from `IfcEnergyConversionDevice` and was
//! therefore already covered conceptually by the old whitelist's parent
//! entry, but missed in practice because the whitelist was only checked by
//! string match).
//!
//! Co-authored with Geronimo <gerald.stampfel+geronimo@gmail.com> (PR #585).
//!
//! `has_geometry_by_name`, `is_representationless_spatial_container_by_name`
//! and `is_simple_geometry_type` are all on the hot path during scene
//! construction, where the same ~50–100 distinct type names are queried
//! thousands of times per file. We memoise per-name behind a
//! `RwLock<FxHashMap<String, bool>>`: the first call for a name pays the
//! full `IfcType::from_str` (a ~1300-arm match) + `is_subtype_of` traversal
//! cost; subsequent calls take a read-lock and a single hash lookup.

use std::sync::{OnceLock, RwLock};

use rustc_hash::FxHashMap;

use crate::generated::IfcType;
use crate::legacy_entities::get_legacy_entity_info;

/// Normalise to uppercase ASCII without allocating when the input is already
/// uppercase (the common case — STEP type tokens are emitted uppercase).
fn normalise_uppercase(type_name: &str) -> std::borrow::Cow<'_, str> {
    if type_name.bytes().any(|b| b.is_ascii_lowercase()) {
        std::borrow::Cow::Owned(type_name.to_ascii_uppercase())
    } else {
        std::borrow::Cow::Borrowed(type_name)
    }
}

/// Look up a cached bool, or compute via `f` and insert.
fn cached<F>(cache: &RwLock<FxHashMap<String, bool>>, key: &str, f: F) -> bool
where
    F: FnOnce() -> bool,
{
    if let Ok(read) = cache.read() {
        if let Some(&v) = read.get(key) {
            return v;
        }
    }
    let value = f();
    if let Ok(mut write) = cache.write() {
        write.insert(key.to_owned(), value);
    }
    value
}

/// Check if a type name (UPPERCASE STEP string) represents an `IfcProduct`
/// subtype that can bear geometry (has `ObjectPlacement` + `Representation`).
///
/// Implementation:
/// 1. Modern names go through `IfcType::from_str` and are accepted iff they
///    inherit from `IfcProduct`, with a small block-list for abstract spatial
///    containers (`IfcBuildingStorey`, `IfcFacility`, `IfcFacilityPart`,
///    `IfcSpatialElement`, `IfcSpatialStructureElement`) that don't carry
///    geometry directly. `IfcSpace`, `IfcSite`, `IfcSpatialZone` and
///    `IfcBuilding` (and any concrete subtype of those) are intentionally
///    kept — they have boundary representations the renderer consumes. See
///    [`is_non_geometric_spatial`] for how that exempt set is maintained.
/// 2. Legacy IFC2x3 / removed-in-IFC4x3 names that aren't in the generated
///    enum (e.g. `IFCSLABELEMENTEDCASE`, `IFCBUILDINGELEMENT`, `IFCPROXY`,
///    `IFCEQUIPMENTELEMENT`, `IFCELECTRICALDISTRIBUTIONPOINT`) resolve through
///    `legacy_entities::get_legacy_entity_info`, which carries a
///    `has_geometry` flag.
/// 3. Reinforcement variants not covered above fall back to a substring
///    match (`REINFORCING…` / `REINFORCED…`).
pub fn has_geometry_by_name(type_name: &str) -> bool {
    static CACHE: OnceLock<RwLock<FxHashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(FxHashMap::default()));

    let upper = normalise_uppercase(type_name);
    cached(cache, upper.as_ref(), || compute_has_geometry(upper.as_ref()))
}

fn compute_has_geometry(upper: &str) -> bool {
    if let Some(info) = get_legacy_entity_info(upper) {
        return info.has_geometry;
    }

    let t = IfcType::from_str(upper);
    if matches!(t, IfcType::Unknown(_)) {
        // Reinforcement bars/meshes/elements are common in IFC2x3 files. Match
        // a tighter prefix than `contains("REINFORC")` to avoid catching
        // unrelated tokens with the substring.
        return upper.starts_with("IFCREINFORCING") || upper.starts_with("IFCREINFORCED");
    }

    if !t.is_subtype_of(IfcType::IfcProduct) {
        return false;
    }

    !is_non_geometric_spatial(t)
}

/// Subtypes of `IfcProduct` that exist solely as spatial containers and
/// aren't rendered directly. `IfcSpace`/`IfcSite`/`IfcSpatialZone`/`IfcBuilding`
/// and their concrete subtypes are deliberately exempt — their boundary
/// representations are consumed by the renderer when present.
///
/// The exempt set grows as exporters are found that attach a body to a
/// container. `IfcSpatialZone` was unblocked for Revit Family geometry authored
/// via Dynamo (issue #1075); `IfcBuilding` for terrain/DGM exports that hang an
/// `IfcShellBasedSurfaceModel` straight off the building (issue #1910). In both
/// cases the class was blocked, so the entity never became a geometry job and
/// the model rendered nothing at all. **The gate only *permits* meshing; a
/// container with no representation still produces nothing**, so exempting a
/// class costs one abandoned job per instance and is the safe direction.
/// `IfcBuildingStorey` and the `IfcFacility`/`IfcFacilityPart` families stay
/// blocked only because no exporter has been observed giving them a body; the
/// same one-line exemption applies if one is.
///
/// We block by inheritance, not by exact match, so IFC4X3 facility
/// subclasses like `IfcBridge`/`IfcRoad`/`IfcRailway`/`IfcMarineFacility`
/// (under `IfcFacility`), their `*Part` variants (under `IfcFacilityPart`),
/// and any future concrete spatial container all collapse to the same answer
/// without the whitelist needing to enumerate them.
fn is_non_geometric_spatial(t: IfcType) -> bool {
    if t.is_subtype_of(IfcType::IfcSpace)
        || t.is_subtype_of(IfcType::IfcSite)
        || t.is_subtype_of(IfcType::IfcSpatialZone)
        || t.is_subtype_of(IfcType::IfcBuilding)
    {
        return false;
    }
    t.is_subtype_of(IfcType::IfcSpatialElement)
}

/// Whether `type_name` is one of the spatial-container types that
/// [`has_geometry_by_name`] blocks by name (`IfcBuilding`, `IfcBuildingStorey`,
/// `IfcFacility`, `IfcFacilityPart`, `IfcSpatialElement`,
/// `IfcSpatialStructureElement`, and their subtypes) — i.e. `IfcProduct`
/// subtypes that `is_non_geometric_spatial` treats as never carrying
/// geometry directly.
///
/// In the overwhelming majority of real files that assumption holds: these
/// entities are pure hierarchy nodes with a null `Representation`. Issue
/// #1910 is the counter-example — a DGM/terrain export that attaches an
/// `IfcShellBasedSurfaceModel` directly to `IfcBuilding` with no
/// `IfcBuildingElement` children at all. `has_geometry_by_name` alone can't
/// distinguish "this type never has a body" from "this specific instance
/// happens not to", so callers that need to catch the exceptional case
/// combine this predicate with an instance-level check of whether the
/// entity's `Representation` attribute (index 6 on any `IfcProduct`) is
/// actually non-null before scheduling it for meshing. See
/// `rust/processing/src/processor/mod.rs` and
/// `rust/wasm-bindings/src/api/gpu_meshes/prepass.rs`.
pub fn is_representationless_spatial_container_by_name(type_name: &str) -> bool {
    static CACHE: OnceLock<RwLock<FxHashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(FxHashMap::default()));

    let upper = normalise_uppercase(type_name);
    cached(cache, upper.as_ref(), || {
        compute_is_representationless_spatial_container(upper.as_ref())
    })
}

fn compute_is_representationless_spatial_container(upper: &str) -> bool {
    if get_legacy_entity_info(upper).is_some() {
        // Legacy/removed entities resolve their own `has_geometry` flag and
        // are never part of this modern-schema-only exception path.
        return false;
    }
    let t = IfcType::from_str(upper);
    if matches!(t, IfcType::Unknown(_)) || !t.is_subtype_of(IfcType::IfcProduct) {
        return false;
    }
    is_non_geometric_spatial(t)
}

/// Cheap textual check for whether a STEP entity's attribute at `index`
/// (0-based, top-level — respects nested parens and quoted strings) is
/// present and non-null (`$`), without fully decoding the entity via
/// `EntityDecoder`. Companion to
/// [`is_representationless_spatial_container_by_name`]: callers use it to
/// check attribute 6 (`Representation`, stable across every `IfcProduct`
/// subtype) before deciding an otherwise-excluded spatial container
/// exceptionally carries geometry (#1910).
pub fn nth_attribute_is_present(entity_bytes: &[u8], index: usize) -> bool {
    let Some(open_idx) = entity_bytes.iter().position(|byte| *byte == b'(') else {
        return false;
    };
    let Some(close_idx) = entity_bytes.iter().rposition(|byte| *byte == b')') else {
        return false;
    };
    if close_idx <= open_idx {
        return false;
    }
    let args = &entity_bytes[open_idx + 1..close_idx];

    let mut in_string = false;
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut attr_idx = 0usize;
    let mut i = 0usize;
    while i < args.len() {
        match args[i] {
            b'\'' => {
                if in_string && i + 1 < args.len() && args[i + 1] == b'\'' {
                    i += 1;
                } else {
                    in_string = !in_string;
                }
            }
            b'(' if !in_string => depth += 1,
            b')' if !in_string => depth -= 1,
            b',' if !in_string && depth == 0 => {
                if attr_idx == index {
                    let token = trim_ascii(&args[start..i]);
                    return !token.is_empty() && token != b"$";
                }
                attr_idx += 1;
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if attr_idx == index {
        let token = trim_ascii(&args[start..]);
        return !token.is_empty() && token != b"$";
    }
    false
}

fn trim_ascii(bytes: &[u8]) -> &[u8] {
    let mut s = 0usize;
    let mut e = bytes.len();
    while s < e && bytes[s].is_ascii_whitespace() {
        s += 1;
    }
    while e > s && bytes[e - 1].is_ascii_whitespace() {
        e -= 1;
    }
    &bytes[s..e]
}

/// Check if an IFC entity class is "simple" geometry (processed first for
/// fast first frame). Driven off the EXPRESS inheritance graph rather than
/// a leaf-level blacklist, so new IFC4X3 subtypes (e.g. `IfcSolarDevice`
/// under `IfcEnergyConversionDevice`) are categorised correctly without
/// code changes — see PR #585.
///
/// Returns `true` for "simple" elements (load first), `false` for
/// "secondary/complex" (openings, doors, windows, furniture, MEP/distribution
/// elements, spaces, sites, annotations, virtual/proxy entities).
pub fn is_simple_geometry_type(type_name: &str) -> bool {
    static CACHE: OnceLock<RwLock<FxHashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(FxHashMap::default()));

    let upper = normalise_uppercase(type_name);
    cached(cache, upper.as_ref(), || compute_is_simple(upper.as_ref()))
}

/// Resolve a STEP keyword to its `IfcType`, **legacy-aware**: a removed/renamed
/// entity (`IFCPROXY`, `IFCSOLIDSTRATUM`, …) maps to its modern base type via the
/// hand-maintained legacy table, exactly as `has_geometry_by_name` does. Any pass
/// that *classifies* or *labels* an entity must use this rather than a bare
/// `IfcType::from_str`; otherwise it disagrees with the geometry pass (which meshes
/// legacy entities), leaving a rendered node with no attribute row — the
/// geometry/attribute product-set divergence (#1496).
pub fn legacy_aware_ifc_type(type_name: &str) -> IfcType {
    let upper = normalise_uppercase(type_name);
    match get_legacy_entity_info(upper.as_ref()) {
        Some(info) => info.base_type,
        None => IfcType::from_str(upper.as_ref()),
    }
}

fn compute_is_simple(upper: &str) -> bool {
    let t = legacy_aware_ifc_type(upper);

    // Anything not in the modern schema defaults to "simple" priority,
    // matching the original blacklist's "anything else is simple" behaviour.
    if matches!(t, IfcType::Unknown(_)) {
        return true;
    }

    let is_secondary = t.is_subtype_of(IfcType::IfcOpeningElement)
        || t.is_subtype_of(IfcType::IfcWindow)
        || t.is_subtype_of(IfcType::IfcDoor)
        || t.is_subtype_of(IfcType::IfcFurnishingElement)
        // Covers IfcEnergyConversionDevice + IfcSolarDevice + every Flow*
        // and every MEP terminal — all inherit from IfcDistributionElement.
        || t.is_subtype_of(IfcType::IfcDistributionElement)
        || matches!(
            t,
            // Spatial elements that have geometry but aren't structural.
            IfcType::IfcSpace
                | IfcType::IfcSpatialZone
                | IfcType::IfcSite
                // Annotations / virtual / proxy.
                | IfcType::IfcAnnotation
                | IfcType::IfcVirtualElement
                | IfcType::IfcBuildingElementProxy
        );

    !is_secondary
}

#[cfg(test)]
#[path = "schema_helpers_tests.rs"]
mod tests;
