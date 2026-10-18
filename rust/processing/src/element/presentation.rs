// SPDX-License-Identifier: MPL-2.0
//! Effective, source-free inputs to the last numerical presentation operation.
//! Packets are private linear values created only inside validated acceptance.
use super::{
    AssemblyJob, FullIndexedColourMap, MeshData, OwnedMeshProductionContext, RawInstanceOccurrence,
};
use ifc_lite_geometry::{GeometryHasher, Mesh};
use ifc_lite_geometry::{InstanceMeta, OrientVerdict, TextureAttachment};
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// Collection provenance is resolved before consuming its first part. A
/// material id must never become a geometry-item id, including on occurrences.
#[derive(Clone, Copy)]
pub(super) enum SourceId {
    None,
    Geometry(u32),
    Material(u32),
}
impl SourceId {
    pub fn collection(id: u32, materials: bool) -> Self {
        if materials {
            Self::Material(id)
        } else {
            Self::Geometry(id)
        }
    }
    pub fn fields(self) -> (Option<u32>, bool) {
        match self {
            Self::None => (None, false),
            Self::Geometry(id) => (Some(id), false),
            Self::Material(id) => (Some(id), true),
        }
    }
}

/// No per-part copy of the palette or model index. Synchronous borrowed callers
/// retain their zero-copy view; owned callers retain the original immutable Arc.
/// The key is the selected map key, not its potentially malformed geometry_id.
pub(super) enum Palette<'a> {
    Borrowed {
        maps: &'a FxHashMap<u32, FullIndexedColourMap>,
        key: u32,
    },
    Shared {
        maps: Arc<FxHashMap<u32, FullIndexedColourMap>>,
        key: u32,
    },
}
impl<'a> Palette<'a> {
    pub fn admitted(
        key: u32,
        maps: &'a FxHashMap<u32, FullIndexedColourMap>,
        context: Option<&Arc<OwnedMeshProductionContext>>,
    ) -> Self {
        match context {
            Some(context) => Self::Shared {
                maps: context.presentation_palettes(),
                key,
            },
            None => Self::Borrowed { maps, key },
        }
    }
    pub fn get(&self) -> Option<&FullIndexedColourMap> {
        match self {
            Self::Borrowed { maps, key } => maps.get(key),
            Self::Shared { maps, key } => maps.get(key),
        }
    }
}

pub(super) struct ReadyBody<'a> {
    pub mesh: Mesh,
    pub color: [f32; 4],
    pub material_name: Option<String>,
    pub source: SourceId,
    pub class: u8,
    pub uvs: Option<Vec<f32>>,
    pub texture: Option<TextureAttachment>,
    pub palette: Option<Palette<'a>>,
    pub palette_source: SourceId,
    pub hash: HashPolicy,
}

/// The fallback repairs missing normals after a rejected palette split; the
/// submesh path repairs them before source admission. Type maps are never hashed.
pub(super) enum HashPolicy {
    Submesh(OrientVerdict),
    Fallback(OrientVerdict),
    Type,
}

#[allow(clippy::large_enum_variant)] // move mesh buffers inline; avoid a heap allocation for every part
pub(super) enum ReadyPart<'a> {
    Body(ReadyBody<'a>),
    Instance {
        meta: InstanceMeta,
        color: [f32; 4],
        source: SourceId,
    },
}

/// Metadata and the frame travel with the part. Shared metadata is captured
/// once per product; the borrowed adapter never clones caller metadata.
/// No decoder, router, source bytes or source callback can enter this packet.
pub(super) struct ReadyPresentation<'a> {
    pub job: AssemblyJob<'a>,
    pub frame: PresentationFrame<'a>,
    pub part: ReadyPart<'a>,
}
pub(super) enum PresentationFrame<'a> {
    Borrowed(Option<&'a Vec<f64>>),
    Shared(Option<Arc<Vec<f64>>>),
}
impl PresentationFrame<'_> {
    fn rotation(&self) -> Option<&Vec<f64>> {
        match self {
            Self::Borrowed(rotation) => *rotation,
            Self::Shared(rotation) => rotation.as_deref(),
        }
    }
}
impl<'a> ReadyPresentation<'a> {
    pub fn new(
        part: ReadyPart<'a>,
        job: &AssemblyJob<'a>,
        rotation: Option<&'a Vec<f64>>,
        shared: Option<&Arc<OwnedMeshProductionContext>>,
    ) -> Self {
        let frame = match shared {
            Some(context) => PresentationFrame::Shared(context.presentation_rotation()),
            None => PresentationFrame::Borrowed(rotation),
        };
        Self {
            job: job.clone(),
            frame,
            part,
        }
    }
}

pub(super) fn assemble(
    ready: ReadyPresentation<'_>,
    hasher: &mut Option<GeometryHasher>,
) -> (Vec<MeshData>, Option<RawInstanceOccurrence>) {
    let ReadyPresentation { job, frame, part } = ready;
    match part {
        ReadyPart::Body(body) => (
            super::assembly_submeshes::emit_body(body, &job, frame.rotation(), hasher),
            None,
        ),
        ReadyPart::Instance {
            meta,
            color,
            source,
        } => (
            Vec::new(),
            Some(super::assembly_submeshes::occurrence(
                &job, source, &meta, color,
            )),
        ),
    }
}
