/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Small, self-contained XML-fragment writers for markup elements that sit
 * outside the `<Components>` tree: viewpoint geometry overlays (lines,
 * clipping planes, bitmaps) and the per-topic markup elements (source-file
 * header, BIM snippet, document reference). Split out of writer.ts, which
 * still owns the top-level document assembly (writeMarkupFile,
 * writeViewpointFiles) that calls into these.
 */

import type {
  BCFLine,
  BCFClippingPlane,
  BCFBitmap,
  BCFHeaderFile,
  BCFBimSnippet,
  BCFDocumentReference,
} from './types.js';
import { xsdDouble, xsdPointElement } from './numeric.js';
import { escapeXml } from './xml-text.js';
import { xsdOptionalDateTime } from './xsd-required-string.js';
import { uuidFromSeed } from '@ifc-lite/encoding';

/**
 * Write line XML
 */
export function writeLine(line: BCFLine, where: string): string {
  return `\n    <Line>${xsdPointElement('StartPoint', line.startPoint, '      ', where)}${xsdPointElement('EndPoint', line.endPoint, '      ', where)}
    </Line>`;
}

/**
 * Write clipping plane XML
 */
export function writeClippingPlane(plane: BCFClippingPlane, where: string): string {
  return `\n    <ClippingPlane>${xsdPointElement('Location', plane.location, '      ', where)}${xsdPointElement('Direction', plane.direction, '      ', where)}
    </ClippingPlane>`;
}

/**
 * Write bitmap XML
 *
 * Two more shape differences beyond the `<Bitmaps>` wrapper (see the call
 * site in writer.ts's writeViewpointFiles), both against v2_1/visinfo.xsd vs
 * v3_0/visinfo.xsd:
 * - The format element's name changes: 2.1 nests it as `<Bitmap>` (same tag
 *   name as the outer per-entry element -- `<Bitmap><Bitmap>PNG</Bitmap>...`);
 *   3.0 renamed it `<Format>`.
 * - The `BitmapFormat` enum's case changes: 2.1 is uppercase (`PNG`, `JPG`);
 *   3.0's simpleType only accepts lowercase (`png`, `jpg`) -- validation
 *   fails with "The value 'PNG' is not an element of the set {'png','jpg'}"
 *   otherwise. `BCFBitmap.format` stays typed `'PNG' | 'JPG'`; we only
 *   lowercase it on the wire for 3.0.
 */
export function writeBitmap(bitmap: BCFBitmap, version: '2.1' | '3.0', where: string): string {
  const formatTag = version === '3.0' ? 'Format' : 'Bitmap';
  const formatValue = version === '3.0' ? bitmap.format.toLowerCase() : bitmap.format;
  return `\n    <Bitmap>
      <${formatTag}>${formatValue}</${formatTag}>
      <Reference>${escapeXml(bitmap.reference)}</Reference>${xsdPointElement('Location', bitmap.location, '      ', where)}${xsdPointElement('Normal', bitmap.normal, '      ', where)}${xsdPointElement('Up', bitmap.up, '      ', where)}
      <Height>${xsdDouble(bitmap.height, 'Bitmap/Height', where)}</Height>
    </Bitmap>`;
}

/**
 * Write the markup `<Header>` block (source IFC files).
 *
 * The container differs by BCF version: 2.1 nests `<File>` directly under
 * `<Header>`, while 3.0 wraps them in a `<Files>` element. The `<File>` shape
 * (IfcProject / IfcSpatialStructureElement / isExternal attributes; Filename,
 * Date, Reference children) is identical across both.
 */
export function writeHeader(files: BCFHeaderFile[], version: '2.1' | '3.0'): string {
  const fileIndent = version === '3.0' ? '      ' : '    ';
  const fileXml = files.map((f) => writeHeaderFile(f, fileIndent, version)).join('');

  if (version === '3.0') {
    return `\n  <Header>\n    <Files>${fileXml}\n    </Files>\n  </Header>`;
  }
  return `\n  <Header>${fileXml}\n  </Header>`;
}

/** Write a single `<File>` entry inside the markup `<Header>`. */
function writeHeaderFile(file: BCFHeaderFile, indent: string, version: '2.1' | '3.0'): string {
  // isExternal defaults to true (an unresolved reference is treated as external).
  const isExternal = file.isExternal ?? true;
  // BCF 2.1 spells the attribute `isExternal`; 3.0 renamed it `IsExternal`.
  const isExternalAttr = version === '3.0' ? 'IsExternal' : 'isExternal';

  let attrs = '';
  if (file.ifcProject) {
    attrs += ` IfcProject="${escapeXml(file.ifcProject)}"`;
  }
  if (file.ifcSpatialStructureElement) {
    attrs += ` IfcSpatialStructureElement="${escapeXml(file.ifcSpatialStructureElement)}"`;
  }
  attrs += ` ${isExternalAttr}="${isExternal}"`;

  let content = `\n${indent}<File${attrs}>`;
  if (file.filename) {
    content += `\n${indent}  <Filename>${escapeXml(file.filename)}</Filename>`;
  }
  const fileDate = xsdOptionalDateTime(file.date);
  if (fileDate) {
    content += `\n${indent}  <Date>${fileDate}</Date>`;
  }
  if (file.reference) {
    content += `\n${indent}  <Reference>${escapeXml(file.reference)}</Reference>`;
  }
  content += `\n${indent}</File>`;
  return content;
}

