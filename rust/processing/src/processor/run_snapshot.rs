// SPDX-License-Identifier: MPL-2.0
//! The native run's one immutable model snapshot (#7955 E2): captured once,
//! shared by every rayon job, re-taken only on the deferred style replay.
use super::*;

/// The run's one immutable model snapshot, shared by every job and re-taken
/// only when the deferred styled-item replay replaces the styles.
pub(super) struct RunSnapshot {
    model: crate::element::ProductionModel,
    data: crate::element::OwnedMeshProductionData,
    context: std::sync::Arc<crate::element::OwnedMeshProductionContext>,
}

impl RunSnapshot {
    pub(super) fn new(data: crate::element::OwnedMeshProductionData) -> Self {
        let model = crate::element::ProductionModel::new();
        let context = model.snapshot(data.clone());
        Self {
            model,
            data,
            context,
        }
    }

    pub(super) fn context(&self) -> &crate::element::OwnedMeshProductionContext {
        &self.context
    }

    /// A new revision with the replayed styles; every other map is shared.
    pub(super) fn replace_styles(
        &mut self,
        styles: &std::sync::Arc<FxHashMap<u32, GeometryStyleInfo>>,
    ) {
        self.data.geometry_style_index = std::sync::Arc::clone(styles);
        self.context = self.model.snapshot(self.data.clone());
    }
}

/// The site-local rotation, moved into the run snapshot once (native
/// `site_local` coordinate space only).
pub(super) fn site_rotation(
    site_transform: Option<&[f64]>,
    coord_space: MeshCoordinateSpace,
) -> Option<std::sync::Arc<Vec<f64>>> {
    let site_local = coord_space == MeshCoordinateSpace::SiteLocal;
    site_transform
        .filter(|_| site_local)
        .map(|rotation| std::sync::Arc::new(rotation.to_vec()))
}

/// An element whose model snapshot was refused publishes no meshes.
#[cold]
#[inline(never)]
pub(super) fn refused_by_context() -> Vec<MeshData> {
    Vec::new()
}
