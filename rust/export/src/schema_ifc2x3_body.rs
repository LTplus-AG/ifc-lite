// SPDX-License-Identifier: MPL-2.0
//! A STEP DATA section held for whole-file schema adaptation.

use std::io::{self, Write};

use crate::schema_ifc2x3_placements::place_each_object_once;

/// Hold the DATA section when a conversion needs to see the final record set:
/// placement adaptation in IFC2X3, or pruning obsolete resources and their
/// referrers on a qualifying IFC2X3 → IFC4 upgrade. Other exports stream.
pub(crate) struct Body<'w> {
    out: &'w mut dyn Write,
    held: Option<Vec<u8>>,
    prune_upgrade: bool,
}

impl<'w> Body<'w> {
    pub(crate) fn new(out: &'w mut dyn Write, ifc2x3: bool) -> Self {
        Self::for_conversion(out, ifc2x3, false)
    }

    pub(crate) fn for_conversion(out: &'w mut dyn Write, ifc2x3: bool, prune_upgrade: bool) -> Self {
        Body { out, held: (ifc2x3 || prune_upgrade).then(Vec::new), prune_upgrade }
    }

    pub(crate) fn finish(self) -> io::Result<isize> {
        self.finish_with_warnings(&mut Vec::new())
    }

    /// Write the held section, adapted; the change in record count.
    pub(crate) fn finish_with_warnings(self, warnings: &mut Vec<String>) -> io::Result<isize> {
        let Some(held) = self.held else { return Ok(0) };
        if self.prune_upgrade {
            use crate::schema_unrooted_upgrade::{prune, seeds};
            // The upgrading STEP and log writers serialize their records
            // as UTF-8. Other writers can still supply legacy single bytes.
            if let Ok(text) = std::str::from_utf8(&held) {
                if let Some((pruned, removed, losses)) = prune(text, &seeds(&held).collect()) {
                    self.out.write_all(pruned.as_bytes())?;
                    warnings.extend(losses);
                    return Ok(-(removed as isize));
                }
            }
            return self.out.write_all(&held).map(|()| 0);
        }
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
