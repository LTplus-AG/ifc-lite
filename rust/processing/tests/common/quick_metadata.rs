// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared helpers for the quick-metadata bootstrap tests: run the streaming
//! pipeline with the bootstrap on, and look nodes up in the tree it emits.

use ifc_lite_processing::{
    process, Features, ProcessingRequest, ProcessingResult, ProcessingSink, QuickMetadataBootstrap,
    QuickMetadataSpatialNode,
};

/// Keeps the bootstrap a pass announces.
struct Capture(Option<QuickMetadataBootstrap>);

impl ProcessingSink for Capture {
    fn on_bootstrap(&mut self, bootstrap: &QuickMetadataBootstrap) {
        self.0 = Some(bootstrap.clone());
    }
}

/// The default streaming pass over `content` with the bootstrap on, and the
/// bootstrap it emitted.
pub fn run_with_bootstrap(content: &[u8]) -> (ProcessingResult, QuickMetadataBootstrap) {
    let request = ProcessingRequest::default()
        .features(Features::default().quick_metadata_bootstrap(true));
    let mut capture = Capture(None);
    let result = process(content, &request, &mut capture);
    let bootstrap = capture.0.expect("quick metadata bootstrap was requested");
    (result, bootstrap)
}

/// The quick-metadata bootstrap `ifc` produces.
pub fn bootstrap(ifc: &str) -> QuickMetadataBootstrap {
    run_with_bootstrap(ifc.as_bytes()).1
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
