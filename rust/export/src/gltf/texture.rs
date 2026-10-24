// SPDX-License-Identifier: MPL-2.0
//! Opt-in IFC surface textures in glTF (#7955 J5), behind
//! [`super::GltfOptions::textures`]: `TEXCOORD_0`, `images`, `samplers`,
//! `textures` and textured materials.
//!
//! The UVs are the canonical `MeshData::uvs` copied verbatim (Rust already
//! flipped V to the top-left origin glTF uses). A decoded texture
//! (`IfcBlobTexture`/`IfcPixelTexture`) is encoded to PNG once and embedded in
//! the GLB's binary chunk through a bufferView (no base64 text, so the export
//! holds the PNG bytes once rather than a 4/3-size string). An
//! `IfcImageTexture` keeps its `URLReference` as a relative `uri`, so the image
//! stays a sibling file exactly as the IFC authored it; an absolute path, a
//! drive letter, a scheme (`C:\x.png`, `/x.png`, `https://…`) or a `..` that
//! climbs above the export's directory (`../shared/x.png`) is refused, because
//! it would point outside the export. One glTF texture per
//! `IfcSurfaceTexture` id, one sampler per repeat mode.
//!
//! Materials match the viewer's textured pipeline: the style colour is the
//! `baseColorFactor` that multiplies the texel, and the surface is opaque
//! except that a texel with alpha below 0.004 is discarded. That is glTF
//! `MASK` with the cutoff scaled by the tint alpha (glTF compares
//! `factor.a * texel.a`), so a cut-out texture keeps its holes in every
//! consumer and a partially transparent texel stays opaque, as on screen. The
//! viewer skips a textured mesh whose own alpha is at most 0.01; its material
//! gets cutoff 1.0, which no fragment (alpha at most 0.01) reaches, so it is
//! hidden in glTF as well. With tint alpha 0 the scaled cutoff would be 0 and
//! keep every fragment.
use super::Material;
use crate::ExportError;
use ifc_lite_processing::MeshTextureData;
use rustc_hash::FxHashMap;
use serde::Serialize;

/// A view's texture appearance: UVs one pair per vertex, plus the texture.
#[derive(Clone, Copy)]
pub struct ViewTexture<'a> {
    pub uvs: &'a [f32],
    pub texture: &'a MeshTextureData,
}

#[cfg(feature = "gltf-textures")]
impl ViewTexture<'_> {
    /// Refuse an appearance that cannot be exported faithfully, instead of
    /// letting a textured mesh fall back to solid colour.
    fn validate(&self, express_id: u32, positions: usize) -> Result<(), ExportError> {
        let fail = |what: String| ExportError::IncompleteAppearance { detail: format!("textured mesh #{express_id}: {what}") };
        if self.uvs.len() / 2 != positions / 3 || !self.uvs.len().is_multiple_of(2) {
            return Err(fail(format!("{} UV floats for {} vertices", self.uvs.len(), positions / 3)));
        }
        if !self.uvs.iter().all(|v| v.is_finite()) {
            return Err(fail("non-finite UV".into()));
        }
        let t = self.texture;
        match (&t.rgba, &t.url) {
            (Some(rgba), _) => {
                let expected = u64::from(t.width) * u64::from(t.height) * 4;
                if t.width == 0 || t.height == 0 || rgba.len() as u64 != expected {
                    return Err(fail(format!("{}x{} texture with {} RGBA bytes", t.width, t.height, rgba.len())));
                }
            }
            (None, Some(url)) if !url.is_empty() => {}
            _ => return Err(fail("texture has neither decoded pixels nor an image URL".into())),
        }
        Ok(())
    }
}

/// An image: a relative `uri`, or (decoded pixels) a PNG in the binary chunk.
#[derive(Serialize)]
pub(super) struct Image {
    #[serde(skip_serializing_if = "Option::is_none")]
    uri: Option<String>,
    #[serde(rename = "bufferView", skip_serializing_if = "Option::is_none")]
    buffer_view: Option<u32>,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    mime_type: Option<&'static str>,
}

