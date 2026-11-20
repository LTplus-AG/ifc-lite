// SPDX-License-Identifier: MPL-2.0
//! DATA section assembly for IFC2X3 output and conversions whose dates need file-wide references.

use std::io::{self, Write};

use crate::schema_ifc2x3_placements::place_each_object_once;

/// Holds DATA for IFC2X3 placements and styles, or to resolve legacy date
/// references when upgrading an IFC2X3 file. Other exports stream directly.
pub(crate) struct Body<'w> {
    out: &'w mut dyn Write,
    held: Option<Vec<u8>>,
    ifc2x3: bool,
}

impl<'w> Body<'w> {
    pub(crate) fn new(out: &'w mut dyn Write, ifc2x3: bool) -> Self {
        Self::for_conversion(out, ifc2x3, false)
    }

    pub(crate) fn for_conversion(out: &'w mut dyn Write, ifc2x3: bool, defer_dates: bool) -> Self {
        Body { out, held: (ifc2x3 || defer_dates).then(Vec::new), ifc2x3 }
    }

    pub(crate) fn finish(self) -> io::Result<isize> {
        self.finish_with(|_| None)
    }

    /// Write the held section with synthesized date records and adapted IFC2X3 placements.
    pub(crate) fn finish_with(self, dates: impl FnOnce(&str) -> Option<(String, isize)>) -> io::Result<isize> {
        let Some(held) = self.held else { return Ok(0) };
        let adapt = |text: &str| {
            let dated = dates(text);
            let source = dated.as_ref().map_or(text, |(s, _)| s.as_str());
            if let Some(placed) = self.ifc2x3.then(|| place_each_object_once(source)).flatten() {
                let delta = dated.as_ref().map_or(0, |(_, n)| *n) + placed.added as isize - placed.removed as isize;
                Some((placed.body, delta))
            } else {
                dated
            }
        };
        let adapted = match std::str::from_utf8(&held) {
            Ok(text) => adapt(text).map(|(text, count)| (text.into_bytes(), count)),
            // Preserve preexisting single-byte encodings, as the rewrites add ASCII only.
            Err(_) => {
                let text: String = held.iter().map(|&b| char::from(b)).collect();
                adapt(&text).and_then(|(text, count)| {
                    let bytes = text.chars().map(|c| u8::try_from(u32::from(c)).ok()).collect::<Option<Vec<u8>>>()?;
                    Some((bytes, count))
                })
            }
        };
        match adapted {
            Some((bytes, count)) => {
                self.out.write_all(&bytes)?;
                Ok(count)
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
