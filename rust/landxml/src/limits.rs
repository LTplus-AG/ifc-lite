/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::sync::atomic::{AtomicBool, Ordering};

/// Cooperative cancellation hook for hosts that run ingestion off-thread.
pub trait LandXmlCancellation: Send + Sync {
    fn is_cancelled(&self) -> bool;
}

/// Share this flag with a native task and call [`Self::cancel`] from its host.
#[derive(Default)]
pub struct LandXmlCancellationFlag {
    cancelled: AtomicBool,
}

impl LandXmlCancellationFlag {
    pub const fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
        }
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    pub fn reset(&self) {
        self.cancelled.store(false, Ordering::Release);
    }
}

impl LandXmlCancellation for LandXmlCancellationFlag {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

/// Hard limits applied before semantic allocations grow with untrusted input.
#[derive(Clone, Debug)]
pub struct LandXmlLimits {
    pub max_bytes: usize,
    pub max_depth: usize,
    pub max_name_bytes: usize,
    pub max_attributes: usize,
    pub max_attribute_bytes: usize,
    pub max_text_bytes: usize,
    /// Maximum predefined or numeric XML character references after DTD refusal.
    pub max_character_references: usize,
    /// Maximum LandXML `Surface` records, including non-TIN surfaces we skip.
    pub max_surfaces: usize,
    /// Maximum preserved roots from foreign XML namespaces.
    pub max_extensions: usize,
    /// Maximum point records across the whole source document.
    pub max_points: usize,
    /// Maximum visible face records across the whole source document.
    pub max_faces: usize,
    pub max_references: usize,
    pub max_work: usize,
}

impl Default for LandXmlLimits {
    fn default() -> Self {
        Self {
            max_bytes: 64 * 1024 * 1024,
            max_depth: 64,
            max_name_bytes: 256,
            max_attributes: 64,
            max_attribute_bytes: 4096,
            max_text_bytes: 1024 * 1024,
            max_character_references: 100_000,
            max_surfaces: 100_000,
            max_extensions: 100_000,
            max_points: 5_000_000,
            max_faces: 10_000_000,
            max_references: 30_000_000,
            max_work: 100_000_000,
        }
    }
}
