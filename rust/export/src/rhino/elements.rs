// SPDX-License-Identifier: MPL-2.0
//! Which elements reach the file, and as what: mesh parts or one block
//! instance.
//!
//! Exactly once: every geometry-bearing element is either mesh objects or
//! one instance, never both. A template element (the occurrence whose mesh
//! the pipeline kept for its `InstanceRecord`s) is itself written as an
//! instance of its block with an identity placement, so editing the block in
//! Rhino edits every occurrence, the template included. That is safe because
//! `scene_input::gather` only takes the instanced result when the template
//! has exactly one emittable submesh and no occurrence also owns a mesh.

use std::collections::{BTreeMap, HashMap};

use ifc_lite_geometry::math::mat4;
use ifc_lite_processing::{InstanceRecord, MeshData};

use super::options::RhinoSceneOptions;
use crate::model::EntityRow;
use crate::scene_input::{is_space, is_void_volume, SceneInput};
use crate::visibility::ElementFilter;

/// What the pipeline says about an element, from its first submesh or its
/// instance record.
#[derive(Clone, Copy)]
pub(super) struct Facts<'a> {
    pub(super) ifc_type: &'a str,
    pub(super) global_id: Option<&'a str>,
    pub(super) name: Option<&'a str>,
    pub(super) presentation_layer: Option<&'a str>,
}

impl<'a> Facts<'a> {
    fn of_mesh(m: &'a MeshData) -> Self {
        Self {
            ifc_type: &m.ifc_type,
            global_id: m.global_id.as_deref(),
            name: m.name.as_deref(),
            presentation_layer: m.presentation_layer.as_deref(),
        }
    }

    fn of_instance(r: &'a InstanceRecord) -> Self {
        Self {
            ifc_type: &r.ifc_type,
            global_id: r.global_id.as_deref(),
            name: r.name.as_deref(),
            presentation_layer: r.presentation_layer.as_deref(),
        }
    }

    /// GlobalId and Name from the element's attribute row when it has one,
    /// else the pipeline's.
    pub(super) fn with_row(self, row: Option<&'a EntityRow>) -> Self {
        Self {
            global_id: row.and_then(|r| r.global_id.as_deref()).or(self.global_id),
            name: row.and_then(|r| r.name.as_deref()).or(self.name),
            ..self
        }
    }
}

/// One block occurrence.
pub(super) struct Occurrence<'a> {
    pub(super) template: &'a MeshData,
    /// Row-major, template-relative (`InstanceRecord::transform`, widened).
    pub(super) transform: [f64; 16],
    pub(super) color: [f32; 4],
}

pub(super) enum Geometry<'a> {
    /// Emittable submeshes, in pipeline order.
    Meshes(Vec<&'a MeshData>),
    Instance(Occurrence<'a>),
}

pub(super) struct Element<'a> {
    pub(super) facts: Facts<'a>,
    pub(super) geometry: Geometry<'a>,
}

/// The viewer's visibility filters plus the scene's own exclusions: void
/// volumes never, spaces unless asked for.
struct Filter<'a> {
    ids: ElementFilter,
    include_spaces: bool,
    /// The exclusions' verdict per distinct class string.
    by_type: HashMap<&'a str, bool>,
}

impl<'a> Filter<'a> {
    fn keeps(&mut self, id: u32, ifc_type: &'a str) -> bool {
        let include_spaces = self.include_spaces;
        let class_kept =
            *self.by_type.entry(ifc_type).or_insert_with(|| !is_void_volume(ifc_type) && (include_spaces || !is_space(ifc_type)));
        class_kept && self.ids.keeps(id, ifc_type)
    }
}

/// Every written element by express id, plus the block templates by
/// template express id.
pub(super) struct Selection<'a> {
    pub(super) elements: BTreeMap<u32, Element<'a>>,
    pub(super) templates: BTreeMap<u32, &'a MeshData>,
}

pub(super) fn select<'a>(input: &'a SceneInput, opts: &RhinoSceneOptions) -> Selection<'a> {
    let mut filter = Filter {
        ids: ElementFilter::new(&opts.hidden, opts.isolated.as_deref(), &opts.hidden_types),
        include_spaces: opts.include_spaces,
        by_type: HashMap::new(),
    };
    let instances = input.instances();

    // The gather gate guarantees exactly one emittable submesh per template.
    let mut templates = BTreeMap::new();
    if !instances.is_empty() {
        let mut first_mesh: HashMap<u32, &MeshData> = HashMap::new();
        for m in input.emittable() {
            first_mesh.entry(m.express_id).or_insert(m);
        }
        for r in instances {
            if let Some(m) = first_mesh.get(&r.template_express_id) {
                templates.insert(r.template_express_id, *m);
            }
        }
    }

    let mut elements: BTreeMap<u32, Element<'a>> = BTreeMap::new();
    for m in input.emittable() {
        if !filter.keeps(m.express_id, &m.ifc_type) {
            continue;
        }
        if let Some(&template) = templates.get(&m.express_id) {
            let occurrence = Occurrence { template, transform: mat4::IDENTITY, color: m.color };
            elements.insert(m.express_id, Element { facts: Facts::of_mesh(m), geometry: Geometry::Instance(occurrence) });
            continue;
        }
        let element = elements
            .entry(m.express_id)
            .or_insert_with(|| Element { facts: Facts::of_mesh(m), geometry: Geometry::Meshes(Vec::new()) });
        if let Geometry::Meshes(parts) = &mut element.geometry {
            parts.push(m);
        }
    }
    for r in instances {
        let Some(&template) = templates.get(&r.template_express_id) else { continue };
        if !filter.keeps(r.express_id, &r.ifc_type) {
            continue;
        }
        let occurrence = Occurrence { template, transform: r.transform.map(f64::from), color: r.color };
        elements.insert(r.express_id, Element { facts: Facts::of_instance(r), geometry: Geometry::Instance(occurrence) });
    }
    Selection { elements, templates }
}
