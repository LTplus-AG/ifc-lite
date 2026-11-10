// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fast STEP list decoding into caller-owned scratch (#3988). The owned-return
//! accessors use the same fill routines; only scratch ownership differs.

use super::{parse_cartesian_point_inline, EntityDecoder};
use crate::parser::StepRecord;

impl EntityDecoder<'_> {
    /// Extract entity reference IDs from a raw list attribute, in authored order.
    #[inline]
    pub fn get_entity_ref_list_fast(&mut self, entity_id: u32) -> Option<Vec<u32>> {
        let mut ids = Vec::new();
        self.get_entity_ref_list_fast_into(entity_id, &mut ids)?;
        Some(ids)
    }

    /// Replace `ids` with the same list as [`Self::get_entity_ref_list_fast`],
    /// reusing its allocation. Duplicates retain authored order. An item that
    /// is not exactly one reference (an id above `u32::MAX` included) refuses
    /// the whole list: a shell with a face dropped is an open shell, not a
    /// smaller one (D3). On `None`, `ids` is empty. The caller owns the scratch lifetime.
    #[inline]
    pub fn get_entity_ref_list_fast_into(&mut self, entity_id: u32, ids: &mut Vec<u32>) -> Option<()> {
        // Pattern: IFCTYPE((#id1,#id2,...)); or IFCTYPE((#id1,#id2,...),other);
        ids.clear();
        ids.reserve(32);
        StepRecord::parse(self.get_raw_bytes(entity_id)?)?.ref_list_at(0, ids)?;
        if ids.is_empty() {
            None
        } else {
            Some(())
        }
    }

    /// Extract PolyLoop coordinates with the decoder's existing point cache.
    #[inline]
    pub fn get_polyloop_coords_cached(&mut self, entity_id: u32) -> Option<Vec<(f64, f64, f64)>> {
        let mut coords = Vec::new();
        self.get_polyloop_coords_cached_into(entity_id, &mut coords)?;
        Some(coords)
    }

    /// Replace `coords` with [`Self::get_polyloop_coords_cached`]'s ordered result,
    /// reusing its allocation and the same point-cache policy and counters.
    /// Missing/oversized point refs invalidate the whole loop. On `None`, the
    /// buffer is empty; resolved points remain cached, as with the owned accessor.
    #[inline]
    pub fn get_polyloop_coords_cached_into(
        &mut self, entity_id: u32, coords: &mut Vec<(f64, f64, f64)>,
    ) -> Option<()> {
        coords.clear();
        // Builds the index once and refuses a span outside the content (#4697).
        let bytes = self.get_raw_bytes(entity_id)?;
        let index = self.entity_index.as_ref()?;
        let bytes_full = self.content;

        // IFCPOLYLOOP((#id1,#id2,#id3,...)); every item must be one reference
        // that names a point, or the whole loop is refused.
        coords.reserve(8);
        let point_cache = &mut self.point_cache;
        let (hits, misses) = (&mut self.point_cache_hits, &mut self.point_cache_misses);
        let read = StepRecord::parse(bytes)?.try_each_ref_at(0, |point_id| {
            if let Some(&coord) = point_cache.get(&point_id) {
                *hits += 1;
                coords.push(coord);
                return true;
            }
            // Not in cache - parse and cache; a point that does not resolve
            // invalidates the whole polygon.
            let Some(coord) = index
                .lookup(point_id)
                .and_then(|(start, end)| bytes_full.get(start..end))
                .and_then(parse_cartesian_point_inline)
            else {
                return false;
            };
            *misses += 1;
            point_cache.insert(point_id, coord);
            coords.push(coord);
            true
        });
        if read.is_some() && coords.len() >= 3 {
            Some(())
        } else {
            coords.clear();
            None
        }
    }
}

impl EntityDecoder<'_> {
    /// Why a polyloop's fast read failed, when the reason is input admission
    /// (#7678): the counted refusal for the first point that holds a REAL `f64`
    /// cannot represent (`1.E400`), in either decoder mode. `None` when no
    /// point does, so a caller keeps its own policy for a genuinely corrupt
    /// loop. Lets a reader that skips an unreadable loop fail the whole item
    /// instead of silently opening a closed shell.
    pub fn polyloop_refusal(&mut self, loop_id: u32) -> Option<crate::Error> {
        for point_id in self.get_polyloop_point_ids_fast(loop_id)? {
            let Ok(point) = self.decode_by_id_lossless(point_id) else { continue };
            let holds_overflow = point.get(0).and_then(|a| a.as_list()).is_some_and(|coords| {
                coords.iter().any(|v| v.as_float().is_some_and(|f| !f.is_finite()))
            });
            if holds_overflow {
                return Some(self.refuse_record(point_id));
            }
        }
        None
    }

    /// Whether [`Self::decode_by_id`] would read `id` as a plain `IfcFace`,
    /// proven from its bytes without decoding it: the record is exactly
    /// `#n=IFCFACE((#a,#b,...));`, STEP whitespace allowed between tokens, the
    /// keyword upper case, every name a `u32` express id. The decode reads every
    /// such record as an `IfcFace` holding one reference list and cannot refuse
    /// it (no literal the tokenizer rejects, no REAL for strict admission), so a
    /// caller that decodes a face only to learn whether it is an
    /// `IfcAdvancedFace` may skip that decode on `true`. The skipped decode would
    /// only have filled the entity memo. `false` for anything else (a comment,
    /// another keyword or spelling, an empty list) and for an id this decoder
    /// already holds decoded, whose memo the decode would have returned: those
    /// decode as before.
    pub fn is_plain_face(&mut self, id: u32) -> bool {
        !self.cache.contains_key(&id) && self.get_raw_bytes(id).is_some_and(is_plain_face_record)
    }
}

