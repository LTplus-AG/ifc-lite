// SPDX-License-Identifier: MPL-2.0
//! Verified suffix reuse for consumers inspecting many products (#7779 E1).

use super::chain_walk::{climb, Climb};
use super::validate::check_frames;
use super::{unsupported, ChainPolicy, Link, PlacementResult};
use ifc_lite_core::{execution_owner::ExecutionIdentity, EntityDecoder};
use rustc_hash::FxHashMap;
use smallvec::SmallVec;

/// A validation session tied to ONE immutable decoder source and ONE policy.
/// A transform-cache entry alone never proves that a consumer's policy holds.
/// Only whole successful chains enter this session's private verified suffixes;
/// failures remain uncached and cycles still use the canonical visited walk.
/// Drop the session before changing policy or moving to another decoder.
pub struct ChainValidator<'decoder, 'source> {
    decoder: &'decoder mut EntityDecoder<'source>,
    policy: ChainPolicy,
    identity: ExecutionIdentity,
    verified: FxHashMap<u32, u32>,
}

impl<'decoder, 'source> ChainValidator<'decoder, 'source> {
    pub fn new(decoder: &'decoder mut EntityDecoder<'source>, policy: ChainPolicy) -> Self {
        let identity = decoder.execution_identity();
        Self {
            decoder,
            policy,
            identity,
            verified: FxHashMap::default(),
        }
    }

    /// Access the same decoder for consumer-specific checks and output work.
    /// Replacing the decoder or its explicit configuration invalidates verified
    /// suffixes at the next validation. Lazy memo population preserves them.
    pub fn decoder(&mut self) -> &mut EntityDecoder<'source> {
        self.decoder
    }

    /// Return `(root, newly_verified_links)`, links leaf first. An already
    /// verified starting id returns its root and no new links. At each ancestor
    /// a known suffix stops the walk, so a parent-before-child ladder costs one
    /// new link per product rather than 1+2+...+N links. No chain depth cap.
    pub fn validate(&mut self, id: u32) -> PlacementResult<(u32, SmallVec<[Link; 8]>)> {
        let identity = self.decoder.execution_identity();
        if identity != self.identity {
            self.verified.clear();
            self.identity = identity;
        }
        if let Some(root) = self.verified.get(&id) {
            return Ok((*root, SmallVec::new()));
        }
        let start = self.decoder.decode_by_id(id)?;
        let mut climbed = Climb::new();
        climb(
            &mut climbed,
            &start,
            self.decoder,
            false,
            false,
            Some(&self.verified),
        )?;
        if let Some((at, found)) = climbed.stopped_at {
            return Err(unsupported(self.decoder, at, found));
        }
        check_frames(&climbed.frames, self.decoder, &self.policy)?;
        // A fresh start either contributes a frame or encounters a verified id.
        let root = climbed.verified_root.unwrap_or_else(|| {
            climbed
                .frames
                .last()
                .expect("nonempty placement chain")
                .entity
                .id
        });
        let links: SmallVec<[Link; 8]> = climbed
            .frames
            .iter()
            .map(|frame| Link {
                id: frame.entity.id,
                kind: frame.kind,
            })
            .collect();
        for link in &links {
            self.verified.insert(link.id, root);
        }
        Ok((root, links))
    }
}