#[derive(Serialize)]
pub(super) struct Sampler {
    #[serde(rename = "magFilter")]
    mag_filter: u32,
    #[serde(rename = "minFilter")]
    min_filter: u32,
    #[serde(rename = "wrapS")]
    wrap_s: u32,
    #[serde(rename = "wrapT")]
    wrap_t: u32,
}

#[derive(Serialize)]
pub(super) struct Texture {
    sampler: u32,
    source: u32,
}

#[derive(Serialize)]
pub(super) struct TextureInfo {
    pub index: u32,
}

/// The texture arrays of the glTF document, flattened into it. All `None`
/// unless a textured mesh was exported, so untextured output is unchanged.
#[derive(Serialize, Default)]
pub(super) struct GltfTextures {
    #[serde(skip_serializing_if = "Option::is_none")]
    images: Option<Vec<Image>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    samplers: Option<Vec<Sampler>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    textures: Option<Vec<Texture>>,
}

/// A textured material's dedup key: (glTF texture index, colour key).
/// (texture, tint is at or below the viewer's hide threshold, colour key): the
/// hide side decides the MASK cutoff, so it must never be merged by rounding.
type MaterialKey = (u32, bool, (i32, i32, i32, i32));

/// Images, samplers and textures prepared before assembly (encoding can
/// fail; assembly cannot), plus the textured materials assembly creates.
#[derive(Default)]
pub(super) struct TextureTable {
    images: Vec<Image>,
    samplers: Vec<Sampler>,
    textures: Vec<Texture>,
    by_texture_id: FxHashMap<u32, u32>,
    #[cfg(feature = "gltf-textures")]
    by_wrap: FxHashMap<(bool, bool), u32>,
    materials: FxHashMap<MaterialKey, u32>,
    /// Encoded PNGs awaiting their bufferView: (image index, bytes).
    pngs: Vec<(usize, Vec<u8>)>,
}

/// The viewer's textured-pipeline discard threshold on texel alpha
/// (`packages/renderer/src/shaders/textured.wgsl.ts`).
const DISCARD_ALPHA: f32 = 0.004;

/// The viewer skips a textured mesh whose own alpha is at most this
/// (`packages/renderer/src/index.ts`, textured sub-pass).
const HIDE_ALPHA: f32 = 0.01;

#[cfg(feature = "gltf-textures")]
const LINEAR: u32 = 9729;
#[cfg(feature = "gltf-textures")]
const LINEAR_MIPMAP_LINEAR: u32 = 9987;
#[cfg(feature = "gltf-textures")]
const REPEAT: u32 = 10497;
#[cfg(feature = "gltf-textures")]
const CLAMP_TO_EDGE: u32 = 33071;

impl TextureTable {
    /// Validate every textured view and encode each distinct texture once.
    #[cfg(feature = "gltf-textures")]
    pub(super) fn prepare<'a>(
        views: impl Iterator<Item = (u32, usize, ViewTexture<'a>)>,
    ) -> Result<Self, ExportError> {
        let mut table = Self::default();
        for (express_id, positions, appearance) in views {
            appearance.validate(express_id, positions)?;
            let t = appearance.texture;
            if table.by_texture_id.contains_key(&t.texture_id) {
                continue;
            }
            let image = match (&t.rgba, &t.url) {
                (Some(rgba), _) => {
                    table.pngs.push((table.images.len(), encode_png(rgba, t.width, t.height)?));
                    Image { uri: None, buffer_view: None, mime_type: Some("image/png") }
                }
                (None, Some(url)) => {
                    let uri = relative_uri(url).ok_or_else(|| ExportError::IncompleteAppearance {
                        detail: format!(
                            "textured mesh #{express_id}: image reference {url:?} is absolute, has a scheme or \
                             climbs out with `..`; only a reference inside the export's directory stays with it"
                        ),
                    })?;
                    Image { uri: Some(uri), buffer_view: None, mime_type: None }
                }
                (None, None) => unreachable!("validated above"),
            };
            let wrap = (t.repeat_s, t.repeat_t);
            let next_sampler = table.samplers.len() as u32;
            let sampler = *table.by_wrap.entry(wrap).or_insert_with(|| {
                let mode = |repeat: bool| if repeat { REPEAT } else { CLAMP_TO_EDGE };
                table.samplers.push(Sampler {
                    mag_filter: LINEAR,
                    min_filter: LINEAR_MIPMAP_LINEAR,
                    wrap_s: mode(wrap.0),
                    wrap_t: mode(wrap.1),
                });
                next_sampler
            });
            table.images.push(image);
            table.textures.push(Texture { sampler, source: table.images.len() as u32 - 1 });
            table.by_texture_id.insert(t.texture_id, table.textures.len() as u32 - 1);
        }
        Ok(table)
    }

