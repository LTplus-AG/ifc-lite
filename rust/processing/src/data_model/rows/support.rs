// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pass-1 bookkeeping and schema probing for the row stream.

use ifc_lite_core::IfcType;

/// An `IfcTypeProduct` (e.g. `IfcBoilerType`) that carries its own
/// `RepresentationMaps` — a #957 "Route B" mesh candidate. The geometry pass
/// meshes the ORPHAN ones (no occurrence instantiates them) under the type's own
/// expressId; without a matching [`EntityRow`] those GLB nodes render with no
/// attributes (#1518). Everything needed to emit that row is captured here in the
/// pass-1 scan so the emission phase never re-decodes the type.
pub(super) struct TypeProductCandidate {
    pub(super) express_id: u32,
    pub(super) ifc_type: IfcType,
    /// The raw STEP keyword (e.g. `"IFCDOORSTYLE"`), kept ONLY so a later
    /// `render_attributes` call can look up a legacy entity's own attribute
    /// names (#4203) — `ifc_type` above is already legacy-aware-resolved
    /// (`IfcDoorType`, not `Unknown`) and is what every other consumer of
    /// this candidate wants.
    pub(super) type_name: String,
    pub(super) global_id: Option<String>,
    pub(super) name: Option<String>,
    pub(super) description: Option<String>,
    /// `IfcTypeProduct.RepresentationMaps` (attr 6) — non-empty by construction.
    pub(super) rep_map_ids: Vec<u32>,
    /// `IfcTypeObject.HasPropertySets` (attr 5): the type's directly-attached
    /// property/quantity set definitions (types do NOT use
    /// `IfcRelDefinesByProperties`).
    pub(super) pset_def_ids: Vec<u32>,
}

/// The first declared `FILE_SCHEMA` entry that has a bundled attribute
/// registry, or `None`. Attribute positions are schema-specific, so a reader
/// of attributes by name must fail closed here rather than take the IFC4
/// layout. The attribute export and the rebar schedule both resolve through
/// this, so they agree (#7681).
pub fn attribute_schema(content: &[u8]) -> Option<String> {
    ifc_lite_core::parser::header::declared_schemas(content).into_iter().find(|schema| {
        // IfcProject exists in every bundled registry, so this is a schema
        // recognition probe rather than an entity-specific fallback.
        ifc_lite_core::attribute_names_for_schema(schema, "IFCPROJECT").is_some()
    })
}
