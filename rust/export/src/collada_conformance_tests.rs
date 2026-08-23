// SPDX-License-Identifier: MPL-2.0
//! COLLADA 1.4.1 structural conformance for the `.dae` files `collada.rs` writes.
//!
//! Every existing test in `collada_tests.rs` asserts a SUBSTRING of the output
//! (`xml.contains("<up_axis>Z_UP</up_axis>")` and friends), or re-reads one
//! `float_array` with a helper written for that test. Nothing checks the
//! document's internal agreement, and there is no COLLADA reader anywhere in
//! this repository — so the whole class of defect where two numbers in the file
//! must match and do not was, until this file, unobservable:
//!
//!  * a `count=` attribute disagreeing with the data it introduces,
//!  * an `id`/`#reference` pair where the target does not exist,
//!  * a `<p>` index past the end of the source it indexes,
//!  * an `<input offset=>` set that does not match the `<p>` stride.
//!
//! Those are the rules the COLLADA 1.4.1 specification states, not conventions
//! this codebase invented, so a consumer (Google Earth, Blender, an
//! ODA/Teigha-based tool) enforces them whether or not we do.
//!
//! What this file deliberately does NOT do is re-validate the XML syntax: that
//! would mean hand-rolling an XML parser, which is the same "our own reader
//! agrees with our own writer" trap one level down. It is also the lowest risk
//! here, because every name in the document is generated (`geo0`, `mat0`,
//! `sym0`, `n0`) — no model-derived text reaches the markup, so there is no
//! escaping path to get wrong.

use super::*;

/// All `attr="value"` values for one attribute name, in document order.
///
/// The match is anchored on an attribute boundary (whitespace or `<` before the
/// name): a bare substring search for `id="` also finds the `sid="common"` that
/// every `<technique>` carries, which read as a duplicate `id` the moment a
/// second material appeared.
fn attr_values<'a>(xml: &'a str, attr: &str) -> Vec<&'a str> {
    let needle = format!("{attr}=\"");
    let mut out = Vec::new();
    let mut base = 0usize;
    while let Some(at) = xml[base..].find(&needle) {
        let start = base + at;
        let boundary = start == 0
            || xml[..start]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_whitespace() || c == '<');
        let value_start = start + needle.len();
        let end = value_start + xml[value_start..].find('"').expect("unterminated attribute value");
        if boundary {
            out.push(&xml[value_start..end]);
        }
        base = end;
    }
    out
}

/// Every `<tag ...>text</tag>` pair: the attribute text and the element text.
fn elements<'a>(xml: &'a str, tag: &str) -> Vec<(&'a str, &'a str)> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find(&open) {
        let s = &rest[at..];
        let tag_end = s.find('>').expect("unterminated open tag");
        let close_at = s.find(&close).expect("missing close tag");
        out.push((&s[open.len()..tag_end], &s[tag_end + 1..close_at]));
        rest = &s[close_at + close.len()..];
    }
    out
}

fn attr_of(attrs: &str, name: &str) -> Option<String> {
    attr_values(attrs, name).first().map(|s| s.to_string())
}

