// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F2 (#8341): the type records a [`TypeGeometryPlan`] omits because the full
//! decoder rejects them.
//!
//! The scan-time reader accepts records the full decoder does not (an
//! `INVALID` token in an unrelated attribute still leaves RepresentationMaps
//! readable). Such a record can never be meshed, so both planners drop it
//! before scheduling a job and report its express id.
//!
//! The contract both pipelines publish: an omitted type record is a distinct
//! type product whose plan, in the plan's own [`TypeGeometryMode`](crate::element::TypeGeometryMode),
//! had at least one RepresentationMap to draw, and whose own record failed the
//! full decode. That is always a plain syntax/decode failure, never an S6a
//! admission refusal: candidates are `IfcTypeProduct` subtypes, which real
//! admission exempts as `IfcObjectDefinition`s, and malformed-leaf refusal
//! covers only points and directions. So the count never overlaps
//! `refused_input_elements` or `refused_prepass_records`, and reading these
//! records records no refusal on a strict decoder.
use super::{record_refs_at, TypeGeometryPlan};
use ifc_lite_core::{EntityDecoder, IfcType};

fn distinct(mut ids: Vec<u32>) -> Vec<u32> {
    ids.sort_unstable();
    ids.dedup();
    ids
}

impl TypeGeometryPlan {
    /// [`Self::decode_products`], returning the distinct ids (ascending) of the
    /// candidates it omitted under the module contract. Candidates without a
    /// map to draw in this mode are skipped silently, as before: nothing is lost.
    pub fn decode_products_reporting(
        &mut self,
        content: &[u8],
        candidates: &[(u32, usize, usize, IfcType)],
        decoder: &mut EntityDecoder,
    ) -> Vec<u32> {
        let mut omitted = Vec::new();
        for (id, start, end, ty) in candidates {
            let decoded = decoder.decode_at_with_id(*id, *start, *end);
            let authored = record_refs_at(
                content.get(*start..*end).unwrap_or_default(),
                ifc_lite_core::slot::IfcTypeProduct::REPRESENTATION_MAPS.index(),
            );
            if authored.is_empty() {
                continue;
            }
            let maps = self.maps_for(*id, &authored);
            match decoded {
                Ok(_) => self.products.push((*id, *start, *end, ty.clone(), maps)),
                Err(_) if !maps.is_empty() => omitted.push(*id),
                Err(_) => {}
            }
        }
        distinct(omitted)
    }

    /// The native twin for a plan built from scan-time spans
    /// ([`Self::from_scan`]): drop every product with planned maps whose record
    /// the full decoder rejects, and return their distinct ids (ascending).
    /// The read is uncached; `decoder` needs only the source bytes.
    pub fn retain_decodable_products(&mut self, decoder: &EntityDecoder) -> Vec<u32> {
        let mut omitted = Vec::new();
        self.products.retain(|(id, start, end, _, maps)| {
            let keep = maps.is_empty() || decoder.decode_at_uncached(*start, *end).is_ok();
            if !keep {
                omitted.push(*id);
            }
            keep
        });
        distinct(omitted)
    }
}
