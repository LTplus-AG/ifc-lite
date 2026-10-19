// SPDX-License-Identifier: MPL-2.0
//! Owned orphan-map stages: whole Items, ordered children, then late origin.

use super::{ItemListPolicy, ItemProgram};
use crate::processors::texture::TextureAttachment;
use crate::router::{frame_parts::SourceParts, GeometryRouter};
use crate::{Mesh, Result};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

type TexturedPart = (Mesh, Vec<f32>, TextureAttachment);
pub(crate) type TypeParts = Vec<(Mesh, Vec<f32>, Option<TextureAttachment>)>;

/// Source-free initial descriptor. Resolving the representation does not yet
/// admit Items or children, so callers can suspend at that exact boundary.
pub(crate) struct TypeMapSource { rep_map: DecodedEntity }
pub(crate) struct TypeMapItemsSource {
    rep_map: DecodedEntity,
    representation: DecodedEntity,
}

pub(crate) struct TypeMap {
    rep_map: DecodedEntity,
    items: ItemProgram,
    policy: bool,
    parts: TypeMapParts,
}

#[derive(Default)]
pub(crate) struct TypeMapParts {
    untextured: SourceParts,
    textured: Vec<TexturedPart>,
    retained: Option<Vec<super::retained::LogicalRetainedValue>>,
}

impl TypeMapSource {
    pub(crate) fn admit(self, decoder: &mut EntityDecoder<'_>) -> Result<TypeMapItemsSource> {
        let representation = super::mapping::representation(&self.rep_map, decoder)?;
        Ok(TypeMapItemsSource { rep_map: self.rep_map, representation })
    }
}

pub(crate) struct TypeMapItemsAdmission {
    rep_map: DecodedEntity,
    representation: DecodedEntity,
    items: ItemProgram,
}
impl TypeMapItemsSource {
    pub(crate) fn lower(self, decoder: &mut EntityDecoder<'_>) -> Result<TypeMapItemsAdmission> {
        // Whole Items precede the accepted counting claim and every child.
        let items = ItemProgram::admit(&self.representation, decoder, ItemListPolicy::RequiredMap)?;
        Ok(TypeMapItemsAdmission { rep_map: self.rep_map, representation: self.representation, items })
    }
}
impl TypeMapItemsAdmission {
    /// The enclosing common program validates the linear source reply before
    /// consuming this claim. Rejected replies cannot increment source counts.
    pub(crate) fn accept(self, router: &GeometryRouter) -> TypeMap {
        let policy = router.claim_unsupported_source(self.rep_map.id, &self.representation);
        TypeMap { rep_map: self.rep_map, items: self.items, policy, parts: TypeMapParts::default() }
    }
}

impl TypeMap {
    pub(crate) fn begin(rep_map: &DecodedEntity) -> TypeMapSource {
        TypeMapSource { rep_map: rep_map.clone() }
    }

    /// Taking a child is pure control. Repeated authored IFC IDs are separate
    /// entries in the admitted iterator and therefore separate occurrences.
    pub(crate) fn select_retained(&mut self) {self.parts.retained=Some(Vec::new());}
    pub(crate) fn next(&mut self) -> Option<DecodedEntity> { self.items.next() }
    pub(crate) fn policy(&self) -> bool { self.policy }

    /// Parent-driven children return their actual merged/textured result. The
    /// merge itself is a consuming numerical operation, never accept-time work.
    pub(crate) fn merge(&mut self, output: TypeItemOutput) -> ReadyTypeMerge {
        ReadyTypeMerge { parts: std::mem::take(&mut self.parts), output }
    }

    pub(crate) fn accept_merge(&mut self, parts: TypeMapParts) { self.parts = parts; }

    /// Only called after the final child has returned. MappingOrigin must stay
    /// late: a selected extension can repair it while producing an earlier item.
    pub(crate) fn origin(self) -> TypeMapOrigin { TypeMapOrigin { program: self } }
}

pub(crate) enum TypeItemOutput {
    Retained(Vec<super::retained::LogicalRetainedValue>),
    Parts(Vec<Mesh>),
    Textured(Mesh, Vec<f32>, TextureAttachment),
}

