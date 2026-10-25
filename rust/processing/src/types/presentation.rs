// SPDX-License-Identifier: MPL-2.0
//! Opt-in presentation provenance (#7955 J5): what each produced mesh's
//! normals, palette colour and texture coordinates are bound to in source, or
//! why no such binding holds.
//!
//! Recorded only when `MeshProductionOptions::presentation_provenance` is set,
//! and in-memory only (`MeshData::presentation` is `#[serde(skip)]`), so the
//! default path, the JSON payload and every cache stay byte-identical. Each
//! record describes the exact path's output as it is: it reports a repair or a
//! loss and never changes what was produced.
//!
//! Scope: one element's late-presentation funnel. A binding after a topology
//! change (void cut, clip, layer slice) needs persistent face ancestry, so such
//! a mesh reports the loss (`Retopologized`, `UvAuthority::Dropped`) rather
//! than a guessed correspondence.

/// Provenance of one produced mesh's presentation channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MeshPresentationProvenance {
    pub normals: NormalProvenance,
    /// `None` when no `IfcIndexedColourMap` reached this mesh's body.
    pub palette: Option<PaletteBinding>,
    /// `None` when the body carried no surface texture.
    pub texture: Option<TextureBinding>,
}

impl MeshPresentationProvenance {
    /// A fixed display colour replaced the mesh's colour and removed its
    /// texture: no palette entry or texture describes it any more.
    pub(crate) fn overridden_by_fixed_display_colour(&mut self) {
        self.palette = self
            .palette
            .map(|p| PaletteBinding::Absent { map_id: p.map_id(), reason: PaletteAbsence::FixedDisplayColour });
        self.texture = None;
    }
}

/// Who wrote the normals this mesh ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NormalProvenance {
    /// The geometry producer's normals (flat, heuristic radial or
    /// area-weighted, per producer), carried through every placement by the
    /// one inverse-transpose policy.
    Producer,
    /// The outward orienter flipped triangles and the funnel recomputed
    /// area-weighted normals, replacing the producer's. A reflected placement
    /// takes this path, so a mirrored smooth body loses its producer normals.
    RecomputedAfterWindingRepair,
    /// The producer supplied none, or a count that did not match the
    /// positions; the funnel computed area-weighted normals.
    RecomputedMissing,
}

/// Binding of a mesh's colour to an `IfcIndexedColourMap` palette entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteBinding {
    /// Every triangle of this mesh is source-coloured by palette entry
    /// `palette_index` (0-based) of map `map_id`, which colours face set
    /// `face_set_id`, and the map was read verbatim.
    Bound { map_id: u32, face_set_id: u32, palette_index: u32 },
    /// The body reached map `map_id`, but no binding holds.
    Absent { map_id: u32, reason: PaletteAbsence },
}

impl PaletteBinding {
    pub fn map_id(&self) -> u32 {
        match *self {
            Self::Bound { map_id, .. } | Self::Absent { map_id, .. } => map_id,
        }
    }
}

/// Why a body that reached a palette carries no binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteAbsence {
    /// The resolver repaired the map (shifted colour rows or clamped indices);
    /// the displayed colours are not the source's.
    Malformed,
    /// The body's triangles are not the face set's `CoordIndex` rows one for
    /// one: the triangle count no longer matches `ColourIndex` (a cut, or the
    /// mesher dropped a triangle naming a missing point), or the face set is
    /// polygonal (`ColourIndex` is per face; a face triangulates to several
    /// triangles or none). A display split may still have happened by
    /// triangle index; it is not a source binding.
    Retopologized,
    /// The triangle count matches `ColourIndex`, but the body went through a
    /// Boolean void cut or a material-layer slice (either can keep the
    /// count), is merged from several items, or its face set could not be
    /// read: nothing proves triangle `i` is `CoordIndex` row `i`.
    Unproven,
    /// A single-entry map whose colour is not the colour displayed: another
    /// style took precedence.
    StyleOverride,
    /// A valid surface texture took precedence over the palette.
    SupersededByTexture,
    /// The element's class has a fixed display colour (openings).
    FixedDisplayColour,
}

/// Binding of a mesh's texture coordinates to the source texture map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextureBinding {
    /// `IfcSurfaceTexture` express id (the `MeshTextureData::texture_id`).
    pub texture_id: u32,
    /// The face set the texture map was looked up by, when known.
    pub face_set_id: Option<u32>,
    pub uv_authority: UvAuthority,
}

/// How far the shipped UVs are the source's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UvAuthority {
    /// Every triangle the mesher emitted has an authored `TexCoordIndex` row
    /// whose three 1-based indices lie inside `TexCoords`.
    Authored,
    /// `TexCoordIndex` is `$`: the spec pairs texture vertices 1:1 with the
    /// face set's `Coordinates`, and every emitted corner's paired texture
    /// vertex exists.
    CoordinatePaired,
    /// A missing `TexCoordIndex` row or an index outside `TexCoords` made the
    /// mesher emit `(0, 0)` for at least one corner of an emitted triangle.
    /// Conservative: a later degenerate-triangle drop may remove that corner.
    Fabricated,
    /// The UVs could not be checked: no texture map for this body's source id
    /// (type maps carry no item id here), or the face set's index arrays or
    /// point count could not be read without side effects.
    UnknownMap,
    /// The source bound a texture, but this mesh's UV channel no longer
    /// matched its positions (rebuilt vertices), so the mesh ships untextured.
    Dropped,
}

/// The authority of a resolved texture map's UVs, given how many corners of
/// the triangles the mesher emitted it filled with `(0, 0)`
/// (`TriangulatedFaceSetProcessor::fabricated_uv_corners`; `None` = unknown).
pub(crate) fn uv_authority(map: &ifc_lite_geometry::ResolvedTextureMap, fabricated: Option<usize>) -> UvAuthority {
    match (fabricated, map.tex_coord_index.is_some()) {
        (None, _) => UvAuthority::UnknownMap,
        (Some(1..), _) => UvAuthority::Fabricated,
        (Some(0), true) => UvAuthority::Authored,
        (Some(0), false) => UvAuthority::CoordinatePaired,
    }
}
