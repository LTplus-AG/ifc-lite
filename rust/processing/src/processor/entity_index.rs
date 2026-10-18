// SPDX-License-Identifier: MPL-2.0
//! A coherent canonical load or the explicit legacy supplied-index contract.
use std::sync::Arc;
use ifc_lite_core::{EntityDecoder,EntityIndex,GridAxisIndex,SourceBundle};
#[derive(Clone)]
pub(super) enum ProcessingIndex {
    Owned(Arc<SourceBundle>),
    Borrowed { spans:Arc<EntityIndex>, grid_axes:Arc<GridAxisIndex> },
}
impl ProcessingIndex {
    pub(super) fn hash(spans:Arc<EntityIndex>)->Self {
        Self::Borrowed {spans,grid_axes:Arc::default()}
    }
    pub(super) fn decoder<'a>(&'a self,content:&'a [u8])->EntityDecoder<'a> {
        match self {
            Self::Owned(source)=>source.decoder(),
            Self::Borrowed {..}=> {
                let mut decoder=EntityDecoder::new(content);
                self.install(&mut decoder);
                decoder
            }
        }
    }
    pub(super) fn install(&self,decoder:&mut EntityDecoder<'_>) {
        match self {
            Self::Owned(source)=>source.install_compatibility_index(decoder),
            Self::Borrowed {spans,grid_axes}=> {
                decoder.set_entity_index(spans.clone());
                decoder.set_grid_axis_index(grid_axes.clone());
            }
        }
    }
}
