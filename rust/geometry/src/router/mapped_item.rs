// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcMappedItem` source resolution: caching, bounded iterative traversal,
//! and merging an `IfcRepresentationMap`'s items into one source-coords mesh
//! per f64 frame (#6446).
//! Split out of `processing.rs` to stay within its module-size budget (#3691).

use super::frame_parts::{single_frame_source, SourceParts};
use super::item::ItemFrame;
use super::mapped_sink::MergeSink;
use crate::representation::{NestedMaps, RepresentationWalk, Select, MAX_WALK_LEVELS};
use super::GeometryRouter;
use crate::{Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::sync::Arc;

// Maximum nested IfcMappedItem depth for a single geometry item. Shared with
// `ifc_lite_processing::element` and the wasm styling colour resolver, which
// walk the same chain; the constant's own docs say why they must agree.
use ifc_lite_core::MAX_MAPPED_ITEM_DEPTH;

impl GeometryRouter {
    /// Process MappedItem with caching for repeated geometry.
    ///
    /// Errors when the source's items cannot share one f64 frame (#6446); use
    /// [`Self::process_mapped_item_parts`] to keep such a source at full precision.
    #[inline]
    pub(super) fn process_mapped_item_cached(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        single_frame_source("IfcMappedItem", item.id, self.process_mapped_item_parts(item, decoder)?)
    }

    /// [`Self::process_mapped_item_cached`] as frame parts: one mesh, unless the
    /// source's items lie in frames at least 1 km apart (#6446).
    ///
    /// The walk bounds the nesting (depth cap and a path-scoped visited set), so
    /// a malformed model with a cyclic (or absurdly deep) mapped-item chain
    /// terminates instead of overflowing the stack.
    pub(super) fn process_mapped_item_parts(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        let mut sink = MergeSink::new(self);
        let walk = RepresentationWalk {
            select: Select::Any,
            nested: NestedMaps::Expand { max_depth: MAX_MAPPED_ITEM_DEPTH, max_levels: MAX_WALK_LEVELS },
        };
        walk.mapped_item(item, decoder, &mut sink);
        crate::resource::check_current()?;
        match sink.error {
            Some(error) => Err(error),
            None => Ok(sink.parts.unwrap_or_default()),
        }
    }

    /// [`Self::process_representation_item`] as frame parts (#6446): only a
    /// mapped item can yield more than one.
    pub(in crate::router) fn process_representation_item_parts(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        if item.ifc_type != IfcType::IfcMappedItem {
            return self.process_representation_item(item, decoder).map(|mesh| vec![mesh]);
        }
        self.process_mapped_item_parts(item, decoder)
    }

    /// Deep-copy a source mesh for a mapped-item cache. Without an installed
    /// account this is `Mesh::clone`; with one, the copy is admitted (and its
    /// storage charged, never refunded) before any allocation, so a zero or
    /// overflowing allowance refuses it. Cache residency beyond the account's
    /// lifetime is not tracked here.
    pub(super) fn clone_source_for_cache(&self, mesh: &Mesh) -> Result<Arc<Mesh>> {
        self.clone_cached_mesh(mesh).map(Arc::new)
    }

    /// Accounted copy for both cache population and every cache hit, so a
    /// repeated occurrence is charged (or refused) like the first one.
    pub(super) fn clone_cached_mesh(&self, mesh: &Mesh) -> Result<Mesh> {
        if !crate::resource::is_active() {
            return Ok(mesh.clone());
        }
        let (copy, permit) = crate::resource::mesh::clone_mesh(mesh)?;
        permit.retain();
        Ok(copy)
    }

    /// Mesh one plain (non-`IfcMappedItem`) item of a mapped source into
    /// `source`. The one per-item step of the three source walks that do not
    /// go through [`Self::process_representation_item`]: this file,
    /// `ensure_shared_mapped_source` and the type-geometry walk (#7690).
    ///
    /// It rebases a raw-coordinate item by the model RTC in f64 before f32
    /// narrowing (#5698, ROUTER-27), kept as the item's origin (see
    /// [`Self::keep_rebase_in_origin`]), and, through
    /// [`Self::process_item_in_rtc_frame`], drains the #4901 curve-capped flag
    /// for this source rather than the next item on the thread (ROUTER-26). A
    /// failed or unsupported item is recorded as dropped; `walk` only names
    /// the caller in the debug message.
    pub(super) fn merge_source_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        source: &mut SourceParts,
        walk: &str,
    ) {
        let meshed = self.mesh_item(item, decoder, ItemFrame::MappedSource);
        match meshed {
            Ok(mesh) => {
                source.merge(&mesh);
            }
            Err(e) => {
                self.drop_item(item, &e, &format!("{walk} item"));
            }
        }
    }

    /// Re-express a mapped-source item rebased by the model RTC (`rtc_applied`,
    /// #5698) as positions relative to an f64 `origin` holding that offset.
    ///
    /// The model-frame rebase is right only for an item already in the model
    /// frame. A source item still goes through its `MappingTarget` and the
    /// occurrence placement, and `M (p - rtc)` is not `M p - rtc` once `M`
    /// rotates: a 1 degree placement put an LV95 source 50 km away (#7690).
    /// Every later transform carries `origin` exactly in f64, and the final
    /// placement then subtracts the RTC once, so the item keeps its precision
    /// at any rotation. A no-op for an item that was not rebased.
    pub(super) fn keep_rebase_in_origin(&self, mesh: &mut Mesh) {
        if mesh.rtc_applied {
            mesh.rtc_applied = false;
            let rtc = [self.rtc_offset.0, self.rtc_offset.1, self.rtc_offset.2];
            for (origin, offset) in mesh.origin.iter_mut().zip(rtc) {
                *origin += offset;
            }
        }
    }
}
