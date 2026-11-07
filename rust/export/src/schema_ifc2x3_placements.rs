// SPDX-License-Identifier: MPL-2.0
//! The grid and shared placements of an IFC2X3 output each place exactly one
//! product (#9209).
//!
//! IFC2X3 declares `IfcObjectPlacement.PlacesObject` as `SET [1:1]`; IFC4
//! relaxed it to `SET [0:?]`, and the models ifc-lite writes use that: a column
//! on a grid is `IfcColumn` -> `IfcLocalPlacement` -> `IfcGridPlacement`, so the
//! grid placement places nothing, and a blank model's site and building share
//! one `IfcLocalPlacement`. So an IFC2X3 output is adapted after it is written:
//!
//! - A grid placement that places nothing, with one local child that only
//!   lifts it (no heading, no offset in plan), is folded: the child keeps its
//!   id and becomes the grid placement, its height carried as the
//!   intersection's third offset.
//! - Otherwise each local child is written as a plain `IfcLocalPlacement` in
//!   the owning grid's frame, at the position the grid placement resolves to,
//!   and the grid placement is not written. One whose intersection does not
//!   read is left as it was.
//! - A placement shared by several products gives each product after the
//!   first its own copy.
//!
//! New records take the ids after the highest one and are written after the
//! last record, in id order, the order a re-read file is written back in.
//!
//! A local placement that places nothing and only parents another one is a
//! source file's shape, under a grid or not; ifc-lite never writes it, and this
//! pass leaves it as it was. Under a grid placement it is still folded or freed
//! as above, which writes one placement that places nothing instead of two.
//!
//! Positions follow the geometry reader (`ifc_lite_geometry`'s
//! `placement/grid.rs`). Twin of `packages/export/src/schema-ifc2x3-placements.ts`,
//! pinned for both by `tests/fixtures/schema_grid_placement_vectors.json`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{self, Write};

use crate::schema_ifc2x3_records::{
    is_dollar, list, num, ref_id, triple, GridFrame, Records, GRID_PLACEMENT, INTERSECTION, LOCAL, OBJECT_PLACEMENT,
};
use crate::step_log::format_step_real;
use crate::step_record_frame::record_frame;
use crate::step_slot::slots_of;

/// The `#n` references in `text` from `from` on, outside string literals.
fn references(text: &str, from: usize) -> Vec<u32> {
    let b = text.as_bytes();
    let mut ids = Vec::new();
    let mut i = from;
    while i < b.len() {
        if b[i] == b'\'' {
            i += 1;
            while i < b.len() {
                if b[i] == b'\'' && b.get(i + 1) == Some(&b'\'') {
                    i += 2;
                } else if b[i] == b'\'' {
                    break;
                } else {
                    i += 1;
                }
            }
        } else if b[i] == b'#' {
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if let Ok(id) = text[i + 1..j].parse() {
                ids.push(id);
            }
            i = j - 1;
        }
        i += 1;
    }
    ids
}

/// Who names each placement and intersection.
#[derive(Default)]
struct Users {
    children: HashMap<u32, Vec<u32>>,
    products: HashMap<u32, Vec<u32>>,
    others: HashSet<u32>,
    crossings: HashMap<u32, usize>,
}

fn users(records: &Records) -> Users {
    let mut found = Users::default();
    let mut placements = HashSet::new();
    for rec in records.list.iter().flatten() {
        if rec.ty == LOCAL || rec.ty == GRID_PLACEMENT {
            placements.insert(rec.id);
        } else if rec.ty == INTERSECTION {
            found.crossings.insert(rec.id, 0);
        }
    }
    if placements.is_empty() {
        return found;
    }
    for rec in records.list.iter().flatten() {
        let mut hits = Vec::new();
        for id in references(rec.text, rec.open) {
            if placements.contains(&id) {
                hits.push(id);
            } else if let Some(n) = found.crossings.get_mut(&id) {
                *n += 1;
            }
        }
        if hits.is_empty() {
            continue;
        }
        let s = Records::slots(Some(rec));
        let mut seen = HashSet::new();
        for &id in &hits {
            if !seen.insert(id) {
                continue;
            }
            let once = hits.iter().filter(|h| **h == id).count() == 1;
            let slot = |i: usize| ref_id(s.as_ref().and_then(|s| s.get(i).copied()));
            if once && rec.ty == LOCAL && slot(0) == Some(id) {
                found.children.entry(id).or_default().push(rec.id);
            } else if once && rec.ty != LOCAL && rec.ty != GRID_PLACEMENT && slot(OBJECT_PLACEMENT) == Some(id) {
                found.products.entry(id).or_default().push(rec.id);
            } else {
                found.others.insert(id);
            }
        }
    }
    found
}

