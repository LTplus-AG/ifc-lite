/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Studio's XML (IDS-037): the document serialised by the shared IDS
 * writer, and the character range of a node inside it so the read-only
 * preview can highlight the selection.
 *
 * The writer is imported from ONE place, here. The campaign moves it into
 * `@ifc-lite/ids/writer` (IDS-003, P-01) and widens it to every info field and
 * to length/digit restrictions; until that lands this preview shows what the
 * current shared writer emits.
 */

import { writeIdsXml } from '@ifc-lite/rules';
import { locateNode, type StudioDocument, type Uuid } from '@ifc-lite/ids-authoring';

export type StudioXml = { ok: true; xml: string } | { ok: false; error: string };

export function studioXml(doc: StudioDocument): StudioXml {
  try {
    return { ok: true, xml: writeIdsXml(doc.ids) };
  } catch (error) {
    // The writer refuses content it cannot express; that is shown, not hidden.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface XmlRange {
  from: number;
  to: number;
}

const TAG = /<(\/?)([A-Za-z][\w:.-]*)\b[^>]*?(\/?)>/g;

/** Direct child elements of the element whose content spans `[from, to)`. */
function children(xml: string, from: number, to: number): XmlRange[] {
  const out: XmlRange[] = [];
  let depth = 0;
  let start = -1;
  TAG.lastIndex = from;
  for (let m = TAG.exec(xml); m && m.index < to; m = TAG.exec(xml)) {
    if (m[2].startsWith('?')) continue;
    const closing = m[1] === '/', selfClosing = m[3] === '/';
    if (!closing && depth === 0) start = m.index;
    if (selfClosing) {
      if (depth === 0) out.push({ from: start, to: TAG.lastIndex });
    } else if (closing) {
      depth--;
      if (depth === 0) out.push({ from: start, to: TAG.lastIndex });
    } else depth++;
  }
  return out;
}

/** The element's inner span (after its start tag, before its end tag). */
function inner(xml: string, range: XmlRange): XmlRange {
  return { from: xml.indexOf('>', range.from) + 1, to: xml.lastIndexOf('<', range.to - 1) };
}

function named(xml: string, ranges: XmlRange[], name: string): XmlRange[] {
  return ranges.filter((r) => xml.startsWith(`<${name}`, r.from) && /[\s/>]/.test(xml[r.from + name.length + 1] ?? ''));
}

/** Where `nodeId` is written in `xml` (as produced by {@link studioXml} for `doc`), or null. */
export function xmlRangeOf(xml: string, doc: StudioDocument, nodeId: Uuid): XmlRange | null {
  const [root] = children(xml, 0, xml.length).filter((r) => xml.startsWith('<ids', r.from));
  if (!root) return null;
  const top = children(xml, inner(xml, root).from, inner(xml, root).to);
  if (nodeId === doc.nodes.document) return named(xml, top, 'info')[0] ?? null;
  const loc = locateNode(doc, nodeId);
  if (!loc || loc.kind === 'document') return null;
  const [specsEl] = named(xml, top, 'specifications');
  if (!specsEl) return null;
  const specs = named(xml, children(xml, inner(xml, specsEl).from, inner(xml, specsEl).to), 'specification');
  const spec = specs[loc.specIndex];
  if (!spec || loc.kind === 'spec') return spec ?? null;
  const parts = children(xml, inner(xml, spec).from, inner(xml, spec).to);
  const [section] = named(xml, parts, loc.section === 'applicability' ? 'applicability' : 'requirements');
  if (!section) return null;
  return children(xml, inner(xml, section).from, inner(xml, section).to)[loc.facetIndex] ?? null;
}