    #[cfg(not(feature = "gltf-textures"))]
    pub(super) fn prepare<'a>(mut views: impl Iterator<Item = (u32, usize, ViewTexture<'a>)>) -> Result<Self, ExportError> {
        if views.next().is_some() {
            return Err(ExportError::UnsupportedOption { option: "textures", detail: "glTF texture support is disabled in this build" });
        }
        Ok(Self::default())
    }

    /// The textured material for one view: the style colour's material with
    /// the texture as `baseColorTexture`, deduped by (texture, colour).
    /// `None` only for a texture `prepare` never saw.
    pub(super) fn material(
        &mut self,
        materials: &mut Vec<Material>,
        texture: &MeshTextureData,
        color: [f32; 4],
        lit: bool,
        emissive: bool,
    ) -> Option<u32> {
        let index = *self.by_texture_id.get(&texture.texture_id)?;
        let key = (index, color[3] <= HIDE_ALPHA, super::color_key(color));
        Some(*self.materials.entry(key).or_insert_with(|| {
            let mut material = super::make_material(color, lit, emissive);
            material.pbr.base_color_texture = Some(TextureInfo { index });
            material.alpha_mode = Some("MASK");
            let tint = material.pbr.base_color_factor[3];
            material.alpha_cutoff = Some(if tint <= HIDE_ALPHA { 1.0 } else { DISCARD_ALPHA * tint });
            materials.push(material);
            materials.len() as u32 - 1
        }))
    }

    /// Move the encoded PNGs into the single GLB buffer, after its flushed
    /// runs, and point each image at its bufferView.
    pub(super) fn embed_images(&mut self, ch: &mut super::Chunker) {
        for (image, png) in std::mem::take(&mut self.pngs) {
            self.images[image].buffer_view = Some(ch.embed_image(&png));
        }
    }

    pub(super) fn into_json(self) -> GltfTextures {
        GltfTextures {
            images: (!self.images.is_empty()).then_some(self.images),
            samplers: (!self.samplers.is_empty()).then_some(self.samplers),
            textures: (!self.textures.is_empty()).then_some(self.textures),
        }
    }
}

#[cfg(feature = "gltf-textures")]
pub(super) fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, ExportError> {
    let fail = |e: png::EncodingError| ExportError::Serialization { stage: "texture PNG", detail: e.to_string() };
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(fail)?;
    writer.write_image_data(rgba).map_err(fail)?;
    writer.finish().map_err(fail)?;
    Ok(out)
}

/// A relative URI reference (RFC 3986 relative-path) for an authored image
/// path, or `None` when the reference would leave the export: rooted (`/x`,
/// `\\server`), led by a drive letter or scheme (`C:\x`, `https:`, `file:`,
/// `data:`), or climbing above its own directory (`../x`, `a/../../x`,
/// percent-encoded dots included). Encoded separators or colons are refused
/// before a consumer can decode them into a path. Windows separators become
/// `/`; unreserved bytes, `/` and other well-formed `%XX` escapes stay; everything
/// else (spaces, non-ASCII, `:`, `?`, `#`, a stray `%`) is percent-encoded, so
/// `textures\brick wall.jpg` resolves as `textures/brick%20wall.jpg`.
#[cfg(feature = "gltf-textures")]
fn relative_uri(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    if path.is_empty()
        || matches!(bytes[0], b'/' | b'\\')
        || bytes.windows(3).any(|escape| {
            escape.eq_ignore_ascii_case(b"%2f")
                || escape.eq_ignore_ascii_case(b"%5c")
                || escape.eq_ignore_ascii_case(b"%3a")
        })
    {
        return None;
    }
    // A scheme (or drive letter) is a leading ALPHA *( ALPHA / DIGIT / "+" /
    // "-" / "." ) ending at the first ':' before any separator.
    let first_segment = path.split(['/', '\\', '?', '#']).next().unwrap_or_default();
    if let Some((scheme, _)) = first_segment.split_once(':') {
        let mut chars = scheme.bytes();
        let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'-' | b'.'));
        if valid {
            return None;
        }
    }
    if climbs_out(path) {
        return None;
    }
    let hex = |i: usize| bytes.get(i).is_some_and(u8::is_ascii_hexdigit);
    let mut out = String::with_capacity(path.len());
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => out.push(b as char),
            b'\\' => out.push('/'),
            b'%' if hex(i + 1) && hex(i + 2) => out.push('%'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    Some(out)
}

