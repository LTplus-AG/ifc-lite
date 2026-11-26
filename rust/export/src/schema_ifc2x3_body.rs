// SPDX-License-Identifier: MPL-2.0
//! DATA section assembly for IFC2X3 output and conversions that need file-wide references.

use std::collections::HashSet;
use std::io::{self, Write};

use crate::schema_ifc2x3_placements::place_each_object_once;
use crate::schema_unrooted_upgrade::Upgrade;

/// Holds DATA for IFC2X3 placements or a conversion that rewrites the emitted records. Other exports stream directly.
pub(crate) struct Body<'w> {
    out: &'w mut dyn Write,
    held: Option<Vec<u8>>,
    ifc2x3: bool,
    prune_upgrade: Option<Upgrade>,
    omitted: HashSet<u32>,
}

impl<'w> Body<'w> {
    pub(crate) fn new(out: &'w mut dyn Write, ifc2x3: bool) -> Self {
        Self::for_conversion(out, ifc2x3, false, None)
    }

    pub(crate) fn for_conversion(out: &'w mut dyn Write, ifc2x3: bool, deferred: bool, prune_upgrade: Option<Upgrade>) -> Self {
        Body { out, held: (ifc2x3 || deferred || prune_upgrade.is_some()).then(Vec::new), ifc2x3, prune_upgrade, omitted: HashSet::new() }
    }

    /// Keep omitted IDs for the final dependency pass, even when their lines were never written.
    pub(crate) fn note_omitted(&mut self, id: u32) {
        if self.prune_upgrade.is_some() { self.omitted.insert(id); }
    }

    pub(crate) fn finish(self) -> io::Result<isize> {
        self.finish_with_header(|_| None, |_, _| Ok(()), &mut Vec::new())
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
        header: impl FnOnce(&mut dyn Write, &HashSet<u32>) -> io::Result<()>,
        warnings: &mut Vec<String>,
    ) -> io::Result<isize> {
        let Some(held) = self.held else { return Ok(0) };
        let adapt = |text: &str| {
            let rewritten = deferred(text);
            let source = rewritten.as_ref().map_or(text, |(s, _)| s.as_str());
            let added = rewritten.as_ref().map_or(0, |(_, n)| *n);
            if let Some(upgrade) = self.prune_upgrade {
                if let Some((pruned, omitted, losses)) = upgrade.prune(source, self.omitted) {
                    let removed = losses.len() as isize;
                    warnings.extend(losses);
                    return Some((pruned, added - removed, omitted));
                }
            }
            if let Some(placed) = self.ifc2x3.then(|| place_each_object_once(source)).flatten() {
                let delta = added + placed.added as isize - placed.removed as isize;
                Some((placed.body, delta, HashSet::new()))
            } else {
                rewritten.map(|(body, delta)| (body, delta, HashSet::new()))
            }
        };
        let adapted = match std::str::from_utf8(&held) {
            Ok(text) => adapt(text).map(|(text, count, added)| (text.into_bytes(), count, added)),
            // Preserve preexisting single-byte encodings, as the rewrites add ASCII only.
            Err(_) => {
                let text: String = held.iter().map(|&b| char::from(b)).collect();
                adapt(&text).and_then(|(text, count, added)| {
                    let bytes = text.chars().map(|c| u8::try_from(u32::from(c)).ok()).collect::<Option<Vec<u8>>>()?;
                    Some((bytes, count, added))
                })
            }
        };
        let (bytes, count, omitted) = adapted.unwrap_or_else(|| (held, 0, HashSet::new()));
        header(self.out, &omitted)?;
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
