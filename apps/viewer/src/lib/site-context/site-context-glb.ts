/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recognising a site-context GLB and splitting it into one GLB per category.
 *
 * A site-context GLB is a plain glTF 2.0 binary whose `asset.extras` carries
 * `ifcLiteSiteContext` (`packages/site-context/README.md`, "GLB format"). The
 * encoder writes `asset` first, so the marker sits in the first few hundred
 * bytes and the loader can route the file before the generic GLB branch from
 * the 4 KiB head it already reads. The full check is the decoder's own: a file
 * that carries the marker but is not a valid document is refused with
 * `SiteContextFormatError`, never shown as plain geometry.
 *
 * One model per category: the viewer federates each category as its own
 * model so the hierarchy can toggle terrain and parcel independently, and so
 * a later buildings category appears as a third model with no viewer work.
 * The CLI writes one GLB holding every category; the browser fetch emits one
 * per category. Splitting the CLI file here makes both arrive the same way.
 */

import { encodeSiteContextGlb, type SiteContextDocument, type SiteContextLayer, type SiteContextLayerKind } from '@ifc-lite/site-context';

const GLB_MAGIC = 0x46546c67;
const MARKER = '"ifcLiteSiteContext"';

/** True when `head` (the first bytes of a file) is a GLB whose asset extras name a site-context document. */
export function isSiteContextGlbHead(head: ArrayBuffer | Uint8Array): boolean {
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head);
  if (bytes.byteLength < 20) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return false;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(20, Math.min(bytes.byteLength, 4096)));
  // In `asset.extras`, which the encoder writes first. Feature nodes carry the
  // same key in their own extras, so a marker that only appears once the
  // scene graph has started is not the document marker.
  const asset = text.indexOf('"asset"');
  const marker = text.indexOf(MARKER);
  const graph = [text.indexOf('"scene'), text.indexOf('"nodes"')].filter((at) => at >= 0);
  return asset >= 0 && marker > asset && graph.every((at) => marker < at);
}

/** A document holding just one of `doc`'s categories, with the same frame. */
export function singleCategoryDocument(doc: SiteContextDocument, layer: SiteContextLayer): SiteContextDocument {
  return { crs: doc.crs, verticalCrs: doc.verticalCrs, origin: doc.origin, layers: [layer] };
}

/** The file name a category's GLB travels under (the model name the hierarchy shows is set separately). */
export function siteContextFileName(kind: SiteContextLayerKind): string {
  return `site-context-${kind}.glb`;
}

/** One single-category GLB per category of `doc`, in document order. */
export function splitSiteContextDocument(doc: SiteContextDocument): Array<{ kind: SiteContextLayerKind; bytes: Uint8Array }> {
  return doc.layers.map((layer) => ({ kind: layer.kind, bytes: encodeSiteContextGlb(singleCategoryDocument(doc, layer)) }));
}

/**
 * The frame a single category is written in when it is emitted on its own,
 * before the whole document is finished: the site centre rounded to whole
 * metres (the core's own plan origin) and the category's first feature
 * height, rounded. Any origin within the site keeps the node translations
 * exact; the federation places each category through its own frame.
 */
export function categoryOrigin(centre: { x: number; y: number }, layer: SiteContextLayer): [number, number, number] {
  const first = layer.features[0];
  return [Math.round(centre.x), Math.round(centre.y), first ? Math.round(first.origin[2]) : 0];
}