/// `#n = IFCFACE ( ( #a , ... ) ) ;` and nothing else up to the `;`, which is
/// where the tokenizer stops reading too. See [`EntityDecoder::is_plain_face`].
fn is_plain_face_record(record: &[u8]) -> bool {
    let mut at = 0;
    // `token` after optional STEP whitespace (a subset of the tokenizer's trivia).
    let eat = |at: &mut usize, token: &[u8]| {
        while record.get(*at).copied().is_some_and(crate::parser::is_step_space) {
            *at += 1;
        }
        let found = record[*at..].starts_with(token);
        *at += if found { token.len() } else { 0 };
        found
    };
    // `#digits` with no space inside, as the tokenizer's `entity_ref` reads it.
    let name = |at: &mut usize| {
        if !eat(at, b"#") {
            return false;
        }
        let digits = record[*at..].iter().take_while(|b| b.is_ascii_digit()).count();
        let id = (digits > 0).then(|| crate::express_id::parse_express_id(&record[*at..*at + digits]));
        *at += digits;
        id.flatten().is_some()
    };
    if !(name(&mut at) && eat(&mut at, b"=") && eat(&mut at, b"IFCFACE")) {
        return false;
    }
    // A longer keyword (`IFCFACESURFACE`, `IFCFACE_X`) is another entity.
    if record.get(at).is_some_and(|&b| b.is_ascii_alphanumeric() || b == b'_') {
        return false;
    }
    if !(eat(&mut at, b"(") && eat(&mut at, b"(") && name(&mut at)) {
        return false;
    }
    while eat(&mut at, b",") {
        if !name(&mut at) {
            return false;
        }
    }
    eat(&mut at, b")") && eat(&mut at, b")") && eat(&mut at, b";")
}

/// The byte proof's own tests live with it: they name `is_plain_face`, so a
/// whole-file revert of this module removes them together. What the proof
/// buys (no face decode in surface-model lowering) is observed from
/// `ifc-lite-geometry`'s `surface_model_plan` tests through the entity memo.
#[cfg(test)]
mod plain_face_tests {
    use super::EntityDecoder;

    /// The byte proof behind skipping a face decode: every record it accepts
    /// decodes, uncached, to an `IfcFace`; every variant it refuses still decodes
    /// (or fails) exactly as before because the caller then decodes it.
    /// Independent review (#9632): with a supplied index that maps a requested
    /// id onto a record DECLARING another id, `decode_by_id` answers from the
    /// memo of the declared id (`decode_at`). The proof must never disagree:
    /// here `#2` is memoised as an `IfcAdvancedFace` while id 9 is indexed onto
    /// a plain-looking `#2=IFCFACE((#10));` record.
    #[test]
    fn plain_face_proof_must_preserve_parsed_id_cache_precedence() {
        let source = "#2=IFCADVANCEDFACE((#10),#99,.T.);#2=IFCFACE((#10));";
        let split = source.find(';').unwrap() + 1;
        let mut decoder = EntityDecoder::new(source);
        decoder.decode_at(0, split).unwrap();
        let mut index = crate::EntityIndex::default();
        index.insert(9, (split, source.len()));
        decoder.set_entity_index(std::sync::Arc::new(index));
        assert!(decoder.get_cached(9).is_none());
        assert!(!decoder.is_plain_face(9), "the proof must defer to the declared id's memo");
        assert_eq!(decoder.decode_by_id(9).unwrap().ifc_type, crate::IfcType::IfcAdvancedFace);
    }

    #[test]
    fn plain_face_proof_accepts_only_records_the_decode_reads_as_ifc_face() {
        let accepted = [
            "#1=IFCFACE((#10));",
            "#2=IFCFACE((#10,#11,#12));",
            "#3= IFCFACE((#10,#11));",
            "#4 =\tIFCFACE ( ( #10 , #11 ) ) ;",
            "#5=IFCFACE((#10,#11))\r\n;",
            "#6=IFCFACE((#4294967295));",
            "#7=IFCFACE((#0010));",
        ];
        let refused = [
            "#20=IFCFACE(());",
            "#21=IFCFACE($);",
            "#22=IFCFACE((#10),$);",
            "#23=IFCFACE((#10,));",
            "#24=IFCFACE((# 10));",
            "#25=IFCFACE((#4294967296));",
            "#26=IFCFACE((#10/* c */));",
            "#27=ifcface((#10));",
            "#28=IFCFACESURFACE((#10),#11,.T.);",
            "#29=IFCADVANCEDFACE((#10),#11,.T.);",
            "#30=IFCFACE((#10,#11.5));",
            "#31=IFCFACE((#10)));",
            "#32=IFCFACE((#10))",
            "#33=IFCFACE((#10a));",
            "#34=IFCFACE (#10);",
            "#35=IFCFACE_X((#10));",
        ];
        let source: String = accepted.iter().chain(&refused).map(|r| format!("{r}\n")).collect();
        for (record, expected) in accepted.iter().map(|r| (r, true)).chain(refused.iter().map(|r| (r, false))) {
            let id: u32 = record[1..].split(|c: char| !c.is_ascii_digit()).next().unwrap().parse().unwrap();
            let mut decoder = EntityDecoder::new(&source);
            assert_eq!(decoder.is_plain_face(id), expected, "{record}");
            if expected {
                let face = decoder.decode_by_id(id).unwrap_or_else(|e| panic!("{record}: {e}"));
                assert_eq!(face.ifc_type, crate::IfcType::IfcFace, "{record}");
                // A decoded (memoized) id is the decode's to answer.
                assert!(!decoder.is_plain_face(id), "{record}");
            }
        }
    }
}

#[cfg(test)]
#[path = "fast_buffers_tests.rs"]
mod tests;
