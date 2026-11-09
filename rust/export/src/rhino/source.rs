// SPDX-License-Identifier: MPL-2.0
//! The IFC facts the scene needs beyond meshes: attribute rows, the spatial
//! tree, type objects and the project, gathered once.
//!
//! Spatial edges come from [`crate::relationships`] and are walked with the
//! export formats' one walk (`spatial_walk::walk`, D48), so the layer tree and
//! USD's prim tree agree on which container owns an element. Rows come from
//! the export data model with type sets inherited when properties are `all`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ifc_lite_core::{slot, EntityDecoder, EntityIndex, SchemaVersion, SiteRefLocation};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::data_model::{extract_elevation_if_storey, spatial_walk};
use ifc_lite_processing::ModelMetadata;

use super::options::RhinoProperties;
use crate::model::{stream_export_model_with_inherited, EntityRow, Inherited, ModelOptions};
use crate::relationships::relationships;
use crate::scene_input::is_space;

/// Name and GlobalId of a non-product root entity (the project, a type).
#[derive(Debug, Clone, Default)]
pub(super) struct RootInfo {
    pub(super) name: Option<String>,
    pub(super) long_name: Option<String>,
    pub(super) global_id: Option<String>,
}

pub(super) struct ModelInfo {
    /// Rows of geometry-bearing elements and of spatial structure, by id.
    /// They carry property and quantity sets only when properties are `all`.
    pub(super) rows: HashMap<u32, EntityRow>,
    pub(super) inherited: HashMap<u32, Inherited>,
    /// Spatial parent of every node the walk from the project reached.
    pub(super) parent: HashMap<u32, u32>,
    pub(super) project: Option<u32>,
    pub(super) project_info: RootInfo,
    pub(super) type_of: HashMap<u32, u32>,
    pub(super) types: HashMap<u32, RootInfo>,
    /// First `IfcSite` (by express id) with a reference latitude and
    /// longitude, and where its placement origin comes from.
    pub(super) anchor_site: Option<AnchorSite>,
    /// The model context's TrueNorth (unit XY, IFC world); `None` means +Y.
    pub(super) true_north: Option<[f64; 2]>,
    /// Storey elevations in metres, for ordering storey layers.
    elevations: HashMap<u32, f64>,
    /// Every spatial row, classified once.
    spatial: HashMap<u32, NodeKind>,
}

/// What a spatial node is to the layer tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeKind {
    /// A spatial structure element other than a space: a layer in the
    /// spatial scheme, and a container.
    Layer,
    /// Any other spatial element (a space, a zone): a container only; its
    /// contents go on the layer of the storey above it.
    Container,
}

/// `class` as a spatial node in `schema`, `None` when it is not spatial.
/// The file's schema decides the class graph, as `plan::attrs::is_spatial`
/// and `in_structure` read it; an unknown schema has no spatial classes.
fn node_kind(schema: Option<SchemaVersion>, class: &str) -> Option<NodeKind> {
    let schema = schema?;
    if schema.is_subtype_of(class, "IFCSPATIALSTRUCTUREELEMENT") {
        Some(if is_space(class) { NodeKind::Container } else { NodeKind::Layer })
    } else {
        schema.is_subtype_of(class, "IFCSPATIALELEMENT").then_some(NodeKind::Container)
    }
}

impl ModelInfo {
    /// `geometry_ids` are the elements that will be written; only their rows
    /// (and the spatial structure's) are kept. `index` is built from `content`;
    /// `site_transform` is the pipeline's (`GeometryResult::site_transform`).
    pub(super) fn gather(
        content: &[u8],
        index: Arc<EntityIndex>,
        metadata: &ModelMetadata,
        site_transform: Option<&[f64]>,
        geometry_ids: &HashSet<u32>,
        properties: RhinoProperties,
    ) -> Self {
        let schema = SchemaVersion::from_file_schema(&metadata.schema_version);
        let rel = relationships(content);
        // Walk ownership: the first parent to reach a node owns it.
        let parent: HashMap<u32, u32> = rel
            .project
            .map(|pid| spatial_walk::walk(&rel.spatial_children, pid))
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.parent.map(|p| (v.id, p)))
            .collect();

        let all = properties == RhinoProperties::All;
        let opts = ModelOptions::default().with_inherit_type_properties(all).with_attributes(true);
        let mut rows = HashMap::new();
        let mut inherited = HashMap::new();
        let mut spatial = HashMap::new();
        stream_export_model_with_inherited(content, &index, &opts, |mut row, inh, _| {
            let kind = node_kind(schema, &row.ifc_type);
            if kind.is_none() && !geometry_ids.contains(&row.express_id) {
                return;
            }
            if let Some(kind) = kind {
                spatial.insert(row.express_id, kind);
            }
            if !all {
                row.property_sets.clear();
                row.quantity_sets.clear();
            }
            inherited.insert(row.express_id, inh);
            rows.insert(row.express_id, row);
        });

        let mut decoder = EntityDecoder::with_arc_index(content, Arc::clone(&index));
        let project_info = rel.project.map(|pid| root_info(&mut decoder, pid, true)).unwrap_or_default();
        let mut types = HashMap::new();
        for id in geometry_ids {
            if let Some(&ty) = rel.type_of.get(id) {
                types.entry(ty).or_insert_with(|| root_info(&mut decoder, ty, false));
            }
        }
        let length_unit_scale = metadata.length_unit_scale.unwrap_or(1.0);
        let elevations = rows
            .values()
            .filter_map(|r| {
                extract_elevation_if_storey(&r.ifc_type, r.express_id, &mut decoder, length_unit_scale)
                    .map(|e| (r.express_id, e))
            })
            .collect();
        let anchor_site = anchor_site(&rows, &index, &mut decoder, metadata.length_unit_scale, site_transform);
        let true_north = ifc_lite_core::model_true_north(content, &mut decoder);

