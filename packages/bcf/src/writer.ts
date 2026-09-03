/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF file writer
 *
 * Creates .bcfzip files from BCFProject structure
 */

import JSZip from 'jszip';
import type {
  BCFProject,
  BCFTopic,
  BCFComment,
  BCFViewpoint,
  BCFComponents,
  BCFComponent,
  BCFVisibility,
  BCFViewSetupHints,
  BCFColoring,
  BCFLine,
  BCFClippingPlane,
  BCFBitmap,
  BCFPoint,
  BCFDirection,
  BCFBimSnippet,
  BCFDocumentReference,
  BCFHeaderFile,
} from './types.js';
import {
  requireCameraChoice,
  writeOrthogonalCamera,
  writePerspectiveCamera,
} from './writer-camera.js';
import { xsdDouble, xsdInt, xsdPointElement } from './numeric.js';
import { escapeXml } from './xml-text.js';
import {
  XML_WHITESPACE_ONLY,
  xsdDateTime,
  xsdOptionalDateTime,
  xsdRequiredString,
} from './xsd-required-string.js';
import { generateUuid } from '@ifc-lite/encoding';

/**
 * Write a BCFProject to a .bcfzip file
 *
 * @param project - BCF project to write
 * @returns Blob containing the .bcfzip file
 */
