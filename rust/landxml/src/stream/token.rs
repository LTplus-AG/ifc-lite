/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::{cell::RefCell, collections::VecDeque, io::Read, rc::Rc};

pub(super) enum TokenKind {
    Text,
    Markup { quote: Option<u8> },
}

/// A one-token feed lets quick-xml retain its authoritative element stack
/// without treating a source-chunk cut as terminal EOF.
#[derive(Clone)]
pub(super) struct TokenFeed(Rc<RefCell<VecDeque<u8>>>);

impl TokenFeed {
    pub(super) fn new() -> Self {
        Self(Rc::new(RefCell::new(VecDeque::new())))
    }
    pub(super) fn push(&self, bytes: Vec<u8>) {
        self.0.borrow_mut().extend(bytes);
    }
}

impl Read for TokenFeed {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let mut bytes = self.0.borrow_mut();
        let length = output.len().min(bytes.len());
        for target in &mut output[..length] {
            *target = bytes.pop_front().expect("length bounded");
        }
        Ok(length)
    }
}
