// SPDX-License-Identifier: MPL-2.0
//! IFC → Rhino `.3dm` scene: every IFC decision a `.3dm` writer needs, as
//! plain data (`RhinoScene`), with no rhino3dm dependency.
//!
//! The contract is `docs/architecture/rhino-3dm-export.md`. This module runs
//! the shared geometry pass (`crate::scene_input`, as USD does), resolves
//! units, frame, layers, materials, blocks and user text, and returns a scene
//! an adapter (`@ifc-lite/rhino3dm`, the Python writer) translates one to one
//! into rhino3dm calls. An adapter that needs to know IFC is a bug here.

mod document;
mod elements;
mod identity;
mod layers;
mod names;
mod objects;
mod options;
mod source;
mod space;
mod user_text;
mod wire;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

pub use options::{RhinoCoordinates, RhinoLayerScheme, RhinoProperties, RhinoSceneOptions, RhinoUnits};
pub use wire::{
    EarthAnchor, RhinoBlock, RhinoGeometry, RhinoGroup, RhinoLayer, RhinoMaterial, RhinoMesh, RhinoObject, RhinoScene,
    RhinoSettings, RHINO_SCENE_FORMAT, RHINO_SCENE_VERSION,
};

use crate::error::ExportError;
use crate::scene_input::{gather, is_space};
use document::{document_strings, earth_anchor};
use elements::{select, Element, Geometry};
use layers::{build_layers, Anchor, LayerRequest};
use objects::{build_objects, Materials, ObjectContext};
use source::ModelInfo;
use space::{resolve_units, OutputSpace};

/// Build the Rhino scene for the model in `content` (raw IFC/STEP bytes).
///
/// Fail-closed like the other scene exporters: a model with no emittable
/// mesh and no instance left after the filters is
/// [`ExportError::NoRenderGeometry`], never an empty scene.
pub fn build_rhino_scene(content: &[u8], opts: &RhinoSceneOptions) -> Result<RhinoScene, ExportError> {
    // One entity index for the geometry pass and the attribute pass.
    let index = Arc::new(ifc_lite_processing::build_entity_index_parallel(content));
    let input = gather(content, opts.instancing, opts.layer_slicing, Some(&index));
    let sel = select(&input, opts);
    crate::error::require_render_geometry(sel.elements.len())?;

    let result = &input.result;
    let metadata = &result.metadata;
    let geometry_ids: HashSet<u32> = sel.elements.keys().copied().collect();
    let info = ModelInfo::gather(content, index, metadata, result.site_transform.as_deref(), &geometry_ids, opts.properties);

    let mut warnings = Vec::new();
    let (unit_system, metres_per_unit) = resolve_units(opts.units, metadata.length_unit_scale, &mut warnings);
    let space = OutputSpace::new(result.frame, opts.coordinates, metres_per_unit);

    let layer_of: HashMap<u32, LayerRequest<'_>> =
        sel.elements.iter().map(|(&id, element)| (id, layer_request(&info, opts.layer_scheme, id, element))).collect();
    let requests: BTreeSet<LayerRequest<'_>> = layer_of.values().copied().collect();
    let has_blocks = sel.elements.values().any(|e| matches!(e.geometry, Geometry::Instance(_)));
    let spatial = opts.layer_scheme == RhinoLayerScheme::SpatialClass;
    let layers = build_layers(&info, spatial, &requests, has_blocks);

    let materials = Materials::build(&sel);
    let built = build_objects(&sel, &ObjectContext {
        info: &info,
        space: &space,
        materials: &materials,
        layers: &layers,
        layer_of: &layer_of,
        properties: opts.properties,
        normals: opts.normals,
    });
    if let Some((key, id)) = &built.collision {
        warnings.push(format!(
            "user-text keys repeated on an object were kept with \" #2\", \" #3\" suffixes (first: \"{key}\" on #{id})"
        ));
    }
    if let Some(id) = built.repeated_identity {
        warnings.push(format!(
            "elements sharing a GlobalId got group names with \" #<express id>\" and objectIds hashed from the express id (first: #{id})"
        ));
    }

    let settings = RhinoSettings {
        unit_system,
        meters_per_unit: metres_per_unit,
        absolute_tolerance: 0.001 / metres_per_unit,
        angle_tolerance_degrees: 1.0,
        earth_anchor: earth_anchor(info.anchor_site.as_ref(), info.true_north, &space, metadata, &mut warnings),
    };
    let document_strings = document_strings(content, &info, metadata, opts.coordinates, &space);

    Ok(RhinoScene {
        settings,
        warnings,
        document_strings,
        layers: layers.layers,
        materials: materials.table,
        groups: built.groups,
        meshes: built.meshes,
        blocks: built.blocks,
        objects: built.objects,
    })
}

/// The layer an element's objects go on under `scheme`.
fn layer_request<'a>(info: &ModelInfo, scheme: RhinoLayerScheme, id: u32, element: &Element<'a>) -> LayerRequest<'a> {
    let class = element.facts.ifc_type;
    match scheme {
        RhinoLayerScheme::SpatialClass => LayerRequest {
            anchor: info.layer_node(id).map_or(Anchor::Unassigned, Anchor::Spatial),
            class: Some(class),
        },
        RhinoLayerScheme::Class => LayerRequest { anchor: Anchor::Root, class: Some(class) },
        RhinoLayerScheme::Presentation => {
            let name = element.facts.presentation_layer.filter(|n| !n.trim().is_empty());
            // Spaces stay on a hidden sublayer in every scheme.
            LayerRequest { anchor: Anchor::Presentation(name), class: is_space(class).then_some(class) }
        }
    }
}
