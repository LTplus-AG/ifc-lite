// SPDX-License-Identifier: MPL-2.0
//! Constructors for [`super::Disposition::Add`]'s public vocabulary; see
//! `builders.rs` for why the plan's types are built this way.

use super::add_assoc_types::{
    ClassificationLink, ClassificationSystem, LayerMaterial, MaterialLink, NewClassification, NewClassificationReference,
    NewLayerSet, NewMaterial, NewMaterialLayer, NewProperty, NewPropertySet, PropertyValue, ValueUnit,
};
use super::add_types::{
    ClassSpec, Extrusion, GlobalId, IfcClass, MappedBody, NewObject, NewOpening, NewPlacement, NewType, Representation, TypeLink,
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

impl PropertyValue {
    /// A numeric measure by its IFC defined-type name, e.g.
    /// `PropertyValue::measure("IfcLengthMeasure", 3.0)`.
    pub fn measure(measure_type: impl Into<String>, value: f64) -> Self {
        PropertyValue::Measure { measure_type: measure_type.into(), value }
    }
}

impl ValueUnit {
    /// A new `IfcSIUnit` by name (`"PASCAL"`), with no prefix.
    pub fn si(name: impl Into<String>) -> Self {
        ValueUnit::Si { prefix: None, name: name.into() }
    }

    /// A new prefixed `IfcSIUnit`, e.g. `ValueUnit::si_prefixed("KILO", "PASCAL")`.
    pub fn si_prefixed(prefix: impl Into<String>, name: impl Into<String>) -> Self {
        ValueUnit::Si { prefix: Some(prefix.into()), name: name.into() }
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
        Self { global_id: None, class: class.into(), name: None, tag: None, element_type: None, psets: Vec::new(), representation: Representation::None, style: None }
    }

    pub fn with_global_id(mut self, global_id: GlobalId) -> Self {
        self.global_id = Some(global_id);
        self
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tag = Some(tag.into());
        self
    }

    pub fn with_element_type(mut self, element_type: impl Into<String>) -> Self {
        self.element_type = Some(element_type.into());
        self
    }

    pub fn with_psets(mut self, psets: Vec<NewPropertySet>) -> Self {
        self.psets = psets;
        self
    }

    /// The geometry every occurrence with a mapped body shares.
    pub fn with_representation(mut self, representation: Representation) -> Self {
        self.representation = representation;
        self
    }

    pub fn with_style(mut self, style: SurfaceColour) -> Self {
        self.style = Some(style);
        self
    }
}

impl MappedBody {
    pub fn new(transform: [[f64; 4]; 4]) -> Self {
        Self { transform }
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
            long_name: None,
            tag: None,
            object_type: None,
            placement,
            container: None,
            type_link: None,
            representation: Representation::None,
            style: None,
            psets: Vec::new(),
            opening: None,
            material: None,
            classifications: Vec::new(),
            elevation: None,
        }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_long_name(mut self, long_name: impl Into<String>) -> Self {
        self.long_name = Some(long_name.into());
        self
    }

    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tag = Some(tag.into());
        self
    }

    pub fn with_object_type(mut self, object_type: impl Into<String>) -> Self {
        self.object_type = Some(object_type.into());
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

    /// A storey's `Elevation`, in the project's length unit.
    pub fn with_elevation(mut self, elevation: f64) -> Self {
        self.elevation = Some(elevation);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::IDENTITY;

    /// Every setter lands in its own field; the constructors' defaults are
    /// the empty description.
    #[test]
    fn each_setter_sets_its_field() {
        let colour = SurfaceColour { rgb: [0.1, 0.2, 0.3], transparency: 0.5 };
        let opening = NewOpening::new(ObjectRef::Id(10), IDENTITY, Extrusion::new(vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]], [0.0, 0.0, 1.0], 1.0));
        let set = NewPropertySet::new("P", PsetKind::Property, vec![NewProperty::new("L", PropertyValue::measure("IfcLengthMeasure", 2.0))]);
        let o = NewObject::new(GlobalId(7), IfcClass::Wall, NewPlacement::new(IDENTITY).with_relative_to(ObjectRef::Id(3)))
            .with_name("W")
            .with_container(ObjectRef::Id(70))
            .with_type(TypeLink::Existing(ObjectRef::Id(40)))
            .with_representation(Representation::Extrusion(Extrusion::new(vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]], [0.0, 0.0, 1.0], 1.0)))
            .with_style(colour)
            .with_psets(vec![set])
            .with_opening(opening)
            .with_material(MaterialLink::New(NewMaterial::new("C").with_category("concrete")))
            .with_classifications(vec![ClassificationLink::Existing(ObjectRef::Id(9))])
            .with_elevation(2.5);
        assert_eq!(o.elevation, Some(2.5));
        assert_eq!((o.global_id, o.class.class.keyword(), o.name.as_deref()), (GlobalId(7), "IFCWALL".to_string(), Some("W")));
        assert_eq!(o.container, Some(ObjectRef::Id(70)));
        assert_eq!(o.placement.relative_to, Some(ObjectRef::Id(3)));
        assert!(matches!(o.type_link, Some(TypeLink::Existing(ObjectRef::Id(40)))));
        let Representation::Extrusion(body) = &o.representation else { panic!("extrusion body") };
        assert_eq!((body.profile.len(), body.direction, body.depth), (3, [0.0, 0.0, 1.0], 1.0));
        assert_eq!(o.class.predefined_type, None);
        assert_eq!(o.style.map(|c| (c.rgb, c.transparency)), Some(([0.1, 0.2, 0.3], 0.5)));
        let op = o.opening.as_ref().unwrap();
        assert_eq!((&op.host, op.matrix, op.shape.direction, op.shape.depth), (&ObjectRef::Id(10), IDENTITY, [0.0, 0.0, 1.0], 1.0));
        assert_eq!(op.shape.profile, vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]);
        let (set, prop) = (&o.psets[0], &o.psets[0].properties[0]);
        assert_eq!((o.psets.len(), set.name.as_str(), set.kind, prop.name.as_str()), (1, "P", PsetKind::Property, "L"));
        assert_eq!(prop.unit, None);
        assert!(matches!(&prop.value, PropertyValue::Measure { measure_type, value, .. } if measure_type == "IfcLengthMeasure" && *value == 2.0));
        assert!(matches!(&o.material, Some(MaterialLink::New(m)) if m.name == "C" && m.category.as_deref() == Some("concrete")));
        assert!(matches!(o.classifications.as_slice(), [ClassificationLink::Existing(ObjectRef::Id(9))]));

        let bare = NewObject::new(GlobalId(8), IfcClass::Wall, NewPlacement::new(IDENTITY));
        assert_eq!((bare.global_id, bare.class.class.keyword()), (GlobalId(8), "IFCWALL".to_string()));
        assert!(bare.name.is_none() && bare.container.is_none() && bare.type_link.is_none() && bare.style.is_none());
        assert!(matches!(bare.representation, Representation::None) && bare.psets.is_empty() && bare.classifications.is_empty());
        assert!(bare.elevation.is_none() && bare.opening.is_none() && bare.material.is_none() && bare.placement.relative_to.is_none() && bare.class.predefined_type.is_none());

        let type_set = NewPropertySet::new("TS", PsetKind::Quantity, Vec::new());
        let t = NewType::new(IfcClass::Named("IfcWallType".into())).with_global_id(GlobalId(5)).with_name("T").with_psets(vec![type_set]);
        assert_eq!((t.global_id, t.name.as_deref()), (Some(GlobalId(5)), Some("T")));
        assert_eq!((t.psets[0].name.as_str(), t.psets[0].kind, t.psets[0].properties.len()), ("TS", PsetKind::Quantity, 0));
        assert_eq!((t.class.class.keyword(), t.class.predefined_type.clone()), ("IFCWALLTYPE".to_string(), None));
        let r = NewClassificationReference::new(ClassificationSystem::New(NewClassification::new("U").with_source("s").with_edition("1")))
            .with_identification("A")
            .with_name("N")
            .with_location("L");
        assert_eq!((r.identification.as_deref(), r.name.as_deref(), r.location.as_deref()), (Some("A"), Some("N"), Some("L")));
        let ClassificationSystem::New(system) = &r.system else { panic!("new system") };
        assert_eq!((system.name.as_str(), system.source.as_deref(), system.edition.as_deref()), ("U", Some("s"), Some("1")));
        let layers = NewLayerSet::new(vec![NewMaterialLayer::new(0.2).with_material(LayerMaterial::Existing(ObjectRef::Id(1)))]).with_name("S");
        assert_eq!(layers.name.as_deref(), Some("S"));
        assert_eq!(layers.layers[0].thickness, 0.2);
        assert!(matches!(layers.layers[0].material, Some(LayerMaterial::Existing(ObjectRef::Id(1)))));
        assert_eq!(ValueUnit::si_prefixed("KILO", "PASCAL"), ValueUnit::Si { prefix: Some("KILO".into()), name: "PASCAL".into() });
        assert_eq!(ClassSpec::new(IfcClass::Wall).with_predefined_type("STANDARD").predefined_type.as_deref(), Some("STANDARD"));
        assert_eq!(Extrusion::new(Vec::new(), [0.0, 0.0, 1.0], 1.0).with_voids(vec![vec![[1.0, 2.0]]]).voids, vec![vec![[1.0, 2.0]]]);
        let unit = NewProperty::new("P", PropertyValue::Integer(1)).with_unit(ValueUnit::si("METRE")).unit;
        assert_eq!(unit, Some(ValueUnit::Si { prefix: None, name: "METRE".into() }));
    }
}