/// Whether the dot-segments of `path` climb above the directory it starts
/// in. `%2E` is a dot to a URI resolver, so it counts as one.
#[cfg(feature = "gltf-textures")]
fn climbs_out(path: &str) -> bool {
    let mut depth = 0_usize;
    for segment in path.split(['/', '\\']) {
        let normalized = segment.to_ascii_lowercase().replace("%2e", ".").replace("%20", " ");
        // Windows can strip trailing dots/spaces from a parent segment.
        if normalized.starts_with("..")
            && normalized[2..].contains(' ')
            && normalized[2..].bytes().all(|b| matches!(b, b'.' | b' '))
        {
            return true;
        }
        match normalized.as_str() {
            ".." => match depth.checked_sub(1) {
                Some(up) => depth = up,
                None => return true,
            },
            "" | "." => {}
            _ => depth += 1,
        }
    }
    false
}

#[cfg(all(test, feature = "gltf-textures"))]
mod tests {
    use super::relative_uri;

    #[test]
    fn relative_uri_keeps_relative_paths_and_escapes_the_rest() {
        for (path, want) in [
            ("textures/brick wall.jpg", "textures/brick%20wall.jpg"),
            ("textures\\brick wall.jpg", "textures/brick%20wall.jpg"),
            ("textures\\x 1.png", "textures/x%201.png"),
            ("bild_ä.png", "bild_%C3%A4.png"),
            ("already%20escaped.png", "already%20escaped.png"),
            ("100%.png", "100%25.png"),
            ("a?b#c.png", "a%3Fb%23c.png"),
            ("textures/../x.png", "textures/../x.png"),
            ("a/b/../../x.png", "a/b/../../x.png"),
            ("..x/y.png", "..x/y.png"), // a name, not a dot-segment
            ("....", "...."),
            ("dir/a:b.png", "dir/a%3Ab.png"),
            ("1a:b.png", "1a%3Ab.png"), // not a scheme: starts with a digit
        ] {
            assert_eq!(relative_uri(path).as_deref(), Some(want), "{path}");
        }
    }

    #[test]
    fn relative_uri_refuses_references_that_leave_the_export() {
        for path in ["C:\\x.png", "C:/x.png", "c:x.png", "https://example.com/x.png", "file:///x.png", "data:image/png;base64,AA", "/abs/x.png", "\\\\server\\x.png", ""] {
            assert_eq!(relative_uri(path), None, "{path}");
        }
    }

    #[test]
    fn relative_uri_refuses_a_climb_above_the_export() {
        for path in [
            "../shared/x.png", "..\\shared\\x.png", "a/../../x.png", "./../x.png",
            "%2E%2E/x.png", ".%2e/x.png", "..",
            "..%2Fx.png", "a%2F..%2F..%2Fx.png", "..%5Cx.png",
            "%2Fetc%2Fx.png", "%5C%5Cserver%5Cx.png", "C%3A%5Cx.png",
            "https%3A%2F%2Fexample.com/x.png", "..%2fx.png", "..%5cx.png",
            "C%3a%5cx.png", ".. /x.png", ".. ./x.png", "..%20/x.png",
        ] {
            assert_eq!(relative_uri(path), None, "{path}");
        }
    }
}