/// Assert the COLLADA 1.4.1 rules this exporter is bound by.
fn assert_collada_conformant(xml: &str, label: &str) {
    // ── ids are unique, and every reference resolves (§ "Address Syntax") ──
    let ids = attr_values(xml, "id");
    let mut seen = std::collections::HashSet::new();
    for id in &ids {
        assert!(seen.insert(*id), "{label}: duplicate id {id:?}");
    }
    for attr in ["url", "source", "target"] {
        for r in attr_values(xml, attr) {
            let Some(target) = r.strip_prefix('#') else {
                panic!("{label}: {attr}={r:?} is not a local URI fragment");
            };
            assert!(
                seen.contains(target),
                "{label}: {attr}=\"#{target}\" points at an id that is not in the document"
            );
        }
    }
    // Every `symbol=` bound in the visual scene must be a `material=` some
    // <triangles> declares, and vice versa — an unbound symbol renders
    // untextured/black rather than failing loudly.
    let symbols: std::collections::HashSet<_> = attr_values(xml, "symbol").into_iter().collect();
    let used: std::collections::HashSet<_> = attr_values(xml, "material").into_iter().collect();
    assert_eq!(symbols, used, "{label}: <instance_material> symbols vs <triangles> material");

    // ── float_array count == the number of values it holds (§5 float_array) ──
    let mut array_len: std::collections::HashMap<String, usize> = Default::default();
    for (attrs, text) in elements(xml, "float_array") {
        let id = attr_of(attrs, "id").expect("float_array needs an id");
        let declared: usize =
            attr_of(attrs, "count").expect("float_array count").parse().expect("numeric count");
        let actual = text.split_whitespace().count();
        assert_eq!(declared, actual, "{label}: float_array {id} declares {declared}, holds {actual}");
        assert!(declared >= 1, "{label}: float_array {id} is empty");
        array_len.insert(id, actual);
    }

    // ── accessor count * stride == the array it reads (§5 accessor) ─────────
    // `<accessor>` is self-closing here, so scan the open tags directly.
    let mut accessor_count: std::collections::HashMap<String, usize> = Default::default();
    let mut rest = xml;
    while let Some(at) = rest.find("<accessor") {
        let s = &rest[at..];
        let end = s.find('>').expect("unterminated accessor");
        let attrs = &s[..end];
        let src = attr_of(attrs, "source").expect("accessor source");
        let count: usize = attr_of(attrs, "count").unwrap().parse().unwrap();
        let stride: usize = attr_of(attrs, "stride").unwrap().parse().unwrap();
        let arr = src.strip_prefix('#').unwrap();
        let len = *array_len.get(arr).unwrap_or_else(|| panic!("{label}: accessor source {arr}"));
        assert_eq!(
            count * stride,
            len,
            "{label}: accessor over {arr} reads {count}x{stride} from an array of {len}"
        );
        // The accessor is what a consumer indexes into; remember its element
        // count under the enclosing <source> id (the array id minus "-arr").
        accessor_count.insert(arr.trim_end_matches("-arr").to_string(), count);
        rest = &s[end..];
    }

    // ── triangles: <p> length and index bounds (§5 triangles / input) ───────
    // `<vertices id="X"><input semantic="POSITION" source="#Y"/>` — the VERTEX
    // input names the <vertices>, which forwards to the POSITION <source>.
    let mut vertices_forward: std::collections::HashMap<String, String> = Default::default();
    for (attrs, body) in elements(xml, "vertices") {
        let id = attr_of(attrs, "id").expect("vertices id");
        let src = attr_values(body, "source")
            .first()
            .map(|s| s.trim_start_matches('#').to_string())
            .expect("vertices input source");
        vertices_forward.insert(id, src);
    }

    let mut triangle_blocks = 0usize;
    for (attrs, body) in elements(xml, "triangles") {
        triangle_blocks += 1;
        let declared: usize = attr_of(attrs, "count").expect("triangles count").parse().unwrap();
        // Inputs and their offsets: the <p> stride is max(offset) + 1.
        let mut offsets: Vec<usize> = Vec::new();
        let mut sources: Vec<(usize, String)> = Vec::new();
        let mut r = body;
        while let Some(at) = r.find("<input") {
            let s = &r[at..];
            let end = s.find('>').unwrap();
            let a = &s[..end];
            let off: usize = attr_of(a, "offset").expect("input offset").parse().unwrap();
            let src = attr_of(a, "source").unwrap().trim_start_matches('#').to_string();
            offsets.push(off);
            sources.push((off, src));
            r = &s[end..];
        }
        assert!(!offsets.is_empty(), "{label}: <triangles> with no <input>");
        let mut sorted = offsets.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted,
            (0..sorted.len()).collect::<Vec<_>>(),
            "{label}: <input> offsets must be 0..n-1 with no gaps or repeats"
        );
        let stride = sorted.len();

        let p = elements(body, "p");
        assert_eq!(p.len(), 1, "{label}: <triangles> holds exactly one <p>");
        let idx: Vec<usize> = p[0]
            .1
            .split_whitespace()
            .map(|t| t.parse().expect("integer index"))
            .collect();
        assert_eq!(
            idx.len(),
            declared * 3 * stride,
            "{label}: <p> holds {} indices, count={declared} x 3 verts x stride {stride}",
            idx.len()
        );

        for (off, src) in sources {
            let resolved = vertices_forward.get(&src).cloned().unwrap_or(src);
            let limit = *accessor_count
                .get(&resolved)
                .unwrap_or_else(|| panic!("{label}: no accessor behind {resolved}"));
            for (n, v) in idx.iter().enumerate().skip(off).step_by(stride) {
                assert!(
                    *v < limit,
                    "{label}: <p>[{n}] = {v} indexes past the {limit} elements of {resolved}"
                );
            }
        }
    }
    assert!(triangle_blocks > 0, "{label}: no <triangles> to check — the export was empty");
}