/// A child that only lifts its grid placement: the intersection's attributes
/// with the lift as its third offset (`None` inside for no lift). `None` when
/// the child turns, tilts or moves in plan, or anything does not read.
fn lift(records: &Records, kid: u32, g: &[&str]) -> Option<Option<String>> {
    let l = Records::slots(records.get(Some(kid), None))?;
    let a = Records::slots(records.get(ref_id(l.get(1).copied()), Some("IFCAXIS2PLACEMENT3D")))?;
    if l.len() != 2 || a.len() != 3 {
        return None;
    }
    let at = records.vector(Some(a[0]), "IFCCARTESIANPOINT")?;
    if at[0] != 0.0 || at[1] != 0.0 {
        return None;
    }
    let axis = if is_dollar(a[1]) { vec![0.0, 0.0, 1.0] } else { records.vector(Some(a[1]), "IFCDIRECTION")? };
    let reference = if is_dollar(a[2]) { vec![1.0, 0.0] } else { records.vector(Some(a[2]), "IFCDIRECTION")? };
    if axis.len() != 3 || axis[0] != 0.0 || axis[1] != 0.0 || !(axis[2] > 0.0) {
        return None;
    }
    if !(reference[0] > 0.0) || reference[1] != 0.0 {
        return None;
    }
    if !is_dollar(g[1]) && records.get(ref_id(Some(g[1])), Some(INTERSECTION)).is_none() {
        return None;
    }
    let i = Records::slots(records.get(ref_id(Some(g[0])), Some(INTERSECTION)))?;
    if i.len() != 2 || records.crossing(ref_id(Some(g[0]))).is_none() {
        return None;
    }
    let dz = at.get(2).copied().unwrap_or(0.0);
    if dz == 0.0 {
        return Some(None);
    }
    let offsets = if is_dollar(i[1]) { vec!["0.", "0."] } else { list(Some(i[1]))? };
    if offsets.len() != 2 && offsets.len() != 3 {
        return None;
    }
    let z = match offsets.get(2) {
        None => 0.0,
        Some(t) => num(t)?,
    } + dz;
    Some(Some(format!("{},({},{},{})", i[0].trim(), offsets[0].trim(), offsets[1].trim(), format_step_real(z))))
}

/// A child as a plain placement in its grid's frame: the records to write
/// before it, the last one its new `RelativePlacement`. `#{k}` names the k-th
/// of them. `None` when its relative placement does not read.
fn free(records: &Records, kid: u32, frame: &GridFrame) -> Option<Vec<String>> {
    let l = Records::slots(records.get(Some(kid), None))?;
    let a = Records::slots(records.get(ref_id(l.get(1).copied()), Some("IFCAXIS2PLACEMENT3D")))?;
    if l.len() != 2 || a.len() != 3 {
        return None;
    }
    let at = records.vector(Some(a[0]), "IFCCARTESIANPOINT")?;
    let axis_given = !is_dollar(a[1]);
    let ref_given = !is_dollar(a[2]);
    let axis = if axis_given { Some(records.vector(Some(a[1]), "IFCDIRECTION")?) } else { None };
    let reference = if ref_given { Some(records.vector(Some(a[2]), "IFCDIRECTION")?) } else { None };
    let [c, s] = frame.turn.unwrap_or([1.0, 0.0]);
    let turn = |v: &[f64]| -> [f64; 3] {
        let z = v.get(2).copied().unwrap_or(0.0);
        if frame.turn.is_some() {
            [c * v[0] - s * v[1], s * v[0] + c * v[1], z]
        } else {
            [v[0], v[1], z]
        }
    };
    let p = turn(&at);
    let mut lines =
        vec![format!("IFCCARTESIANPOINT({});", triple(&[frame.at[0] + p[0], frame.at[1] + p[1], frame.at[2] + p[2]]))];
    let mut slot = |given: bool, raw: &str, v: Option<&Vec<f64>>, fallback: Option<[f64; 3]>| -> String {
        if frame.turn.is_none() {
            return if given { raw.trim().to_string() } else { "$".to_string() };
        }
        let Some(turned) = v.map(|v| turn(v)).or(fallback) else { return "$".to_string() };
        if v.is_some_and(|v| turned[0] == v[0] && turned[1] == v[1]) {
            return raw.trim().to_string();
        }
        lines.push(format!("IFCDIRECTION({});", triple(&turned)));
        format!("#{{{}}}", lines.len() - 1)
    };
    let axis_slot = slot(axis_given, a[1], axis.as_ref(), None);
    let ref_slot = slot(ref_given, a[2], reference.as_ref(), Some([c, s, 0.0]));
    lines.push(format!("IFCAXIS2PLACEMENT3D(#{{0}},{axis_slot},{ref_slot});"));
    Some(lines)
}

/// An adapted DATA section: its text, and how many records it gained and lost.
pub(crate) struct Placed {
    pub(crate) body: String,
    pub(crate) added: usize,
    pub(crate) removed: usize,
}