export async function writeBCF(project: BCFProject): Promise<Blob> {
  const zip = new JSZip();

  // Write version file
  writeVersionFile(zip, project.version);

  // Write project file (optional)
  if (project.projectId || project.name) {
    writeProjectFile(zip, project, project.version);
  }

  // Write topics
  const usedFolderNames = new Set<string>();
  for (const topic of project.topics.values()) {
    await writeTopicFolder(zip, topic, project.version, usedFolderNames);
  }

  // Generate zip file
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/**
 * Write bcf.version file
 * Uses buildingSMART standard format with both xsi and xsd namespaces
 *
 * BCF 2.1's version.xsd declares `<DetailedVersion>` as an optional
 * (minOccurs="0") child of `<Version>`. BCF 3.0's version.xsd redefines
 * `<Version>` with ONLY a required `VersionId` attribute and no content
 * model at all (empty content type) -- emitting `<DetailedVersion>` there,
 * or even just the whitespace/newline of a non-self-closing `<Version>...
 * </Version>` pair, produces "Character content is not allowed, because the
 * content type is empty" (libxml2 treats incidental whitespace as character
 * content against an empty content model). So for 3.0 the element must be
 * self-closing with no child content at all, not merely omit DetailedVersion.
 */
function writeVersionFile(zip: JSZip, version: '2.1' | '3.0'): void {
  const content =
    version === '3.0'
      ? `<?xml version="1.0" encoding="UTF-8"?>
<Version xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" VersionId="${version}"/>`
      : `<?xml version="1.0" encoding="UTF-8"?>
<Version xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" VersionId="${version}">
  <DetailedVersion>${version}</DetailedVersion>
</Version>`;

  zip.file('bcf.version', content);
}

/**
 * Write project.bcfp file
 * Uses buildingSMART standard format
 *
 * The root element is renamed between versions: 2.1's project.xsd declares
 * root element `<ProjectExtension>` as the sequence `Project?`,
 * `ExtensionSchema` -- where `ExtensionSchema` is an `xs:anyURI` with no
 * `minOccurs`, so it is REQUIRED; 3.0's project.xsd instead declares root
 * element `<ProjectInfo>` containing just a required `<Project>`, and has no
 * `ProjectExtension`/`ExtensionSchema` concept at all. The inner
 * `<Project ProjectId="...">`/`<Name>` shape is unchanged between versions.
 *
 * `<ExtensionSchema>` used to be omitted entirely, which made `project.bcfp`
 * fail 2.1 validation ("Element 'ProjectExtension': Missing child element(s).
 * Expected is ( ExtensionSchema )") in EVERY 2.1 archive this package writes
 * -- 2.1 is the default version and `createBCFProject` always sets a project
 * id, so the file is always present. It is now emitted empty. An empty
 * `xs:anyURI` is a valid instance of the type (verified against the vendored
 * schema), and it is the honest value here: this writer ships no
 * `extensions.xsd`, and `BCFProject.extensions` is not serialized, so there is
 * no extension schema to point at. Naming a file we do not write would trade
 * the schema error for a dangling reference; omitting the element keeps the
 * schema error. Empty does neither.
 */
function writeProjectFile(zip: JSZip, project: BCFProject, version: '2.1' | '3.0'): void {
  const projectId = project.projectId || generateUuid();
  const nameElement = project.name ? `\n    <Name>${escapeXml(project.name)}</Name>` : '';
  const rootElement = version === '3.0' ? 'ProjectInfo' : 'ProjectExtension';
  const extensionSchema = version === '3.0' ? '' : '\n  <ExtensionSchema/>';

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<${rootElement} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Project ProjectId="${escapeXml(projectId)}">${nameElement}
  </Project>${extensionSchema}
</${rootElement}>`;

  zip.file('project.bcfp', content);
}

/** FNV-1a 32-bit hash, hex-encoded; disambiguates sanitized folder names. */
function shortGuidHash(guid: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < guid.length; i++) {
    h ^= guid.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Sanitize an arbitrary GUID for use as a zip path component (zip-slip guard).
 *
 * Shared by both the topic-folder name and the viewpoint file base name: a
 * viewpoint GUID is parsed just as unvalidated from untrusted markup XML on
 * read (reader.ts `parseViewpointContent`) as a topic GUID is, so it carries
 * the same path-traversal hazard (`../../evil` as a topic GUID would write
 * outside the archive root). Restrict the name to safe filename characters and
 * collapse any dot-run so it can never traverse. `fallback` is used when
 * sanitization strips the name to nothing. The real GUID is still written
 * verbatim as the markup `<Topic Guid>`/`<Viewpoint Guid>` attribute, which is
 * what readers key off.
 *
 * Sanitization is lossy, so two distinct GUIDs can map to one name, which
 * would silently overwrite an entry. Any name that sanitization changed gets
 * a hash of the original GUID appended, and `usedNames` catches the
 * remaining collisions with a counter suffix. Callers MUST sanitize each
 * GUID exactly once and reuse the result everywhere that GUID's entry is
 * named (markup references and the zip entry itself) -- calling this twice
 * for the same GUID against a `usedNames` set that already contains the
 * first result produces a second, different name.
 */
function sanitizeZipComponent(raw: string, usedNames: Set<string>, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\.+/g, '_');
  const base = cleaned === raw && cleaned.length > 0
    ? cleaned
    : `${cleaned.length > 0 ? cleaned : fallback}-${shortGuidHash(raw)}`;
  let candidate = base;
  for (let n = 2; usedNames.has(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  usedNames.add(candidate);
  return candidate;
}

/** Write a topic folder with all its contents. */
async function writeTopicFolder(
  zip: JSZip,
  topic: BCFTopic,
  version: '2.1' | '3.0',
  usedFolderNames: Set<string>,
): Promise<void> {
  const folder = zip.folder(sanitizeZipComponent(topic.guid, usedFolderNames, 'topic'));
  if (!folder) return;

  // Sanitize each viewpoint GUID once, up front, so the markup <Viewpoint>
  // reference (written below) and the zip entry (written in
  // writeViewpointFiles) always agree on the same file name. A topic-scoped
  // usedNames set disambiguates viewpoint GUIDs that sanitize identically,
  // the same way topic folders are disambiguated above.
  const usedViewpointNames = new Set<string>();
  const viewpointBaseNames = topic.viewpoints.map((vp) =>
    sanitizeZipComponent(vp.guid, usedViewpointNames, 'viewpoint'),
  );

  // Write markup.bcf
  writeMarkupFile(folder, topic, version, viewpointBaseNames);

  // Write viewpoints
  for (let i = 0; i < topic.viewpoints.length; i++) {
    await writeViewpointFiles(folder, topic.viewpoints[i], viewpointBaseNames[i], version);
  }
}

/**
 * Derive the snapshot file extension from the viewpoint's data-URL prefix.
 *
 * `snapshotData` carries no MIME type, so it defaults to PNG. Only the
 * `data:image/...` snapshot URL can be reliably format-detected.
 */
function snapshotExt(viewpoint: BCFViewpoint): 'png' | 'jpg' {
  const match = viewpoint.snapshot?.match(/^data:image\/(png|jpe?g)/i);
  if (match) {
    return match[1].toLowerCase().startsWith('jp') ? 'jpg' : 'png';
  }
  return 'png';
}

/** Write markup.bcf -- buildingSMART standard format. */
function writeMarkupFile(
  folder: JSZip,
  topic: BCFTopic,
  version: '2.1' | '3.0',
  viewpointBaseNames: string[],
): void {
  // BCF 3.0's markup.xsd tightens `Topic/@TopicType` and `Topic/@TopicStatus`
  // from optional (2.1) to `use="required"`. Omitting the attribute -
  // which is what 2.1 output does when the value is unset - produces
  // markup.bcf that fails 3.0 schema validation in every downstream tool.
  // We refuse to invent a value (e.g. defaulting to "Open") because that
  // would assert a topic status the user never chose; instead we fail the
  // write so the caller supplies one.
  if (version === '3.0') {
    if (!topic.topicType || XML_WHITESPACE_ONLY.test(topic.topicType)) {
      throw new Error(
        `BCF 3.0 requires Topic/@TopicType (topic "${topic.guid}" has none). ` +
          `Set topic.topicType before writing a 3.0 file.`
      );
    }
    if (!topic.topicStatus || XML_WHITESPACE_ONLY.test(topic.topicStatus)) {
      throw new Error(
        `BCF 3.0 requires Topic/@TopicStatus (topic "${topic.guid}" has none). ` +
          `Set topic.topicStatus before writing a 3.0 file.`
      );
    }
  }

  let content = `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">`;

  // Header (source IFC files) precedes Topic per the BCF markup schema sequence.
  if (topic.header && topic.header.length > 0) {
    content += writeHeader(topic.header, version);
  }

  content += `
  <Topic Guid="${escapeXml(topic.guid)}"${topic.topicType ? ` TopicType="${escapeXml(topic.topicType)}"` : ''}${topic.topicStatus ? ` TopicStatus="${escapeXml(topic.topicStatus)}"` : ''}>
    <Title>${escapeXml(topic.title)}</Title>`;

  // Order below (Title, Priority, Index, Labels, CreationDate,
  // CreationAuthor, ModifiedDate, ModifiedAuthor, DueDate, AssignedTo,
  // Stage, Description, BimSnippet, ...) follows the Topic xs:sequence in
  // BOTH buildingSMART/BCF-XML markup.xsd release_2_1 and release_3_0 --
  // confirmed identical there and against release_3_0's own conformance
  // fixture (Test Cases/v3.0/Visualization/Perspective camera/markup.bcf,
  // which reads ModifiedAuthor then Description then DocumentReferences).
  // Description and Labels were previously written out of this order
  // (Description right after Title; Labels after Stage). Both Priority,
  // Index, Labels, and Stage are optional and can be omitted, but
  // CreationDate/CreationAuthor below are always emitted, so xs:sequence
  // made the output schema-invalid whenever topic.description was set or
  // topic.labels was non-empty -- not "regardless of content": an absent
  // Description or empty Labels never appeared at all, so there was nothing
  // to be out of order.
  if (topic.priority) {
    content += `\n    <Priority>${escapeXml(topic.priority)}</Priority>`;
  }

  if (topic.index !== undefined) {
    // `Index` is the writer's only xs:int; see xsdInt for what that excludes.
    content += `\n    <Index>${xsdInt(topic.index, 'Topic/Index', `topic "${topic.guid}"`)}</Index>`;
  }

  if (topic.labels && topic.labels.length > 0) {
    // BCF 3.0's markup.xsd wraps labels in ONE `<Labels>` container holding
    // repeated `<Label>` children (Labels -> Label*); repeating `<Labels>text
    // </Labels>` once per label -- the 2.1 shape, where `<Labels>` itself is
    // the repeated per-entry element with no `<Label>` child -- fails 3.0
    // validation ("Character content other than whitespace is not allowed
    // because the content type is 'element-only'"). 2.1 is left as-is.
    if (version === '3.0') {
      content += `\n    <Labels>`;
      for (const label of topic.labels) {
        content += `\n      <Label>${escapeXml(label)}</Label>`;
      }
      content += `\n    </Labels>`;
    } else {
      for (const label of topic.labels) {
        content += `\n    <Labels>${escapeXml(label)}</Labels>`;
      }
    }
  }

  content += `\n    <CreationDate>${xsdDateTime(topic.creationDate, 'Topic/CreationDate', `topic "${topic.guid}"`)}</CreationDate>`;
  content += `\n    <CreationAuthor>${xsdRequiredString(topic.creationAuthor, 'Topic/CreationAuthor', `topic "${topic.guid}"`, version)}</CreationAuthor>`;

  const topicModifiedDate = xsdOptionalDateTime(topic.modifiedDate);
  if (topicModifiedDate) {
    content += `\n    <ModifiedDate>${topicModifiedDate}</ModifiedDate>`;
    // BCF spec requires ModifiedAuthor when ModifiedDate is present
    const modifiedAuthor = topic.modifiedAuthor || topic.creationAuthor;
    content += `\n    <ModifiedAuthor>${xsdRequiredString(modifiedAuthor, 'Topic/ModifiedAuthor', `topic "${topic.guid}"`, version)}</ModifiedAuthor>`;
  }

  const dueDate = xsdOptionalDateTime(topic.dueDate);
  if (dueDate) {
    content += `\n    <DueDate>${dueDate}</DueDate>`;
  }

  if (topic.assignedTo) {
    content += `\n    <AssignedTo>${escapeXml(topic.assignedTo)}</AssignedTo>`;
  }

  if (topic.stage) {
    content += `\n    <Stage>${escapeXml(topic.stage)}</Stage>`;
  }

  if (topic.description) {
    content += `\n    <Description>${escapeXml(topic.description)}</Description>`;
  }

  // ReferenceSchema is required inside BimSnippet by the BCF XSD; only emit the
  // snippet when it is complete so we never write schema-invalid markup. (The
  // type marks referenceSchema optional, but a snippet without it is unusable.)
  if (topic.bimSnippet?.referenceSchema) {
    content += writeBimSnippet(topic.bimSnippet, version);
  }

  if (topic.documentReferences && topic.documentReferences.length > 0) {
    // Containment differs too: 3.0 groups the entries under a single
    // <DocumentReferences> element, while 2.1 repeats <DocumentReference>
    // directly under <Topic> (buildingSMART/BCF-XML markup.xsd, Topic).
    if (version === '3.0') content += `\n    <DocumentReferences>`;
    for (const docRef of topic.documentReferences) {
      content += writeDocumentReference(docRef, version);
    }
    if (version === '3.0') content += `\n    </DocumentReferences>`;
  }

  if (topic.relatedTopics && topic.relatedTopics.length > 0) {
    // Same containment split as DocumentReferences/Comments/Viewpoints
    // elsewhere in this function: 3.0's markup.xsd groups entries under one
    // <RelatedTopics> element, while 2.1 repeats <RelatedTopic> directly
    // under <Topic>.
    if (version === '3.0') content += `\n    <RelatedTopics>`;
    for (const relatedGuid of topic.relatedTopics) {
      content += `\n    <RelatedTopic Guid="${escapeXml(relatedGuid)}"/>`;
    }
    if (version === '3.0') content += `\n    </RelatedTopics>`;
  }

  // Render each <Comment Guid="..."> wrapper. Shared by both versions --
  // the wrapper's own shape doesn't change, only where it's placed (see
  // below).
  const commentXml = (indent: string) =>
    topic.comments
      .map((comment) => {
        let c = `\n${indent}<Comment Guid="${escapeXml(comment.guid)}">`;
        c += `\n${indent}  <Date>${xsdDateTime(comment.date, 'Comment/Date', `comment "${comment.guid}"`)}</Date>`;
        c += `\n${indent}  <Author>${xsdRequiredString(comment.author, 'Comment/Author', `comment "${comment.guid}"`, version)}</Author>`;
        c += `\n${indent}  <Comment>${escapeXml(comment.comment)}</Comment>`;
        if (comment.viewpointGuid) {
          c += `\n${indent}  <Viewpoint Guid="${escapeXml(comment.viewpointGuid)}"/>`;
        }
        const commentModifiedDate = xsdOptionalDateTime(comment.modifiedDate);
        if (commentModifiedDate) {
          c += `\n${indent}  <ModifiedDate>${commentModifiedDate}</ModifiedDate>`;
        }
        if (comment.modifiedAuthor) {
          c += `\n${indent}  <ModifiedAuthor>${escapeXml(comment.modifiedAuthor)}</ModifiedAuthor>`;
        }
        c += `\n${indent}</Comment>`;
        return c;
      })
      .join('');

  // Render each viewpoint reference. BCF 2.1 names the per-entry element
  // <Viewpoints Guid="..."> (the wrapper IS the entry, repeated); BCF 3.0
  // renamed the entry to singular <ViewPoint Guid="..."> (capital P) nested
  // inside one shared <Viewpoints> wrapper (buildingSMART/BCF-XML
  // markup.xsd, release_3_0 Topic.Viewpoints/ViewPoint -- confirmed against
  // Test Cases/v3.0/Visualization/Perspective camera/unzipped/.../markup.bcf,
  // which reads `<Viewpoints><ViewPoint Guid="f99eb1ed-...">`).
  const viewpointEntryTag = version === '3.0' ? 'ViewPoint' : 'Viewpoints';
  const viewpointXml = (indent: string) =>
    topic.viewpoints
      .map((viewpoint, i) => {
        // Use standard buildingSMART naming convention: Viewpoint_<guid>.bcfv,
        // but the file name component is the sanitized base name (zip-slip
        // guard) -- the SAME one writeViewpointFiles uses for the actual entry,
        // so the markup reference and the archive agree. The real GUID is still
        // written verbatim as the Guid attribute below.
        const baseName = viewpointBaseNames[i];
        const filename = `Viewpoint_${baseName}.bcfv`;
        const snapshotName = `Snapshot_${baseName}.${snapshotExt(viewpoint)}`;

        let v = `\n${indent}<${viewpointEntryTag} Guid="${escapeXml(viewpoint.guid)}">`;
        v += `\n${indent}  <Viewpoint>${filename}</Viewpoint>`;
        if (viewpoint.snapshot || viewpoint.snapshotData) {
          v += `\n${indent}  <Snapshot>${snapshotName}</Snapshot>`;
        }
        v += `\n${indent}</${viewpointEntryTag}>`;
        return v;
      })
      .join('');

  if (version === '3.0') {
    // BCF 3.0's markup.xsd moves Comments and Viewpoints INSIDE <Topic>
    // (wrapped in their own plural containers), after RelatedTopics -- unlike
    // 2.1, where they are top-level <Markup> siblings following </Topic>.
    // Writing them as 2.1-shaped top-level siblings at version 3.0 produces
    // markup a strict 3.0 consumer rejects outright (Comments/Viewpoints
    // would not even be children of Topic, let alone in schema order).
    if (topic.comments.length > 0) {
      content += `\n    <Comments>${commentXml('      ')}\n    </Comments>`;
    }
    if (topic.viewpoints.length > 0) {
      content += `\n    <Viewpoints>${viewpointXml('      ')}\n    </Viewpoints>`;
    }
    content += `\n  </Topic>`;
  } else {
    content += `\n  </Topic>`;
    // 2.1's Markup sequence is Header, Topic, Comment*, Viewpoints*
    // (buildingSMART/BCF-XML release_2_1 markup.xsd) -- Comment precedes
    // Viewpoints, the reverse of the order written here previously.
    content += commentXml('  ');
    content += viewpointXml('  ');
  }

  content += `\n</Markup>`;

  folder.file('markup.bcf', content);
}

/**
 * Write viewpoint files (bcfv and snapshot)
 */
async function writeViewpointFiles(
  folder: JSZip,
  viewpoint: BCFViewpoint,
  baseName: string,
  version: '2.1' | '3.0',
): Promise<void> {
  // Use standard buildingSMART naming convention: Viewpoint_<guid>.bcfv, but
  // the file name component is the sanitized base name (zip-slip guard) --
  // the SAME one the caller wrote into the markup <Viewpoint> reference, so
  // the archive entry and the markup agree. See sanitizeZipComponent.
  const filename = `Viewpoint_${baseName}.bcfv`;
  const snapshotName = `Snapshot_${baseName}.${snapshotExt(viewpoint)}`;

  // Write viewpoint XML - use buildingSMART standard format
  let content = `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" Guid="${escapeXml(viewpoint.guid)}">`;

  // Write components
  if (viewpoint.components) {
    content += writeComponents(viewpoint.components, version);
  }

  // Every number below reaches an XSD numeric type, so each goes through
  // `numeric.ts`'s write-side guards; `where` is what puts the offending
  // viewpoint's guid in the error, as the camera checks already do.
  const where = `viewpoint "${viewpoint.guid}"`;

  // Write the cameras. ORTHOGONAL FIRST -- see requireCameraChoice for why the
  // order is not free, and for the 3.0 cardinality rule enforced here.
  requireCameraChoice(viewpoint, version);

  if (viewpoint.orthogonalCamera) {
    content += writeOrthogonalCamera(viewpoint.orthogonalCamera, version, viewpoint.guid);
  }

  if (viewpoint.perspectiveCamera) {
    content += writePerspectiveCamera(viewpoint.perspectiveCamera, version, viewpoint.guid);
  }

  // Write lines
  if (viewpoint.lines && viewpoint.lines.length > 0) {
    content += `\n  <Lines>`;
    for (const line of viewpoint.lines) {
      content += writeLine(line, where);
    }
    content += `\n  </Lines>`;
  }

  // Write clipping planes
  if (viewpoint.clippingPlanes && viewpoint.clippingPlanes.length > 0) {
    content += `\n  <ClippingPlanes>`;
    for (const plane of viewpoint.clippingPlanes) {
      content += writeClippingPlane(plane, where);
    }
    content += `\n  </ClippingPlanes>`;
  }

  // Write bitmaps
  //
  // The wrapper and inner shape both change between versions (v2_1/visinfo.xsd
  // vs v3_0/visinfo.xsd):
  // - 2.1: `<Bitmap>` entries sit DIRECTLY under `<VisualizationInfo>`, no
  //   wrapping element (there is no `<Bitmaps>` in the 2.1 schema at all).
  // - 3.0: entries are wrapped in a `<Bitmaps>` container.
  // See {@link writeBitmap} for the further divergence inside each entry.
  if (viewpoint.bitmaps && viewpoint.bitmaps.length > 0) {
    if (version === '3.0') {
      content += `\n  <Bitmaps>`;
      for (const bitmap of viewpoint.bitmaps) {
        content += writeBitmap(bitmap, version, where);
      }
      content += `\n  </Bitmaps>`;
    } else {
      for (const bitmap of viewpoint.bitmaps) {
        content += writeBitmap(bitmap, version, where);
      }
    }
  }

  content += `\n</VisualizationInfo>`;

  folder.file(filename, content);

  // Write snapshot
  if (viewpoint.snapshotData) {
    folder.file(snapshotName, viewpoint.snapshotData);
  } else if (viewpoint.snapshot && viewpoint.snapshot.startsWith('data:')) {
    // Convert data URL to binary
    const base64Data = viewpoint.snapshot.split(',')[1];
    if (base64Data) {
      try {
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        folder.file(snapshotName, bytes);
      } catch (e) {
        // Skip a single malformed snapshot data URL rather than aborting the export
        console.warn('[BCF] Skipping malformed snapshot data URL:', e);
      }
    }
  }
}

/**
 * Write components XML
 *
 * BCF 2.1 schema order (MUST follow this order):
 * 1. ViewSetupHints (optional)
 * 2. Selection (optional)
 * 3. Visibility (REQUIRED)
 * 4. Coloring (optional)
 */
function writeComponents(components: BCFComponents, version: '2.1' | '3.0'): string {
  let content = `\n  <Components>`;

  // 1. Write ViewSetupHints (2.1 only -- see writeVisibility for the 3.0
  // placement, which is inside <Visibility> instead of here).
  if (version === '2.1' && components.visibility?.viewSetupHints) {
    content += writeViewSetupHintsElement(components.visibility.viewSetupHints);
  }

  // 2. Write selection (before visibility per schema)
  if (components.selection && components.selection.length > 0) {
    content += `\n    <Selection>`;
    for (const component of components.selection) {
      content += writeComponent(component);
    }
    content += `\n    </Selection>`;
  }

  // 3. Write visibility (REQUIRED by schema)
  content += writeVisibility(components.visibility, version);

  // 4. Write coloring
  if (components.coloring && components.coloring.length > 0) {
    content += `\n    <Coloring>`;
    for (const coloring of components.coloring) {
      content += writeColoringEntry(coloring, version);
    }
    content += `\n    </Coloring>`;
  }

  content += `\n  </Components>`;
  return content;
}

/** Write the `<ViewSetupHints>` element itself (attributes only, no children). */
function writeViewSetupHintsElement(hints: BCFViewSetupHints, indent = '    '): string {
  let content = `\n${indent}<ViewSetupHints`;
  if (hints.spacesVisible !== undefined) {
    content += ` SpacesVisible="${hints.spacesVisible}"`;
  }
  if (hints.spaceBoundariesVisible !== undefined) {
    content += ` SpaceBoundariesVisible="${hints.spaceBoundariesVisible}"`;
  }
  if (hints.openingsVisible !== undefined) {
    content += ` OpeningsVisible="${hints.openingsVisible}"`;
  }
  content += `/>`;
  return content;
}

/**
 * Write visibility XML
 *
 * Per BCF 2.1 schema (v2_1/visinfo.xsd):
 * - Visibility is REQUIRED inside Components
 * - DefaultVisibility attribute defaults to false
 * - Exceptions contains Component elements (entities to show/hide opposite of default)
 * - ViewSetupHints is NOT inside Visibility -- it is a sibling of Visibility
 *   at Components level (written by {@link writeComponents} instead)
 *
 * BCF 3.0 moved it: v3_0/visinfo.xsd's `ComponentVisibility` complexType is a
 * sequence of `ViewSetupHints` (optional) then `Exceptions` (optional), and
 * 3.0's `Components` complexType only allows exactly Selection/Visibility/
 * Coloring as children -- so for 3.0, ViewSetupHints must be the FIRST child
 * of `<Visibility>`, not a Components-level sibling.
 */
function writeVisibility(visibility: BCFVisibility | undefined, version: '2.1' | '3.0'): string {
  // Default visibility to true (show all) if not specified
  const defaultVis = visibility?.defaultVisibility ?? true;

  let content = `\n    <Visibility DefaultVisibility="${defaultVis}">`;

  if (version === '3.0' && visibility?.viewSetupHints) {
    content += writeViewSetupHintsElement(visibility.viewSetupHints, '      ');
  }

  if (visibility?.exceptions && visibility.exceptions.length > 0) {
    content += `\n      <Exceptions>`;
    for (const component of visibility.exceptions) {
      content += writeComponent(component, '        ');
    }
    content += `\n      </Exceptions>`;
  }

  content += `\n    </Visibility>`;
  return content;
}

/**
 * Write a single component XML
 *
 * Per BCF 2.1 schema:
 * - IfcGuid is an ATTRIBUTE (required for IFC objects)
 * - OriginatingSystem is a child ELEMENT (optional)
 * - AuthoringToolId is a child ELEMENT (optional)
 */
function writeComponent(component: BCFComponent, indent = '      '): string {
  const hasChildren = component.originatingSystem || component.authoringToolId;

  let content = `\n${indent}<Component`;

  if (component.ifcGuid) {
    content += ` IfcGuid="${escapeXml(component.ifcGuid)}"`;
  }

  if (hasChildren) {
    content += `>`;
    if (component.originatingSystem) {
      content += `\n${indent}  <OriginatingSystem>${escapeXml(component.originatingSystem)}</OriginatingSystem>`;
    }
    if (component.authoringToolId) {
      content += `\n${indent}  <AuthoringToolId>${escapeXml(component.authoringToolId)}</AuthoringToolId>`;
    }
    content += `\n${indent}</Component>`;
  } else {
    content += `/>`;
  }

  return content;
}

/**
 * Write coloring entry XML
 *
 * Containment differs between versions (v2_1/visinfo.xsd's `ComponentColoring`
 * vs v3_0/visinfo.xsd's `ComponentColoring`): 2.1 nests `<Component>` entries
 * directly under `<Color>`; 3.0 adds one more wrapping level, an inner
 * `<Components>` element (distinct from the outer per-viewpoint `<Components>`
 * written by {@link writeComponents}) holding the `<Component>` entries.
 */
function writeColoringEntry(coloring: BCFColoring, version: '2.1' | '3.0'): string {
  let content = `\n      <Color Color="${escapeXml(coloring.color)}">`;
  if (version === '3.0') content += `\n        <Components>`;
  for (const component of coloring.components) {
    content += writeComponent(component, version === '3.0' ? '          ' : '        ');
  }
  if (version === '3.0') content += `\n        </Components>`;
  content += `\n      </Color>`;
  return content;
}

/**
 * Write line XML
 */
function writeLine(line: BCFLine, where: string): string {
  return `\n    <Line>${xsdPointElement('StartPoint', line.startPoint, '      ', where)}${xsdPointElement('EndPoint', line.endPoint, '      ', where)}
    </Line>`;
}

/**
 * Write clipping plane XML
 */
function writeClippingPlane(plane: BCFClippingPlane, where: string): string {
  return `\n    <ClippingPlane>${xsdPointElement('Location', plane.location, '      ', where)}${xsdPointElement('Direction', plane.direction, '      ', where)}
    </ClippingPlane>`;
}

/**
 * Write bitmap XML
 *
 * Two more shape differences beyond the `<Bitmaps>` wrapper (see the call
 * site in {@link writeViewpointFiles}), both against v2_1/visinfo.xsd vs
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
function writeBitmap(bitmap: BCFBitmap, version: '2.1' | '3.0', where: string): string {
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
function writeHeader(files: BCFHeaderFile[], version: '2.1' | '3.0'): string {
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
function writeBimSnippet(snippet: BCFBimSnippet, version: '2.1' | '3.0'): string {
  // Caller guarantees referenceSchema is present (see writeMarkupFile); both
  // Reference and ReferenceSchema are required by the BCF schema.
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
function writeDocumentReference(docRef: BCFDocumentReference, version: '2.1' | '3.0'): string {
  const guidAttr = docRef.guid ? ` Guid="${escapeXml(docRef.guid)}"` : '';

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
