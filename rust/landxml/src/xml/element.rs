/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! What the driver hands a family for one start tag (C9a-5, #7784).

use std::rc::Rc;

use super::{Attributes, Namespaces};

/// One open element, kept by the driver for the whole document.
#[derive(Clone)]
pub(crate) struct Frame {
    pub(crate) local: Rc<str>,
    /// Whether the element is in the document's own (root) namespace.
    pub(crate) target: bool,
    /// Prefix bindings in scope. Shared with the parent unless the element
    /// declares `xmlns*` itself (EDGE-LXPARSE-14).
    pub(crate) namespaces: Rc<Namespaces>,
}

/// A start tag, decoded once for every family.
pub(crate) struct Element<'e> {
    pub(crate) local: &'e str,
    pub(crate) namespace: Option<&'e str>,
    /// The namespace is the root's.
    pub(crate) target: bool,
    /// Open elements including this one.
    pub(crate) depth: usize,
    pub(crate) attributes: &'e Attributes,
}