        ModelInfo {
            rows,
            inherited,
            parent,
            project: rel.project,
            project_info,
            type_of: rel.type_of,
            types,
            anchor_site,
            true_north,
            elevations,
            spatial,
        }
    }

    /// A spatial node that is a layer in the spatial scheme: a spatial
    /// structure element other than a space. Spaces and zones are containers,
    /// not layers; their contents go on the layer of the storey above them.
    pub(super) fn is_layer_node(&self, id: u32) -> bool {
        self.spatial.get(&id) == Some(&NodeKind::Layer)
    }

    /// The nearest node at or above `id` that is a layer in the spatial
    /// scheme (a layer class, or the project). `None` outside the tree.
    pub(super) fn layer_node(&self, id: u32) -> Option<u32> {
        self.ancestors(id).find(|&n| Some(n) == self.project || self.is_layer_node(n))
    }

    /// The nearest spatial container strictly above `id`: any spatial element
    /// (spaces and zones included).
    pub(super) fn container(&self, id: u32) -> Option<u32> {
        self.ancestors(id).skip(1).find(|n| self.spatial.contains_key(n))
    }

    /// `id`, then its spatial parents up to the project. Bounded by the
    /// number of reached nodes, since the walk's parent map is a tree.
    fn ancestors(&self, id: u32) -> impl Iterator<Item = u32> + '_ {
        let reached = id == self.project.unwrap_or(u32::MAX) || self.parent.contains_key(&id);
        let mut next = reached.then_some(id);
        let mut budget = self.parent.len() + 1;
        std::iter::from_fn(move || {
            let current = next?;
            budget = budget.checked_sub(1)?;
            next = self.parent.get(&current).copied();
            Some(current)
        })
    }

    /// Display name of a spatial node: Name, then LongName, then
    /// `<IfcType> #<id>`.
    pub(super) fn node_name(&self, id: u32) -> String {
        let (name, long_name, ifc_type) = if Some(id) == self.project {
            (self.project_info.name.clone(), self.project_info.long_name.clone(), "IfcProject")
        } else if let Some(row) = self.rows.get(&id) {
            (row.name.clone(), attribute(row, "LongName").map(str::to_string), row.ifc_type.as_str())
        } else {
            (None, None, "IfcProduct")
        };
        [name, long_name]
            .into_iter()
            .flatten()
            .find_map(|s| super::names::clean_name(&s))
            .unwrap_or_else(|| format!("{ifc_type} #{id}"))
    }

    /// Storey elevation in metres (`Elevation`, else the placement's z, as
    /// the spatial hierarchy reads it). `None` for anything else.
    pub(super) fn elevation(&self, id: u32) -> Option<f64> {
        self.elevations.get(&id).copied()
    }
}

/// The site the earth anchor reads, with its placement origin.
pub(super) struct AnchorSite {
    pub(super) location: SiteRefLocation,
    /// The placement origin, IFC world metres. For the pipeline's site (the
    /// first `IfcSite` in the file, as the pipeline's scan takes it) it is
    /// `site_transform`'s translation; for another site, its placement as the
    /// pipeline's resolver (`GeometryRouter::resolve_scaled_placement`) reads
    /// it. `None` when that placement did not resolve (the pipeline's site
    /// without a `site_transform` included) or the length unit was refused.
    pub(super) origin: Option<[f64; 3]>,
}

/// The first `IfcSite` by express id with RefLatitude / RefLongitude, and
/// its origin. `length_unit_scale` is `None` for a refused unit.
fn anchor_site(
    rows: &HashMap<u32, EntityRow>,
    index: &EntityIndex,
    decoder: &mut EntityDecoder,
    length_unit_scale: Option<f64>,
    site_transform: Option<&[f64]>,
) -> Option<AnchorSite> {
    let mut sites: Vec<u32> = rows.values().filter(|r| r.ifc_type == "IfcSite").map(|r| r.express_id).collect();
    sites.sort_unstable();
    let pipeline_site = sites.iter().copied().min_by_key(|id| index.get(id).map_or(usize::MAX, |&(start, _)| start));
    let (id, location) =
        sites.into_iter().find_map(|id| ifc_lite_core::site_ref_location(decoder, id).ok().flatten().map(|l| (id, l)))?;
    let origin = if Some(id) == pipeline_site {
        site_transform.filter(|m| m.len() >= 16).map(|m| [m[12], m[13], m[14]])
    } else {
        length_unit_scale.and_then(|scale| {
            let site = decoder.decode_by_id(id).ok()?;
            let m = GeometryRouter::with_scale(scale).resolve_scaled_placement(&site, decoder).ok()?;
            Some([m[12], m[13], m[14]])
        })
    };
    Some(AnchorSite { location, origin })
}

/// A schema-declared attribute value from `EntityRow::attributes`.
pub(super) fn attribute<'r>(row: &'r EntityRow, name: &str) -> Option<&'r str> {
    row.attributes.iter().find(|a| a.name == name).map(|a| a.value.as_str()).filter(|v| !v.is_empty())
}

fn root_info(decoder: &mut EntityDecoder, id: u32, project: bool) -> RootInfo {
    let Ok(e) = decoder.decode_by_id(id) else { return RootInfo::default() };
    let text = |s: Option<&str>| s.map(str::to_string).filter(|s| !s.is_empty());
    RootInfo {
        name: text(e.string_at(slot::IfcRoot::NAME)),
        long_name: if project { text(e.string_at(slot::IfcProject::LONG_NAME)) } else { None },
        global_id: text(e.string_at(slot::IfcRoot::GLOBAL_ID)),
    }
}
