// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{
    annotation_types::AnnotationPlaneFrame, mapping, reference, source::Source, AppearancePlan,
    Mapping, MappingFrame,
};
use ifc_lite_core::{AttributeValue as A, DecodedEntity, IfcType};
use rustc_hash::FxHashMap;
use serde_json::{json, Value};
use std::sync::Arc;
pub(super) fn vector(v: [f64; 3]) -> A {
    A::List(v.into_iter().map(A::Float).collect())
}
pub(super) fn refs(ids: &[u32]) -> A {
    A::List(ids.iter().copied().map(A::EntityRef).collect())
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
pub(super) struct Metadata<'a> {
    pub schema: &'a str,
    pub source_revision: &'a str,
    pub next_express_id: u32,
    pub container_id: u32,
    pub global_id: &'a str,
    pub containment_global_id: &'a str,
    /// Further host-owned IfcRoot GlobalIds this plan authors (property sets,
    /// relationships). Validated and collision-checked like the two above.
    pub extra_global_ids: &'a [&'a str],
    pub name: &'a str,
}
pub(super) struct Authoring<'a> {
    pub author: Author,
    pub source: Source<'a>,
    pub placement: u32,
    pub context_id: u32,
    pub owner: A,
    pub scale: f64,
    pub rtc_offset: [f64; 3],
}
fn valid_guid(value: &str) -> bool {
    value.len() == 22
        && value.as_bytes()[0] <= b'3'
        && value.as_bytes()[0] >= b'0'
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'$')
}
// Only our fixed authored schema rows reach this conversion: file-supplied
// aggregate values are never recursively cloned or reinterpreted here.
// Core spells a type-qualified value `IFCTEXT('x')` as the two-element list
// [type-name, value]; the host writer takes the explicit `typed` marker and
// resolves the type's EXPRESS base from its registry spelling (`IfcText`).
fn wire(value: &A) -> Value {
    match value {
        A::EntityRef(id) => reference(*id),
        A::Null => Value::Null,
        A::Derived => json!("*"),
        A::Enum(s) => json!(format!(".{s}.")),
        A::String(s) => json!(s),
        A::Integer(n) => json!(n),
        A::Float(n) => json!(n),
        A::List(v) => match v.as_slice() {
            [A::String(name), inner]
                if name.get(..3).is_some_and(|prefix| prefix.eq_ignore_ascii_case("IFC"))
                    && !matches!(inner, A::List(_)) =>
            {
                json!({"typed": {"type": name, "value": wire(inner)}})
            }
            _ => json!(v.iter().map(wire).collect::<Vec<_>>()),
        },
    }
}
/// Build a type-qualified attribute value in core's representation.
pub(super) fn typed(name: &str, value: A) -> A {
    A::List(vec![A::String(name.into()), value])
}
pub(super) struct Author {
    pub plan: AppearancePlan,
    pub entities: FxHashMap<u32, Arc<DecodedEntity>>,
}
impl Author {
    pub fn add(&mut self, ty: IfcType, attributes: Vec<A>) -> u32 {
        let id = super::add(
            &mut self.plan,
            ty.name(),
            attributes.iter().map(wire).collect(),
        );
        self.entities
            .insert(id, Arc::new(DecodedEntity::new(id, ty, attributes)));
        id
    }
}

fn all_global_ids<'a>(r: &'a Metadata<'a>) -> impl Iterator<Item = &'a str> + 'a {
    [r.global_id, r.containment_global_id]
        .into_iter()
        .chain(r.extra_global_ids.iter().copied())
}
pub(super) fn validate_metadata(r: &Metadata<'_>) -> Result<(),String> {
    let ids: Vec<&str> = all_global_ids(r).collect();
    let distinct = ids.iter().all(|a| ids.iter().filter(|b| *b == a).count() == 1);
    if !matches!(r.schema, "IFC4" | "IFC4X3")
        || r.source_revision.len() > 4096
        || r.name.len() > 1024
        || !ids.iter().all(|id| valid_guid(id))
        || !distinct
    {
        return Err(
            "Annotation needs IFC4/IFC4X3, bounded metadata and distinct valid IFC GlobalIds"
                .into(),
        );
    }
    super::wire_text::validate(r.name, "Authored product Name")?;
    Ok(())
}

