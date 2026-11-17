// SPDX-License-Identifier: MPL-2.0
//! The held DATA section every STEP writer adapts with
//! [`place_each_object_once`] when its output is IFC2X3 (#9209).

use std::io::{self, Write};

use crate::schema_ifc2x3_placements::place_each_object_once;

/// The DATA section of an IFC2X3 output, held until its last record so
/// [`place_each_object_once`] sees all of them; any other output passes
/// straight through. The streaming writers trade their constant memory for
/// the section's size here, and only when the output is IFC2X3.
/// Not generic over the writer, so each STEP writer shares one copy.
pub(crate) struct Body<'w> {
    out: &'w mut dyn Write,
    held: Option<Vec<u8>>,
}

impl<'w> Body<'w> {
    pub(crate) fn new(out: &'w mut dyn Write, ifc2x3: bool) -> Self {
        Body { out, held: ifc2x3.then(Vec::new) }
    }

    /// Write the held section, adapted; the change in record count.
    pub(crate) fn finish(self) -> io::Result<isize> {
        let Some(held) = self.held else { return Ok(0) };
        let placed = match std::str::from_utf8(&held) {
            Ok(text) => place_each_object_once(text).map(|p| (p.body.into_bytes(), p.added, p.removed)),
            // Bytes that are not UTF-8 (a source's Latin-1 name, say) are read
            // one char per byte and written back the same way: what the pass
            // writes is ASCII or copied from them, so every char fits a byte.
            Err(_) => {
                let text: String = held.iter().map(|&b| char::from(b)).collect();
                place_each_object_once(&text).and_then(|p| {
                    let bytes = p.body.chars().map(|c| u8::try_from(u32::from(c)).ok()).collect::<Option<Vec<u8>>>()?;
                    Some((bytes, p.added, p.removed))
                })
            }
        };
        match placed {
            Some((bytes, added, removed)) => {
                self.out.write_all(&bytes)?;
                Ok(added as isize - removed as isize)
            }
            None => self.out.write_all(&held).map(|()| 0),
        }
    }
}

impl Write for Body<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match &mut self.held {
            Some(held) => held.write(buf),
            None => self.out.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}
