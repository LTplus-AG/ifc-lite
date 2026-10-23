// SPDX-License-Identifier: MPL-2.0
//! Constructors for [`super::Disposition::Add`]'s public vocabulary; see
//! `builders.rs` for why the plan's types are built this way.

use super::add_assoc_types::{
    ClassificationLink, ClassificationSystem, LayerMaterial, MaterialLink, NewClassification, NewClassificationReference,
    NewLayerSet, NewMaterial, NewMaterialLayer, ValueUnit,
};
use super::add_types::{
    ClassSpec, Extrusion, GlobalId, IfcClass, NewObject, NewOpening, NewPlacement, NewProperty, NewPropertySet, NewType,
    PropertyValue, Representation, TypeLink,
};
use super::types::{ObjectRef, PsetKind, SurfaceColour};
impl ClassSpec {
    /// `class` with no `PredefinedType`.
    pub fn new(class: IfcClass) -> Self {
        Self { class, predefined_type: None }
    }

    pub fn with_predefined_type(mut self, predefined_type: impl Into<String>) -> Self {
        self.predefined_type = Some(predefined_type.into());
        self
    }
}

impl From<IfcClass> for ClassSpec {
    fn from(class: IfcClass) -> Self {
        Self::new(class)
    }
}

impl NewPlacement {
    /// At `matrix`, relative to the container's placement (or absolute
    /// without one).
    pub fn new(matrix: [[f64; 4]; 4]) -> Self {
        Self { matrix, relative_to: None }
    }

    pub fn with_relative_to(mut self, relative_to: ObjectRef) -> Self {
        self.relative_to = Some(relative_to);
        self
    }
}

impl Extrusion {
    /// `profile` swept along `direction` for `depth`, with no voids.
    pub fn new(profile: Vec<[f64; 2]>, direction: [f64; 3], depth: f64) -> Self {
        Self { profile, voids: Vec::new(), direction, depth }
    }

    pub fn with_voids(mut self, voids: Vec<Vec<[f64; 2]>>) -> Self {
        self.voids = voids;
        self
    }
}

impl NewProperty {
    pub fn new(name: impl Into<String>, value: PropertyValue) -> Self {
        Self { name: name.into(), value, unit: None }
    }

    pub fn with_unit(mut self, unit: ValueUnit) -> Self {
        self.unit = Some(unit);
        self
    }
}

impl NewPropertySet {
    pub fn new(name: impl Into<String>, kind: PsetKind, properties: Vec<NewProperty>) -> Self {
        Self { name: name.into(), kind, properties }
    }
}

impl NewType {
    /// A type of `class`, its GlobalId derived from the occurrence that
    /// creates it.
    pub fn new(class: impl Into<ClassSpec>) -> Self {
        Self { global_id: None, class: class.into(), name: None, psets: Vec::new() }
    }

    pub fn with_global_id(mut self, global_id: GlobalId) -> Self {
        self.global_id = Some(global_id);
        self
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_psets(mut self, psets: Vec<NewPropertySet>) -> Self {
        self.psets = psets;
        self
    }
}

impl NewOpening {
    pub fn new(host: ObjectRef, matrix: [[f64; 4]; 4], shape: Extrusion) -> Self {
        Self { host, matrix, shape }
    }
}

impl NewObject {
    /// An object with nothing but its identity, class and placement: no
    /// name, container, type, geometry, colour, sets, opening or
    /// associations until a setter adds them.
    pub fn new(global_id: GlobalId, class: impl Into<ClassSpec>, placement: NewPlacement) -> Self {
        Self {
            global_id,
            class: class.into(),
            name: None,
            placement,
            container: None,
            type_link: None,
            representation: Representation::None,
            style: None,
            psets: Vec::new(),
            opening: None,
            material: None,
            classifications: Vec::new(),
        }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_container(mut self, container: ObjectRef) -> Self {
        self.container = Some(container);
        self
    }

    pub fn with_type(mut self, type_link: TypeLink) -> Self {
        self.type_link = Some(type_link);
        self
    }

    pub fn with_representation(mut self, representation: Representation) -> Self {
        self.representation = representation;
        self
    }

    pub fn with_style(mut self, style: SurfaceColour) -> Self {
        self.style = Some(style);
        self
    }

    pub fn with_psets(mut self, psets: Vec<NewPropertySet>) -> Self {
        self.psets = psets;
        self
    }

    pub fn with_opening(mut self, opening: NewOpening) -> Self {
        self.opening = Some(opening);
        self
    }

    pub fn with_material(mut self, material: MaterialLink) -> Self {
        self.material = Some(material);
        self
    }

    pub fn with_classifications(mut self, classifications: Vec<ClassificationLink>) -> Self {
        self.classifications = classifications;
        self
    }
}

impl NewMaterial {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into(), category: None }
    }

    pub fn with_category(mut self, category: impl Into<String>) -> Self {
        self.category = Some(category.into());
        self
    }
}

impl NewMaterialLayer {
    /// A layer `thickness` thick with no material.
    pub fn new(thickness: f64) -> Self {
        Self { material: None, thickness }
    }

    pub fn with_material(mut self, material: LayerMaterial) -> Self {
        self.material = Some(material);
        self
    }
}

impl NewLayerSet {
    pub fn new(layers: Vec<NewMaterialLayer>) -> Self {
        Self { name: None, layers }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }
}

impl NewClassification {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into(), source: None, edition: None }
    }

    pub fn with_source(mut self, source: impl Into<String>) -> Self {
        self.source = Some(source.into());
        self
    }

    pub fn with_edition(mut self, edition: impl Into<String>) -> Self {
        self.edition = Some(edition.into());
        self
    }
}

impl NewClassificationReference {
    /// A reference into `system`. IFC requires at least one of an
    /// identification, a name or a location.
    pub fn new(system: ClassificationSystem) -> Self {
        Self { system, identification: None, name: None, location: None }
    }

    pub fn with_identification(mut self, identification: impl Into<String>) -> Self {
        self.identification = Some(identification.into());
        self
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_location(mut self, location: impl Into<String>) -> Self {
        self.location = Some(location.into());
        self
    }
}