/// The IFC2X3 records in `body` (each followed by its separator, anything
/// between them kept) with every object placement placing one product; `None`
/// when nothing changes. See the module comment.
#[inline(never)]
pub(crate) fn place_each_object_once(body: &str) -> Option<Placed> {
    let records = Records::scan(body);
    // A record adds at most four (a freed child's point, two directions and
    // axes); a file whose ids leave no room for them is left as it was.
    if u64::from(records.max_id) + 4 * records.list.len() as u64 >= u64::from(u32::MAX) {
        return None;
    }
    let Users { children, products, others, crossings } = users(&records);
    let mut rewrites: HashMap<u32, String> = HashMap::new();
    // New records, in id order: written after the last record, where a re-read writes them back.
    let mut added: Vec<String> = Vec::new();
    let mut drops: HashSet<u32> = HashSet::new();
    let mut next = records.max_id + 1;
    // A grid placement not written, and the intersections only it named.
    let drop = |drops: &mut HashSet<u32>, id: u32, g: &[&str]| {
        drops.insert(id);
        let named: Vec<Option<u32>> = g.iter().map(|t| ref_id(Some(t))).collect();
        for i in named.iter().flatten().collect::<BTreeSet<_>>() {
            if crossings.get(i).copied() == Some(named.iter().filter(|n| **n == Some(*i)).count()) {
                drops.insert(*i);
            }
        }
    };

    for rec in records.list.iter().flatten() {
        if rec.ty != GRID_PLACEMENT || others.contains(&rec.id) || products.contains_key(&rec.id) {
            continue;
        }
        let Some(g) = Records::slots(Some(rec)) else { continue };
        let kids = children.get(&rec.id).cloned().unwrap_or_default();
        if g.len() != 2 {
            continue;
        }
        if kids.is_empty() {
            drop(&mut drops, rec.id, &g);
            continue;
        }
        if let Some(lifted) = (kids.len() == 1).then(|| lift(&records, kids[0], &g)).flatten() {
            let at = ref_id(Some(g[0])).unwrap_or_default();
            let mut location = g[0].trim().to_string();
            match lifted {
                Some(attrs) if crossings.get(&at) == Some(&1) => {
                    rewrites.insert(at, format!("#{at}={INTERSECTION}({attrs});"));
                }
                Some(attrs) => {
                    added.push(format!("#{next}={INTERSECTION}({attrs});"));
                    location = format!("#{next}");
                    next += 1;
                }
                None => {}
            }
            rewrites.insert(kids[0], format!("#{}={GRID_PLACEMENT}({location},{});", kids[0], g[1].trim()));
            drops.insert(rec.id);
            continue;
        }
        let Some(frame) = records.grid_frame(&g) else { continue };
        let Some(freed) = kids.iter().map(|kid| free(&records, *kid, &frame)).collect::<Option<Vec<_>>>() else {
            continue;
        };
        let rel_to = records.grid_placement_of(ref_id(Some(g[0])));
        for (kid, written) in kids.iter().zip(freed) {
            let ids: Vec<u32> = written.iter().map(|_| { next += 1; next - 1 }).collect();
            for (k, line) in written.iter().enumerate() {
                let mut line = line.clone();
                for (j, id) in ids.iter().enumerate() {
                    line = line.replace(&format!("#{{{j}}}"), &format!("#{id}"));
                }
                added.push(format!("#{}={line}", ids[k]));
            }
            rewrites.insert(*kid, format!("#{kid}={LOCAL}({rel_to},#{});", ids[ids.len() - 1]));
        }
        drop(&mut drops, rec.id, &g);
    }

    for rec in records.list.iter().flatten() {
        let Some(placed) = products.get(&rec.id) else { continue };
        if placed.len() < 2 || drops.contains(&rec.id) {
            continue;
        }
        let own = rewrites.get(&rec.id).map_or(rec.text, String::as_str).to_string();
        let Some((ty, slots)) = record_frame(&own).and_then(|f| {
            Some((f.head.type_name(&own).to_ascii_uppercase(), slots_of(&own[f.head.open + 1..f.close])?.join(",")))
        }) else {
            continue;
        };
        for product in &placed[1..] {
            let text = records.get(Some(*product), None).map_or("", |r| r.text);
            let Some(frame) = record_frame(text) else { continue };
            let Some(mut parts) = slots_of(&text[frame.head.open + 1..frame.close]) else { continue };
            let copy = format!("#{next}");
            added.push(format!("{copy}={ty}({slots});"));
            next += 1;
            parts[OBJECT_PLACEMENT] = &copy;
            rewrites.insert(
                *product,
                format!("{}{}{}", &text[..=frame.head.open], parts.join(","), &text[frame.close..]),
            );
        }
    }

    if rewrites.is_empty() && drops.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(body.len() + 256 * (added.len() + 1));
    let mut cursor = 0;
    for rec in records.list.iter().flatten() {
        out.push_str(&body[cursor..rec.start]);
        cursor = rec.start + rec.text.len();
        if drops.contains(&rec.id) {
            // The record's separator goes with it.
            cursor += usize::from(body[cursor..].starts_with('\n'));
            continue;
        }
        out.push_str(rewrites.get(&rec.id).map_or(rec.text, String::as_str));
    }
    // After the last record and its separator.
    let tail = &body[cursor..];
    let at = usize::from(tail.starts_with('\n'));
    out.push_str(&tail[..at]);
    if !added.is_empty() && !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for line in &added {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(&tail[at..]);
    Some(Placed { body: out, added: added.len(), removed: drops.len() })
}

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

#[cfg(test)]
#[path = "schema_ifc2x3_placements_tests.rs"]
mod tests;
