// SPDX-License-Identifier: MPL-2.0
//! USD material identity and the finish side data collected by the native pass.

use ifc_lite_processing::style::SpecularMaterial;
use ifc_lite_processing::ProcessingSink;

/// The rounded colour key (shared with glTF) plus the exact emitted finish.
/// Store normalized floating-point bits for deterministic ordering and names.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct MaterialKey {
    pub(super) color: (i32, i32, i32, i32),
    finish: [u32; 2],
}

impl MaterialKey {
    const DEFAULT_FINISH: [u32; 2] = [0.0_f32.to_bits(), 1.0_f32.to_bits()];

    pub(super) fn new(color: [f32; 4], finish: Option<SpecularMaterial>) -> Self {
        let finish = finish.unwrap_or_default();
        let value = |authored: Option<f32>, default: f32| {
            // Canonicalize negative zero as well as clamping.
            let value = authored
                .filter(|v| v.is_finite())
                .unwrap_or(default)
                .clamp(0.0, 1.0);
            (value + 0.0).to_bits()
        };
        Self {
            color: crate::color_space::material_key(color),
            finish: [value(finish.metallic, 0.0), value(finish.roughness, 1.0)],
        }
    }

    pub(super) fn name(self) -> String {
        let (r, g, b, a) = self.color;
        let [metallic, roughness] = self.finish;
        if self.finish == Self::DEFAULT_FINISH {
            format!("Mat_{r}_{g}_{b}_{a}")
        } else {
            format!("Mat_{r}_{g}_{b}_{a}_{metallic:08x}_{roughness:08x}")
        }
    }

    pub(super) fn finish(self) -> [f32; 2] {
        self.finish.map(f32::from_bits)
    }
}

#[derive(Default)]
pub(super) struct Finishes {
    pub(super) meshes: Vec<Option<SpecularMaterial>>,
    pub(super) instances: Vec<Option<SpecularMaterial>>,
}

impl ProcessingSink for Finishes {
    fn on_finishes(&mut self, finishes: &[Option<SpecularMaterial>]) {
        self.meshes.extend_from_slice(finishes);
    }

    fn on_instance_finishes(&mut self, finishes: &[Option<SpecularMaterial>]) {
        self.instances.extend_from_slice(finishes);
    }
}
