// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared helpers for the quick-metadata bootstrap tests: run the streaming
//! pipeline with the bootstrap on, and look nodes up in the tree it emits.

use ifc_lite_processing::{
    process_geometry_streaming_with_options_and_bootstrap, QuickMetadataBootstrap,
    QuickMetadataSpatialNode, StreamingOptions,
};

/// The quick-metadata bootstrap `ifc` produces.
pub fn bootstrap(ifc: &str) -> QuickMetadataBootstrap {
    let mut bootstrap = None;
    process_geometry_streaming_with_options_and_bootstrap(
        ifc.as_bytes(),
        StreamingOptions {
            emit_quick_metadata_bootstrap: true,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |b| bootstrap = Some(b.clone()),
    );
    bootstrap.expect("quick metadata bootstrap was requested")
}

pub fn tree(bootstrap: &QuickMetadataBootstrap) -> &QuickMetadataSpatialNode {
    bootstrap
        .spatial_tree
        .as_ref()
        .expect("the bootstrap carries a spatial tree")
}

/// The child `#id` of `node`; panics naming the children it does have.
pub fn child(node: &QuickMetadataSpatialNode, id: u32) -> &QuickMetadataSpatialNode {
    node.children
        .iter()
        .find(|c| c.summary.express_id == id)
        .unwrap_or_else(|| {
            let ids: Vec<u32> = node.children.iter().map(|c| c.summary.express_id).collect();
            panic!(
                "#{id} missing under #{}; its children are {ids:?}",
                node.summary.express_id
            )
        })
}

/// How many times `#id` appears in the subtree under `node`.
pub fn count(node: &QuickMetadataSpatialNode, id: u32) -> usize {
    usize::from(node.summary.express_id == id)
        + node.children.iter().map(|c| count(c, id)).sum::<usize>()
}