#[test]
fn from_meshes_collada_is_structurally_conformant() {
    // A unit quad in the XY plane (Y-up input), single red mesh.
    let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 4).flatten().collect();
    let indices = vec![0u32, 1, 2, 0, 2, 3];
    let xml = String::from_utf8(export_collada_from_meshes(
        &positions,
        &normals,
        &indices,
        &[4],
        &[6],
        &[1.0, 0.0, 0.0, 1.0],
        &[0.0, 0.0, 0.0],
    ))
    .unwrap();
    assert_collada_conformant(&xml, "one_quad");
}

#[test]
fn multi_material_collada_is_structurally_conformant() {
    // Two meshes with DIFFERENT colours and different vertex counts: one
    // material each, so the symbol/material binding and the per-material <p>
    // split are both exercised, and a per-mesh offset bug cannot hide behind
    // two identical meshes.
    let positions = vec![
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, // quad
        3.0, 0.0, 0.0, 4.0, 0.0, 0.0, 3.5, 0.0, 1.0, // triangle
    ];
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 7).flatten().collect();
    let indices = vec![0u32, 1, 2, 0, 2, 3, 0, 1, 2];
    let xml = String::from_utf8(export_collada_from_meshes(
        &positions,
        &normals,
        &indices,
        &[4, 3],
        &[6, 3],
        &[1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0],
        &[0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    ))
    .unwrap();
    assert_collada_conformant(&xml, "two_materials");
    // Both materials really are present — otherwise the symbol/material
    // equality above would hold vacuously over a single-entry set.
    assert!(xml.contains("symbol=\"sym0\"") && xml.contains("symbol=\"sym1\""));
}

#[test]
fn chunked_collada_is_structurally_conformant() {
    // Past the text-node ceiling the exporter splits into several <geometry>
    // chunks, each with its own ids and its own index space. A chunk whose <p>
    // still indexed the previous chunk's vertices would read as fine in every
    // substring test; here it is an out-of-range index.
    // MAX_TRIS per chunk is 20_000, so 25_000 one-triangle meshes must split.
    let mesh_count = 25_000usize;
    let mut positions = Vec::new();
    let mut normals = Vec::new();
    let mut indices = Vec::new();
    let mut vertex_counts = Vec::new();
    let mut index_counts = Vec::new();
    let mut colors = Vec::new();
    let mut origins = Vec::new();
    for m in 0..mesh_count {
        let x = m as f32;
        positions.extend_from_slice(&[x, 0.0, 0.0, x + 1.0, 0.0, 0.0, x + 0.5, 0.0, 1.0]);
        normals.extend_from_slice(&[0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0]);
        indices.extend_from_slice(&[0, 1, 2]);
        vertex_counts.push(3);
        index_counts.push(3);
        colors.extend_from_slice(&[0.5, 0.5, 0.5, 1.0]);
        origins.extend_from_slice(&[0.0, 0.0, 0.0]);
    }
    let xml = String::from_utf8(export_collada_from_meshes(
        &positions,
        &normals,
        &indices,
        &vertex_counts,
        &index_counts,
        &colors,
        &origins,
    ))
    .unwrap();
    // The point of this case is that there IS more than one chunk; without
    // this it would silently degrade into a second single-geometry test if the
    // chunk ceiling ever moved.
    assert!(
        xml.matches("<geometry ").count() > 1,
        "expected several <geometry> chunks, got {}",
        xml.matches("<geometry ").count()
    );
    assert_collada_conformant(&xml, "chunked");
}