/**
 * Write BimSnippet XML
 *
 * BCF 2.1 spells the attribute `isExternal`; 3.0 renamed it `IsExternal`
 * (buildingSMART/BCF-XML markup.xsd, BimSnippet's IsExternal attribute) —
 * same rename as the Header `<File>` attribute in {@link writeHeaderFile}.
 */
export function writeBimSnippet(snippet: BCFBimSnippet, version: '2.1' | '3.0'): string {
  // Caller guarantees referenceSchema is present (see writer.ts writeMarkupFile);
  // both Reference and ReferenceSchema are required by the BCF schema.
  const isExternalAttr = version === '3.0' ? 'IsExternal' : 'isExternal';
  let content = `\n    <BimSnippet SnippetType="${escapeXml(snippet.snippetType)}" ${isExternalAttr}="${snippet.isExternal}">`;
  content += `\n      <Reference>${escapeXml(snippet.reference)}</Reference>`;
  content += `\n      <ReferenceSchema>${escapeXml(snippet.referenceSchema ?? '')}</ReferenceSchema>`;
  content += `\n    </BimSnippet>`;
  return content;
}

/**
 * Write DocumentReference XML
 *
 * BCF 2.1 and 3.0 diverge structurally here, not just by attribute casing:
 * 2.1 has `<ReferencedDocument>` (a string, plus an `isExternal` flag on
 * whether it's a URL); 3.0 replaced both with `<DocumentGuid>` (a reference
 * into project.bcfp's Documents) or `<Url>`, and dropped `isExternal`
 * entirely (buildingSMART/BCF-XML markup.xsd, release_3_0 DocumentReference).
 * `documentGuid`/`url` are preferred when present; `referencedDocument` is
 * the 2.1-shaped fallback so 2.1-authored data written as 3.0 still emits
 * something.
 */
export function writeDocumentReference(
  docRef: BCFDocumentReference,
  version: '2.1' | '3.0',
  topicGuid: string,
  index: number,
): string {
  // 2.1's markup.xsd declares `Guid` with no `use`, so it is optional there;
  // 3.0's `DocumentReferenceAttributes` declares it `use="required"`, so
  // omitting it made every 3.0 topic carrying a guid-less document reference
  // write an invalid `markup.bcf` -- and markup.bcf IS the issue, so a viewer
  // that rejects it drops the topic whole (#3612). Mint one rather than
  // refuse: this guid names only itself (nothing in the archive refers to a
  // DocumentReference the way `RelatedTopic` refers to a topic), so a
  // generated value loses nothing. Refusal is reserved for values that assert
  // something only the caller knows -- `AspectRatio`, `TopicType` -- and would
  // fail the whole export over a field 2.1 says is optional. 2.1 keeps the
  // attribute absent: fabricating an identifier there buys no schema
  // conformance at all, and would put an identifier the caller never chose
  // into the file a user downloads.
  //
  // DERIVED, not random. `generateUuid()` here would make two exports of one
  // unchanged project differ in bytes -- and differ again on every subsequent
  // write, because nothing kept the value. `uuidFromSeed` is the same
  // generator `@ifc-lite/clash` anchors its topic guids with, so the guid is a
  // pure function of the topic, the document pointed at, and the position
  // within the topic; all three are in the seed because two references under
  // one topic can name the same document, and one document can appear under
  // two topics. `docKey` names the document in the SAME precedence the 3.0
  // body below uses -- seeding from the url alone left every `documentGuid`
  // reference on the empty string, so its guid ignored the document entirely
  // and two references naming different documents could collide. The result
  // is written back onto `docRef` so the in-memory project agrees with the
  // file rather than reporting no guid at all.
  const docKey = docRef.documentGuid ?? docRef.url ?? docRef.referencedDocument ?? '';
  const guid =
    version === '3.0'
      ? docRef.guid || uuidFromSeed(`${topicGuid}|${docKey}|${index}`)
      : docRef.guid;
  if (version === '3.0' && !docRef.guid) docRef.guid = guid;
  const guidAttr = guid ? ` Guid="${escapeXml(guid)}"` : '';

  if (version === '3.0') {
    let content = `\n    <DocumentReference${guidAttr}>`;
    if (docRef.documentGuid) {
      content += `\n      <DocumentGuid>${escapeXml(docRef.documentGuid)}</DocumentGuid>`;
    } else {
      const url = docRef.url ?? docRef.referencedDocument;
      if (url) {
        content += `\n      <Url>${escapeXml(url)}</Url>`;
      }
    }
    if (docRef.description) {
      content += `\n      <Description>${escapeXml(docRef.description)}</Description>`;
    }
    content += `\n    </DocumentReference>`;
    return content;
  }

  let content = `\n    <DocumentReference${guidAttr} isExternal="${docRef.isExternal ?? false}">`;
  content += `\n      <ReferencedDocument>${escapeXml(docRef.referencedDocument ?? docRef.url ?? '')}</ReferencedDocument>`;
  if (docRef.description) {
    content += `\n      <Description>${escapeXml(docRef.description)}</Description>`;
  }
  content += `\n    </DocumentReference>`;
  return content;
}
