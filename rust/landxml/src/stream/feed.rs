/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::{cell::RefCell, io::Read, rc::Rc};

/// A one-token feed lets quick-xml retain its authoritative element stack
/// without treating a source-chunk cut as terminal EOF.
#[derive(Clone)]
pub(super) struct TokenFeed(Rc<RefCell<Feed>>);

#[derive(Default)]
struct Feed {
    bytes: Vec<u8>,
    read: usize,
}

impl TokenFeed {
    pub(super) fn new() -> Self {
        Self(Rc::new(RefCell::new(Feed::default())))
    }

    pub(super) fn push(&self, bytes: &[u8]) {
        let mut feed = self.0.borrow_mut();
        if feed.read == feed.bytes.len() {
            feed.bytes.clear();
            feed.read = 0;
        }
        feed.bytes.extend_from_slice(bytes);
    }
}

impl Read for TokenFeed {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let mut feed = self.0.borrow_mut();
        let length = output.len().min(feed.bytes.len() - feed.read);
        output[..length].copy_from_slice(&feed.bytes[feed.read..feed.read + length]);
        feed.read += length;
        Ok(length)
    }
}