pub(super) fn prepare<'a>(
    bytes: &'a [u8],
    request: &Metadata<'_>,
    frame: &AnnotationPlaneFrame,
    reserve: usize,
) -> Result<Authoring<'a>, String> {
    let r = request;
    validate_metadata(r)?;
    let f = frame;
    mapping::validate(&Mapping::Planar {
        frame: MappingFrame::World,
        origin: f.origin,
        axis_u: f.axis_u,
        axis_v: f.axis_v,
        metres_per_tile: f.size_metres,
    })?;
    if (dot(f.axis_u, f.axis_u) - 1.).abs() > 1e-10
        || (dot(f.axis_v, f.axis_v) - 1.).abs() > 1e-10
        || dot(f.axis_u, f.axis_v).abs() > 1e-10
    {
        return Err("Annotation image frame must have orthonormal axes".into());
    }
    let mut source = Source::new(bytes)?;
    if source
        .types
        .len()
        .checked_add(reserve)
        .is_none_or(|n| n > 200_000)
        || r.next_express_id <= source.types.last_key_value().map_or(0, |(id, _)| *id)
        || u32::try_from(reserve)
            .ok()
            .and_then(|n| r.next_express_id.checked_add(n))
            .is_none()
    {
        return Err("Annotation allocator or entity budget is exhausted/stale".into());
    }
    let ids: Vec<_> = source
        .types
        .iter()
        .filter(|(_, t)| t.is_subtype_of(IfcType::IfcRoot))
        .map(|(id, _)| *id)
        .collect();
    for id in ids {
        let entity = source.entity(id)?;
        if entity
            .get_string(0)
            .is_some_and(|guid| all_global_ids(r).any(|ours| ours == guid))
        {
            return Err("Annotation GlobalId already exists in the effective model".into());
        }
    }
    let container = source.entity(r.container_id)?;
    if !container.ifc_type.is_subtype_of(IfcType::IfcSpatialElement) {
        return Err("Choose an effective IfcSpatialElement as annotation container".into());
    }
    source.validate_world_placement(&container)?;
    let projects: Vec<_> = source
        .types
        .iter()
        .filter(|(_, t)| **t == IfcType::IfcProject)
        .map(|(id, _)| *id)
        .collect();
    if projects.len() != 1 {
        return Err("Annotation creation needs one unambiguous IfcProject".into());
    }
    let project = source.entity(projects[0])?;
    let mut contexts = Vec::new();
    for id in super::source::refs(project.get(7))? {
        let context = source.entity(id)?;
        if context.ifc_type == IfcType::IfcGeometricRepresentationContext
            && context.get(2).and_then(A::as_int) == Some(3)
        {
            contexts.push(id);
        }
    }
    if contexts.len() != 1 {
        return Err("Choose a model with one unambiguous root 3D representation context".into());
    }
    let scale = source.decoder.length_unit_scale();
    if !scale.is_finite() || scale <= 0. {
        return Err("Invalid model length unit".into());
    }
    let context = source
        .context
        .as_ref()
        .ok_or("Missing canonical load context")?;
    let rtc_offset = if context.meta.needs_shift {
        context.meta.rtc_offset.into()
    } else {
        [0.; 3]
    };
    let transform = context
        .router()
        .resolve_scaled_placement(&container, &mut source.decoder)
        .map_err(|e| e.to_string())?;
    let columns: [[f64; 3]; 3] =
        std::array::from_fn(|i| std::array::from_fn(|j| transform[i * 4 + j]));
    if transform.iter().any(|v| !v.is_finite())
        || (0..3).any(|i| {
            (0..3)
                .any(|j| (dot(columns[i], columns[j]) - if i == j { 1. } else { 0. }).abs() > 1e-10)
        })
        || dot(cross(columns[0], columns[1]), columns[2]) < 0.999999
    {
        return Err(
            "Annotation container placement must be a finite right-handed rigid frame".into(),
        );
    }
    let inverse = |v: [f64; 3]| columns.map(|c| dot(c, v));
    let origin =
        inverse(std::array::from_fn(|i| f.origin[i] - transform[12 + i])).map(|v| v / scale);
    let u = inverse(f.axis_u);
    let normal = inverse(cross(f.axis_u, f.axis_v));
    let size = f.size_metres.map(|v| v / scale);
    if origin.iter().chain(&size).any(|v| !v.is_finite()) {
        return Err("Annotation placement exceeds numeric range".into());
    }
    let mut author = Author {
        plan: AppearancePlan {
            source_revision: r.source_revision.to_owned(),
            next_express_id: r.next_express_id,
            next_available_express_id: r.next_express_id,
            ..Default::default()
        },
        entities: FxHashMap::default(),
    };
    let point = author.add(IfcType::IfcCartesianPoint, vec![vector(origin)]);
    let axis = author.add(IfcType::IfcDirection, vec![vector(normal)]);
    let direction = author.add(IfcType::IfcDirection, vec![vector(u)]);
    let axes = author.add(
        IfcType::IfcAxis2Placement3D,
        vec![
            A::EntityRef(point),
            A::EntityRef(axis),
            A::EntityRef(direction),
        ],
    );
    let placement = author.add(
        IfcType::IfcLocalPlacement,
        vec![
            container.get_ref(5).map_or(A::Null, A::EntityRef),
            A::EntityRef(axes),
        ],
    );
    Ok(Authoring {
        author,
        source,
        placement,
        context_id: contexts[0],
        owner: project.get_ref(1).map_or(A::Null, A::EntityRef),
        scale,
        rtc_offset,
    })
}
