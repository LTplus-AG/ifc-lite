/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

pub(crate) enum Capture {
    Point {
        id: String,
        depth: usize,
        text: String,
    },
    Face {
        depth: usize,
        text: String,
        hidden: bool,
    },
    Polyline {
        depth: usize,
        text: String,
        category: PolylineCategory,
        name: Option<String>,
        kind: Option<String>,
    },
}

#[derive(Clone, Copy)]
pub(crate) enum PolylineCategory {
    Boundary,
    Breakline,
    Contour,
}

impl Capture {
    pub(crate) fn depth(&self) -> usize {
        match self {
            Self::Point { depth, .. } | Self::Face { depth, .. } | Self::Polyline { depth, .. } => *depth,
        }
    }
}
