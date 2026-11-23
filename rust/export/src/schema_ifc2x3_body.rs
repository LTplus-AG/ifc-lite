// SPDX-License-Identifier: MPL-2.0
//! DATA section assembly for IFC2X3 output and conversions that need file-wide references.

use std::io::{self, Write};

use crate::schema_ifc2x3_placements::place_each_object_once;

/// Holds DATA for IFC2X3 placements or a conversion that rewrites the emitted records. Other exports stream directly.
pub(crate) struct Body<'w> {
    out: &'w mut dyn Write,
    held: Option<Vec<u8>>,
    ifc2x3: bool,
}

impl<'w> Body<'w> {
    pub(crate) fn new(out: &'w mut dyn Write, ifc2x3: bool) -> Self {
        Self::for_conversion(out, ifc2x3, false)
    }

    pub(crate) fn for_conversion(out: &'w mut dyn Write, ifc2x3: bool, deferred: bool) -> Self {
        Body { out, held: (ifc2x3 || deferred).then(Vec::new), ifc2x3 }
    }

    pub(crate) fn finish(self) -> io::Result<isize> {
        self.finish_with_header(|_| None, |_, _| Ok(()))
    }

    /// Apply a byte-preserving pass before adaptations that read the DATA as text.
    pub(crate) fn rewrite_held(&mut self, rewrite: impl FnOnce(&[u8]) -> Option<(Vec<u8>, usize)>) -> usize {
        let Some(held) = self.held.as_mut() else { return 0 };
        let Some((rewritten, added)) = rewrite(held) else { return 0 };
        *held = rewritten;
        added
    }

    /// Adapt a held section, then write its header with the final delta before writing DATA.
    pub(crate) fn finish_with_header(
        self,
        deferred: impl FnOnce(&str) -> Option<(String, isize)>,
        header: impl FnOnce(&mut dyn Write, isize) -> io::Result<()>,
    ) -> io::Result<isize> {
        let Some(held) = self.held else { return Ok(0) };
        let adapt = |text: &str| {
            let rewritten = deferred(text);
            let source = rewritten.as_ref().map_or(text, |(s, _)| s.as_str());
            if let Some(placed) = self.ifc2x3.then(|| place_each_object_once(source)).flatten() {
                let delta = rewritten.as_ref().map_or(0, |(_, n)| *n) + placed.added as isize - placed.removed as isize;
                Some((placed.body, delta))
            } else {
                rewritten
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
        let (bytes, count) = adapted.unwrap_or((held, 0));
        header(self.out, count)?;
        self.out.write_all(&bytes)?;
        Ok(count)
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
