// SPDX-License-Identifier: MPL-2.0
//! Each descriptor admits one reached product source operation, never a walk.
use super::{ChildKind, ProductConsumer, ProductOutput, ReadyTexture};
use super::super::annotation::AnnotationFill;
use super::super::traversal::RepresentationItemsRequest;
use super::super::product_control::completion::{PlacementAdmission, ProductPlacementRequest};
use super::super::{EntryPolicy, GeometryProgram, ItemProgram, ProductProgram, TextureConstructor};
use crate::processors::texture::ResolvedTextureMap;
use crate::router::processing::SourceHygiene;
use crate::{GeometryRouter, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashMap;

pub(in crate::program) enum ProductSource {
    Begin { element: DecodedEntity, consumer: ProductConsumer },
    Items(RepresentationItemsRequest), Annotation { item: DecodedEntity },
    Texture { element: DecodedEntity, item: DecodedEntity, enabled: bool },
    Raw { element: DecodedEntity, item: DecodedEntity, consumer: ProductConsumer, retained_cache: Option<super::super::mapping::SharedRetainedCache> },
    Hygiene { requested: SourceHygiene, output: ProductOutput }, Placement(ProductPlacementRequest),
}
pub(in crate::program) enum ProductSourceReply {
    Begin(Result<Option<ProductProgram>>), Items(Result<ItemProgram>),
    Annotation(Result<AnnotationFill>), Texture(Result<Option<ReadyTexture>>),
    Child(Result<(GeometryProgram, ChildKind)>),
    Hygiene(SourceHygiene, ProductOutput), Placement(Result<PlacementAdmission>),
}
impl ProductSource {
    pub(in crate::program) fn execute(self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
        textures: Option<&FxHashMap<u32, ResolvedTextureMap>>) -> ProductSourceReply {
        match self {
            Self::Begin { element, consumer } => ProductSourceReply::Begin((|| {
                crate::resource::check_current()?;
                ProductProgram::admit(&element, match consumer {
                    ProductConsumer::Merged => EntryPolicy::MergedProduct,
                    ProductConsumer::Styled { .. } => EntryPolicy::StyledProduct,
                }, decoder)
            })()),
            Self::Items(request) => ProductSourceReply::Items(request.admit(decoder)),
            Self::Annotation { item } => ProductSourceReply::Annotation(
                AnnotationFill::admit(&item, decoder, router.unit_scale())),
            Self::Texture { element, item, enabled } => ProductSourceReply::Texture(
                texture(&element, &item, enabled, router, decoder, textures)),
            Self::Raw { element, item, consumer, .. } => ProductSourceReply::Child(
                child(element, item, consumer, router, decoder)),
            Self::Hygiene { requested, output } => ProductSourceReply::Hygiene(requested.for_router(router), output),
            Self::Placement(request) => ProductSourceReply::Placement(request.admit(router, decoder)),
        }
    }
}

fn child(element: DecodedEntity, item: DecodedEntity, consumer: ProductConsumer,
    router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> Result<(GeometryProgram, ChildKind)> {
    crate::resource::check_current()?;
    if router.has_rtc_offset()
        && router.representation_item_first_vertex_meters(&item, decoder).is_some_and(crate::coord_is_large)
        && router.processor_for(&item.ifc_type).is_some() {
        if let Some(offset) = router.element_frame_rtc(&element, decoder)? {
            return Ok((GeometryProgram::representation_item(item, offset), ChildKind::Mesh { raw: true }));
        }
    }
    match consumer {
        ProductConsumer::Merged if item.ifc_type == IfcType::IfcMappedItem =>
            Ok((GeometryProgram::mapped_merged(&item, router)?, ChildKind::Parts)),
        ProductConsumer::Merged => Ok((GeometryProgram::representation_item(item, router.rtc_offset()),
            ChildKind::Mesh { raw: false })),
        ProductConsumer::Styled { allow_instancing } =>
            Ok((GeometryProgram::mapped_styled(&item, allow_instancing, router)?, ChildKind::Styled)),
    }
}

fn texture(element: &DecodedEntity, item: &DecodedEntity, enabled: bool,
    router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
    textures: Option<&FxHashMap<u32, ResolvedTextureMap>>) -> Result<Option<ReadyTexture>> {
    if !enabled { return Ok(None) }
    let Some(map) = textures.and_then(|index| index.get(&item.id)).filter(|_| matches!(
        item.ifc_type, IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork))
        else { return Ok(None) };
    let offset = router.element_frame_rtc(element, decoder)?;
    ReadyTexture::admit(item, map, offset, router, decoder)
}

impl ReadyTexture {
    pub(in crate::program) fn admit(item: &DecodedEntity, map: &ResolvedTextureMap,
        offset: Option<(f64, f64, f64)>, router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>) -> Result<Option<Self>> {
        crate::resource::check_current()?;
        let rtc = offset.and_then(|offset| router.raw_item_rtc_file_units(item, decoder, offset).zip(Some(offset)));
        let plan = match TextureConstructor::admit(item, decoder, rtc.map(|(units, _)| units)) {
            Ok(plan) => plan,
            Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
            Err(_) => { crate::resource::check_current()?; return Ok(None) }
        };
        crate::resource::check_current()?;
        // Snapshot only this reached numerical UV input. The model's texture index
        // and source bundle remain borrowed execution inputs, never cloned frames.
        let mut coordinates = Vec::new();
        crate::resource::reserve_headers(&mut coordinates, map.tex_coords.len())?.retain();
        coordinates.extend_from_slice(&map.tex_coords);
        let indices = match &map.tex_coord_index {
            Some(authored) => {
                let mut indices = Vec::new();
                crate::resource::reserve_headers(&mut indices, authored.len())?.retain();
                indices.extend_from_slice(authored);
                Some(indices)
            }
            None => None,
        };
        Ok(Some(ReadyTexture { plan, coordinates, indices, attachment: map.attachment(),
            scale: router.unit_scale(), offset: rtc.map(|(_, offset)| offset) }))
    }
}

impl ProductSourceReply {
    pub(in crate::program) fn tag(&self) -> u16 {
        match self { Self::Begin(_)=>0, Self::Items(_)=>1, Self::Annotation(_)=>2, Self::Texture(_)=>3,
            Self::Child(_)=>4, Self::Hygiene(_,_)=>5, Self::Placement(_)=>6 }
    }
}

impl ProductSource {
    pub(in crate::program) fn execute_retained(self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
        textures: Option<&FxHashMap<u32, ResolvedTextureMap>>, contract: super::super::retained::RetainedContract) -> ProductSourceReply {
        match self {
            Self::Begin { .. } | Self::Items(_) | Self::Hygiene { .. } | Self::Placement(_) => self.execute(router, decoder, textures),
            Self::Texture { .. } => ProductSourceReply::Texture(Ok(None)),
            Self::Raw { item, consumer, retained_cache, .. } => ProductSourceReply::Child(
                if let ProductConsumer::Styled {allow_instancing}=consumer {
                    GeometryProgram::retained_styled(&item,allow_instancing,contract,router,retained_cache.expect("retained product cache")).map(|program|(program,ChildKind::Styled))
                } else if item.ifc_type == IfcType::IfcMappedItem {
                    GeometryProgram::retained_mapped(&item,contract,router,retained_cache.expect("retained product cache")).map(|program|(program,ChildKind::Parts))
                } else { Ok((GeometryProgram::retained_item(item,contract),ChildKind::Mesh {raw:false})) }),
            Self::Annotation { .. } => ProductSourceReply::Annotation(Err(crate::Error::geometry("retained annotation contract unavailable"))),
        }
    }
}
