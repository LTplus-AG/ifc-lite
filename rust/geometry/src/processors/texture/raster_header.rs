// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Bounded header inspection without allocating the encoded or decoded raster.
const MAX_HEADER_BYTES: usize = 1024 * 1024;

pub(super) fn dimensions(len: usize, byte: impl Fn(usize) -> Option<u8>) -> Option<(u32, u32)> {
    let limit = len.min(MAX_HEADER_BYTES);
    let get = |i: usize| (i < limit).then(|| byte(i)).flatten();
    let be16 = |i| Some(u16::from_be_bytes([get(i)?, get(i + 1)?]));
    let be32 = |i| {
        Some(u32::from_be_bytes([
            get(i)?,
            get(i + 1)?,
            get(i + 2)?,
            get(i + 3)?,
        ]))
    };
    if [137, 80, 78, 71, 13, 10, 26, 10]
        .iter()
        .enumerate()
        .all(|(i, &v)| get(i) == Some(v))
    {
        if be32(8)? != 13
            || [b'I', b'H', b'D', b'R']
                .iter()
                .enumerate()
                .any(|(i, &v)| get(i + 12) != Some(v))
        {
            return None;
        }
        let (width, height) = (be32(16)?, be32(20)?);
        return (width > 0 && height > 0).then_some((width, height));
    }
    if get(0)? != 0xff || get(1)? != 0xd8 {
        return None;
    }
    let mut cursor = 2;
    while cursor < limit {
        if get(cursor)? != 0xff {
            return None;
        }
        while get(cursor)? == 0xff {
            cursor += 1;
        }
        let marker = get(cursor)?;
        cursor += 1;
        if matches!(marker, 0xda | 0xd9 | 0x00) {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = usize::from(be16(cursor)?);
        if length < 2 || cursor.checked_add(length)? > limit {
            return None;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            if length < 8 {
                return None;
            }
            let (width, height) = (u32::from(be16(cursor + 5)?), u32::from(be16(cursor + 3)?));
            return (width > 0 && height > 0).then_some((width, height));
        }
        cursor += length;
    }
    None
}
