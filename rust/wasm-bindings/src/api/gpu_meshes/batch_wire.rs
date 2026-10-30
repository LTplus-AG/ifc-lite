// SPDX-License-Identifier: MPL-2.0
//! Internal positional-wire adapter; public wasm-bindgen signatures stay fixed.

pub(super) struct BatchWire<'a> {
    pub jobs_flat: &'a [u32],
    pub unit_scale: f64,
    pub rtc_x: f64,
    pub rtc_y: f64,
    pub rtc_z: f64,
    pub needs_shift: bool,
    pub void_keys: &'a [u32],
    pub void_counts: &'a [u32],
    pub void_values: &'a [u32],
    pub style_ids: &'a [u32],
    pub style_colors: &'a [u8],
    pub plane_angle_to_radians: Option<f64>,
    pub material_element_ids: Option<Vec<u32>>,
    pub material_color_counts: Option<Vec<u32>>,
    pub material_colors_rgba: Option<Vec<u8>>,
}

/// Held sources own their Arc until production AND output encoding complete.
/// Borrowed sources never copy bytes. An absent installed source stays empty.
pub(super) enum BatchSource<'a> {
    Borrowed(&'a [u8]),
    Held(std::sync::Arc<Vec<u8>>),
}
impl AsRef<[u8]> for BatchSource<'_> {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Borrowed(bytes) => bytes,
            Self::Held(bytes) => bytes,
        }
    }
}
impl crate::api::IfcAPI {
    pub(super) fn batch_flat(
        &self,
        source: BatchSource<'_>,
        wire: BatchWire<'_>,
    ) -> crate::zero_copy::MeshCollection {
        super::batch_output::flat(self.produce_batch(source.as_ref(), &wire, false), &wire)
    }
    pub(super) fn batch_instanced(&self, source: BatchSource<'_>, wire: BatchWire<'_>) -> Vec<u8> {
        // No flat carrier for sub-threshold recovery: keep materializing here.
        super::batch_output::instanced(self.produce_batch(source.as_ref(), &wire, false), &wire)
    }
    pub(super) fn batch_partitioned(
        &self,
        source: BatchSource<'_>,
        wire: BatchWire<'_>,
    ) -> super::partitioned_batch::PartitionedBatch {
        super::batch_output::partitioned(self.produce_batch(source.as_ref(), &wire, true), &wire)
    }
}