pub(crate) struct ReadyTypeMerge { parts: TypeMapParts, output: TypeItemOutput }
impl ReadyTypeMerge {
    #[cfg(test)]
    pub(crate) fn execute(self) -> TypeMapParts { self.execute_checked().expect("exact type merge") }
    pub(crate) fn execute_checked(mut self) -> Result<TypeMapParts> {
        crate::resource::check_current()?;
        match self.output {
            TypeItemOutput::Retained(mut values)=> {
                let parts=self.parts.retained.as_mut().ok_or_else(||crate::Error::geometry("type-map contract mismatch"))?;
                crate::resource::charge(crate::resource::Cost {work:values.len() as u64,..Default::default()})?.retain();
                crate::resource::reserve_headers(parts,values.len())?.retain();parts.append(&mut values);
            }
            TypeItemOutput::Parts(parts) => {
                for mesh in parts { self.parts.untextured.merge(&mesh); }
            }
            TypeItemOutput::Textured(mesh, uvs, texture) =>
                self.parts.textured.push((mesh, uvs, texture)),
        }
        crate::resource::check_current()?; Ok(self.parts)
    }
}

pub(crate) struct TypeMapOrigin { program: TypeMap }
impl TypeMapOrigin {
    pub(crate) fn admit(self, router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>) -> Result<ReadyTypeMap> {
        let origin = router.with_unsupported_policy(self.program.policy, || {
            origin(&self.program.rep_map, router, decoder)
        })?;
        Ok(ReadyTypeMap { untextured: self.program.parts.untextured,
            textured: self.program.parts.textured, retained:self.program.parts.retained, map_id:self.program.rep_map.id, origin })
    }
}

/// Fully numerical finish packet. In particular it contains no rep-map entity,
/// texture index, router, callback, decoder or model/source context.
pub(crate) struct ReadyTypeMap {
    untextured: SourceParts,
    textured: Vec<TexturedPart>,
    retained: Option<Vec<super::retained::LogicalRetainedValue>>,
    map_id:u32,
    origin: Option<Matrix4<f64>>,
}
pub(crate) enum TypeMapValues { Mesh(TypeParts), Retained(Vec<super::retained::LogicalRetainedValue>) }
impl ReadyTypeMap {
    pub(crate) fn execute_values(mut self)->Result<TypeMapValues> {
        crate::resource::check_current()?;
        if let Some(values)=self.retained.take() {
            let mut output=Vec::new();crate::resource::reserve_headers(&mut output,values.len())?.retain();
            for mut value in values {
                value.present(super::retained_presentation::RetainedPresentation::occurrence(self.map_id,self.map_id,None,true))?;
                output.push(value.placed(&self.origin.unwrap_or_else(Matrix4::identity),0,
                    super::retained::RetainedPlacementStage::TypeMap {representation_map:self.map_id})?);
            }
            return Ok(TypeMapValues::Retained(output));
        }
        let parts=self.execute();crate::resource::check_current()?;Ok(TypeMapValues::Mesh(parts))
    }
    pub(crate) fn execute(self) -> TypeParts {
        let mut out = Vec::new();
        for (mut mesh, uvs, texture) in self.textured {
            finish_mesh(&mut mesh, self.origin.as_ref());
            out.push((mesh, uvs, Some(texture)));
        }
        for mut mesh in self.untextured.into_parts().into_iter().filter(|mesh| !mesh.is_empty()) {
            finish_mesh(&mut mesh, self.origin.as_ref());
            out.push((mesh, Vec::new(), None));
        }
        out
    }
}

fn finish_mesh(mesh: &mut Mesh, origin: Option<&Matrix4<f64>>) {
    if let Some(transform) = origin {
        crate::router::transforms::transform_mesh_local(mesh, transform);
    }
    // Index-only cleanup leaves the corresponding per-vertex UV array intact.
    mesh.clean_degenerate();
}

fn origin(rep_map: &DecodedEntity, router: &GeometryRouter,
    decoder: &mut EntityDecoder<'_>) -> Result<Option<Matrix4<f64>>> {
    Ok(match rep_map.get(slot::IfcRepresentationMap::MAPPING_ORIGIN.index()) {
        Some(attribute) if !attribute.is_null() => match decoder.resolve_ref(attribute)? {
            Some(origin) if origin.ifc_type == IfcType::IfcAxis2Placement3D => {
                let mut transform = router.parse_axis2_placement_3d(&origin, decoder)?;
                router.scale_transform(&mut transform);
                Some(transform)
            }
            _ => None,
        },
        _ => None,
    })
}

#[cfg(test)]
mod tests;
