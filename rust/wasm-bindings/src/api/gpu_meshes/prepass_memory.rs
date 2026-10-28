// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::EntityIndex;

/// A metadata decoder needs the scanned entries, not their unused reservation.
/// HashMap::clone preserves capacity: the streaming scan's len/50 reservation
/// can be 832 MiB on wasm32 even when only 50 jobs have been discovered (#8259).
/// Size the new table for live rows; last-record-wins spans are unchanged.
pub(super) fn snapshot_entity_index(index: &EntityIndex) -> EntityIndex {
    index.iter().map(|(&id, &span)| (id, span)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ifc_lite_core::{ColumnarEntityIndex, EntityScanner};

    #[test]
    fn issue_8259_metadata_snapshot_does_not_clone_unused_scan_capacity() {
        let source = b"DATA;#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCDIRECTION((1.,0.,0.));#1=IFCCARTESIANPOINT((2.,0.,0.));ENDSEC;";
        let mut index = EntityIndex::with_capacity_and_hasher(100_000, Default::default());
        let mut scanner = EntityScanner::new(source);
        while let Some((id, _, start, end)) = scanner.next_entity() {
            index.insert(id, (start, end));
        }
        let snapshot = snapshot_entity_index(&index);
        assert!(index.capacity() >= 100_000);
        assert!(snapshot.capacity() < 16, "snapshot must scale with populated rows");
        // Pin the actual exported index bytes, including duplicate-id precedence.
        let before = ColumnarEntityIndex::from_hashmap_consuming(index).unwrap();
        let after = ColumnarEntityIndex::from_hashmap_consuming(snapshot).unwrap();
        assert_eq!(before.ids(), &[1, 2]);
        assert_eq!(before.ids(), after.ids());
        assert_eq!(before.starts(), after.starts());
        assert_eq!(before.lengths(), after.lengths());
        let last = source.windows(4).rposition(|s| s == b"#1=I").unwrap();
        assert_eq!(after.starts()[0] as usize, last);
    }
}
