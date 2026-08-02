/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF file reader
 *
 * Parses .bcfzip files into BCFProject structure
 */

import JSZip from 'jszip';
import type {
  BCFProject,
  BCFTopic,
  BCFComment,
  BCFViewpoint,
  BCFVersion,
  BCFComponents,
  BCFComponent,
  BCFVisibility,
  BCFColoring,
  BCFPerspectiveCamera,
  BCFOrthogonalCamera,
  BCFLine,
  BCFClippingPlane,
  BCFBitmap,
  BCFPoint,
  BCFDirection,
  BCFExtensions,
  BCFDocumentReference,
  BCFBimSnippet,
  BCFHeaderFile,
} from './types.js';

/**
 * Resource caps guarding against a malicious (zip-bomb) .bcfzip: a tiny
 * compressed archive that expands to gigabytes, or one with a pathological
 * entry count, would OOM the tab. A real BCF is well under these bounds.
 */
const MAX_BCF_ARCHIVE_BYTES = 250 * 1024 * 1024; // 250 MB compressed input
const MAX_BCF_ENTRIES = 20_000; // total zip entries
const MAX_BCF_EXPANDED_BYTES = 1024 * 1024 * 1024; // 1 GB total uncompressed

/** Running total of ACTUAL decompressed output, shared across all entry reads. */
interface ExpansionBudget {
  used: number;
  limit: number;
}

/**
 * Raised when an archive blows a resource cap. Distinguishable so the
 * per-topic/per-viewpoint "skip malformed content" catch blocks rethrow it
 * instead of downgrading a detected zip bomb to a console warning.
 */
class BCFResourceLimitError extends Error {}

/** The subset of JSZip's (untyped) internal stream API the budget reader uses. */
interface EntryStream {
  on(event: 'data', cb: (chunk: Uint8Array) => void): this;
  on(event: 'error', cb: (error: Error) => void): this;
  on(event: 'end', cb: () => void): this;
  resume(): this;
  pause(): this;
}
interface StreamableEntry {
  // Only 'uint8array' is ever requested: byte chunks keep the expansion
  // budget exact (string chunks are UTF-16 code units, not bytes).
  internalStream(type: 'uint8array'): EntryStream;
}

/**
 * Decompress one zip entry while charging every ACTUAL output chunk against a
 * shared budget, aborting mid-stream once the cap is crossed.
 *
 * The central-directory `uncompressedSize` an attacker writes can understate
 * the real inflate output, so a declared-size pre-check alone is bypassable;
 * only counting the bytes as they come out of the decompressor is sound.
 */
function readEntryCapped(entry: JSZip.JSZipObject, type: 'string', budget: ExpansionBudget): Promise<string>;
function readEntryCapped(entry: JSZip.JSZipObject, type: 'uint8array', budget: ExpansionBudget): Promise<Uint8Array>;
function readEntryCapped(
  entry: JSZip.JSZipObject,
  type: 'string' | 'uint8array',
  budget: ExpansionBudget,
): Promise<string | Uint8Array> {
  const streamable = entry as unknown as StreamableEntry;
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    // Always stream raw bytes, even for string reads: JSZip's 'string' chunks
    // are UTF-16 code units, which under-charge the budget by up to 3x for
    // multi-byte UTF-8 (a text bomb would get that much headroom past the
    // cap). Byte chunks make the accounting exact; decode to UTF-8 at the end.
    const stream = streamable.internalStream('uint8array');
    stream
      .on('data', (chunk: Uint8Array) => {
        budget.used += chunk.length;
        if (budget.used > budget.limit) {
          stream.pause();
          reject(new BCFResourceLimitError(
            `BCF archive rejected: decompressed output exceeds cap ${budget.limit} bytes (zip bomb?)`,
          ));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', reject)
      .on('end', () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.length;
        }
        resolve(type === 'string' ? new TextDecoder().decode(out) : out);
      })
      .resume();
  });
}

/**
 * Count raw zip records by scanning the buffer for local-file-header and
 * central-directory signatures. JSZip's `files` map is keyed by pathname, so
 * 20,001 records sharing one name dedupe to a single visible entry; counting
 * signatures in the raw bytes is independent of that. Random payload bytes can
 * only over-count (~2^-32 per position), which errs toward rejection.
 */
function countRawZipRecords(bytes: Uint8Array): number {
  let localHeaders = 0;
  let centralRecords = 0;
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b) {
      if (bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) localHeaders++;
      else if (bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02) centralRecords++;
    }
  }
  return Math.max(localHeaders, centralRecords);
}

/**
 * Reject an archive whose entry count or declared expanded size exceeds the
 * caps, before any entry is decompressed. Declared sizes are attacker
 * controlled (and the pinned JSZip surfaces >0x7fffffff as negative), so an
 * invalid declaration is itself grounds for rejection; the enforceable bound
 * on real output is {@link readEntryCapped}'s actual-bytes budget.
 */
function assertArchiveWithinLimits(zip: JSZip, maxEntries: number, maxExpandedBytes: number): void {
  let entries = 0;
  let declared = 0;
  zip.forEach((relativePath, entry) => {
    entries++;
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })
      ._data?.uncompressedSize ?? 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new BCFResourceLimitError(`BCF archive rejected: entry "${relativePath}" declares an invalid size`);
    }
    declared += size;
  });
  if (entries > maxEntries) {
    throw new BCFResourceLimitError(`BCF archive rejected: ${entries} entries exceeds cap ${maxEntries}`);
  }
  if (declared > maxExpandedBytes) {
    throw new BCFResourceLimitError(
      `BCF archive rejected: declares ${declared} expanded bytes, exceeds cap ${maxExpandedBytes}`,
    );
  }
}

/**
 * Parse a BCF file (.bcfzip) into a BCFProject
 *
 * @param file - BCF file as File, Blob, or ArrayBuffer
 * @param limits - Optional overrides of the anti-zip-bomb resource caps
 * @returns Parsed BCF project
 */
export async function readBCF(
  file: File | Blob | ArrayBuffer | Uint8Array,
  limits?: { maxArchiveBytes?: number; maxEntries?: number; maxExpandedBytes?: number },
): Promise<BCFProject> {
  const maxArchiveBytes = limits?.maxArchiveBytes ?? MAX_BCF_ARCHIVE_BYTES;
  const maxEntries = limits?.maxEntries ?? MAX_BCF_ENTRIES;
  const maxExpandedBytes = limits?.maxExpandedBytes ?? MAX_BCF_EXPANDED_BYTES;

  const inputBytes = file instanceof ArrayBuffer || file instanceof Uint8Array
    ? file.byteLength
    : file.size;
  if (inputBytes > maxArchiveBytes) {
    throw new BCFResourceLimitError(
      `BCF archive rejected: ${inputBytes} bytes exceeds cap ${maxArchiveBytes}`,
    );
  }

  const bytes = file instanceof ArrayBuffer
    ? new Uint8Array(file)
    : file instanceof Uint8Array
      ? file
      : new Uint8Array(await file.arrayBuffer());
  const rawRecords = countRawZipRecords(bytes);
  if (rawRecords > maxEntries) {
    throw new BCFResourceLimitError(`BCF archive rejected: ${rawRecords} raw records exceeds cap ${maxEntries}`);
  }

  const zip = await JSZip.loadAsync(bytes);
  assertArchiveWithinLimits(zip, maxEntries, maxExpandedBytes);
  const budget: ExpansionBudget = { used: 0, limit: maxExpandedBytes };

  // Read version file
  const version = await readVersionFile(zip, budget);

  // Read project file (optional)
  const { projectId, name, extensions } = await readProjectFile(zip, budget);

  // Read topics
  const topics = await readTopics(zip, budget);

  return {
    version: version.versionId,
    projectId,
    name,
    topics,
    extensions,
  };
}

/**
 * Read bcf.version file
 */
async function readVersionFile(zip: JSZip, budget: ExpansionBudget): Promise<BCFVersion> {
  const versionFile = zip.file('bcf.version');
  if (!versionFile) {
    throw new Error('Invalid BCF file: missing bcf.version');
  }

  const content = await readEntryCapped(versionFile, 'string', budget);
  const versionMatch = content.match(/VersionId="([^"]+)"/);

  if (!versionMatch) {
    throw new Error('Invalid BCF version file: could not parse VersionId');
  }

  const versionId = versionMatch[1] as '2.1' | '3.0';
  if (versionId !== '2.1' && versionId !== '3.0') {
    console.warn(`Unsupported BCF version: ${versionId}, treating as 2.1`);
  }

  return {
    versionId: versionId === '3.0' ? '3.0' : '2.1',
    detailedVersion: versionMatch[1],
  };
}

/**
 * Read project.bcfp file (optional)
 */
async function readProjectFile(zip: JSZip, budget: ExpansionBudget): Promise<{
  projectId?: string;
  name?: string;
  extensions?: BCFExtensions;
}> {
  const projectFile = zip.file('project.bcfp');
  if (!projectFile) {
    return {};
  }

  const content = await readEntryCapped(projectFile, 'string', budget);

  const projectIdMatch = content.match(/ProjectId="([^"]+)"/);
  const nameMatch = content.match(/<Name>([^<]+)<\/Name>/);

  return {
    projectId: projectIdMatch?.[1],
    name: nameMatch?.[1],
  };
}

/**
 * Read all topics from the BCF archive
 */
async function readTopics(zip: JSZip, budget: ExpansionBudget): Promise<Map<string, BCFTopic>> {
  const topics = new Map<string, BCFTopic>();

  // Find all topic folders (folders with markup.bcf)
  const topicFolders = new Set<string>();

  zip.forEach((relativePath: string) => {
    const match = relativePath.match(/^([^/]+)\/markup\.bcf$/i);
    if (match) {
      topicFolders.add(match[1]);
    }
  });

  // Parse each topic
  for (const topicGuid of topicFolders) {
    try {
      const topic = await readTopic(zip, topicGuid, budget);
      if (topic) {
        topics.set(topic.guid, topic);
      }
    } catch (error) {
      if (error instanceof BCFResourceLimitError) throw error;
      console.warn(`Failed to parse topic ${topicGuid}:`, error);
    }
  }

  return topics;
}

/**
 * Read a single topic from the BCF archive
 */
async function readTopic(zip: JSZip, topicFolder: string, budget: ExpansionBudget): Promise<BCFTopic | null> {
  const markupFile = zip.file(`${topicFolder}/markup.bcf`);
  if (!markupFile) {
    return null;
  }

  const markupContent = await readEntryCapped(markupFile, 'string', budget);

  // Parse Topic element
  const topicMatch = markupContent.match(/<Topic\s+Guid="([^"]+)"[^>]*>([\s\S]*?)<\/Topic>/);
  if (!topicMatch) {
    console.warn(`Invalid markup.bcf in ${topicFolder}: missing Topic element`);
    return null;
  }

  const guid = topicMatch[1];
  const topicContent = topicMatch[2];

  // Header (source IFC files) sits before Topic in the markup, so parse it from
  // the whole document rather than the Topic body.
  const header = parseHeaderFiles(markupContent);

  // Extract topic attributes
  const topicTypeMatch = markupContent.match(/<Topic[^>]*TopicType="([^"]+)"/);
  const topicStatusMatch = markupContent.match(/<Topic[^>]*TopicStatus="([^"]+)"/);

  // Extract topic elements
  const title = extractElement(topicContent, 'Title') || 'Untitled';
  const description = extractElement(topicContent, 'Description');
  const priority = extractElement(topicContent, 'Priority');
  const index = extractElement(topicContent, 'Index');
  const creationDate = extractElement(topicContent, 'CreationDate') || new Date().toISOString();
  const creationAuthor = extractElement(topicContent, 'CreationAuthor') || 'Unknown';
  const modifiedDate = extractElement(topicContent, 'ModifiedDate');
  const modifiedAuthor = extractElement(topicContent, 'ModifiedAuthor');
  const dueDate = extractElement(topicContent, 'DueDate');
  const assignedTo = extractElement(topicContent, 'AssignedTo');
  const stage = extractElement(topicContent, 'Stage');

  // Extract labels
  const labels: string[] = [];
  const labelMatches = topicContent.matchAll(/<Labels>([^<]+)<\/Labels>/g);
  for (const match of labelMatches) {
    labels.push(unescapeXml(match[1]));
  }

  // Extract BIM snippet
  const bimSnippet = extractBimSnippet(topicContent);

  // Extract document references
  const documentReferences = extractDocumentReferences(topicContent);

  // Extract related topics
  const relatedTopics: string[] = [];
  const relatedMatches = topicContent.matchAll(/<RelatedTopic\s+Guid="([^"]+)"/g);
  for (const match of relatedMatches) {
    relatedTopics.push(match[1]);
  }

  // Parse comments
  const comments = parseComments(markupContent);

  // Parse viewpoints
  const viewpoints = await parseViewpoints(zip, topicFolder, markupContent, budget);

  return {
    guid,
    title,
    description,
    topicType: topicTypeMatch?.[1],
    topicStatus: topicStatusMatch?.[1],
    priority,
    index: index ? parseInt(index, 10) : undefined,
    creationDate,
    creationAuthor,
    modifiedDate,
    modifiedAuthor,
    dueDate,
    assignedTo,
    stage,
    labels: labels.length > 0 ? labels : undefined,
    bimSnippet,
    documentReferences: documentReferences.length > 0 ? documentReferences : undefined,
    relatedTopics: relatedTopics.length > 0 ? relatedTopics : undefined,
    comments,
    viewpoints,
    header: header.length > 0 ? header : undefined,
  };
}

/**
 * Parse the markup `<Header>` block into source-file references.
 *
 * Tolerant of both BCF versions: 2.1 nests `<File>` directly under `<Header>`
 * and 3.0 wraps them in `<Files>`, so we match every `<File>` inside the header
 * regardless of the wrapper.
 */
function parseHeaderFiles(markupContent: string): BCFHeaderFile[] {
  const headerMatch = markupContent.match(/<Header>([\s\S]*?)<\/Header>/);
  if (!headerMatch) return [];

  const files: BCFHeaderFile[] = [];
  const fileMatches = headerMatch[1].matchAll(/<File\b([^>]*?)(?:\/>|>([\s\S]*?)<\/File>)/g);
  for (const match of fileMatches) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';

    const ifcProject = attrs.match(/IfcProject="([^"]*)"/)?.[1];
    const ifcSpatial = attrs.match(/IfcSpatialStructureElement="([^"]*)"/)?.[1];
    // BCF 2.1 spells this `isExternal`, 3.0 `IsExternal`; accept either casing
    // (and the xs:boolean `1`/`0` forms a foreign tool may emit).
    const isExternalRaw = attrs.match(/\b[Ii]sExternal="([^"]*)"/)?.[1];

    files.push({
      ifcProject: ifcProject || undefined,
      ifcSpatialStructureElement: ifcSpatial || undefined,
      isExternal: isExternalRaw === undefined ? undefined : (isExternalRaw === 'true' || isExternalRaw === '1'),
      filename: extractElement(body, 'Filename'),
      date: extractElement(body, 'Date'),
      reference: extractElement(body, 'Reference'),
    });
  }

  return files;
}

/**
 * Extract a simple element value from XML
 *
 * Values are unescaped so writer.ts's escapeXml() round-trips correctly
 * (see escapeXml/unescapeXml regression: & < > " ' in titles/descriptions/
 * comments must come back exactly as written, not as literal entities).
 */
function extractElement(content: string, elementName: string): string | undefined {
  const match = content.match(new RegExp(`<${elementName}>([^<]*)<\\/${elementName}>`));
  return match?.[1] !== undefined ? unescapeXml(match[1]) : undefined;
}

/**
 * Unescape XML entities produced by writer.ts's escapeXml()
 *
 * &amp; must be decoded last so a literal "&lt;" written as "&amp;lt;"
 * doesn't get corrupted into "<" by an earlier pass.
 */
function unescapeXml(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Extract BIM snippet from topic content
 */
function extractBimSnippet(content: string): BCFBimSnippet | undefined {
  const match = content.match(/<BimSnippet\s+SnippetType="([^"]+)"[^>]*>([\s\S]*?)<\/BimSnippet>/);
  if (!match) return undefined;

  const isExternalMatch = match[0].match(/isExternal="([^"]+)"/);
  const reference = extractElement(match[2], 'Reference');
  const referenceSchema = extractElement(match[2], 'ReferenceSchema');

  return {
    snippetType: match[1],
    isExternal: isExternalMatch?.[1] === 'true',
    reference: reference || '',
    referenceSchema,
  };
}

/**
 * Extract document references from topic content
 */
function extractDocumentReferences(content: string): BCFDocumentReference[] {
  const refs: BCFDocumentReference[] = [];
  const matches = content.matchAll(/<DocumentReference[^>]*>([\s\S]*?)<\/DocumentReference>/g);

  for (const match of matches) {
    const guidMatch = match[0].match(/Guid="([^"]+)"/);
    const isExternalMatch = match[0].match(/isExternal="([^"]+)"/);
    const referencedDoc = extractElement(match[1], 'ReferencedDocument');
    const description = extractElement(match[1], 'Description');

    if (referencedDoc) {
      refs.push({
        guid: guidMatch?.[1],
        isExternal: isExternalMatch?.[1] === 'true',
        referencedDocument: referencedDoc,
        description,
      });
    }
  }

  return refs;
}

/**
 * Parse comments from markup.bcf
 *
 * The outer `<Comment Guid="...">` wrapper contains a nested `<Comment>text</Comment>`
 * field with the SAME tag name (see writer.ts writeMarkupFile). A naive non-greedy
 * `[\s\S]*?<\/Comment>` stops at the first `</Comment>` it sees, which is the inner
 * field's closer, not the wrapper's -- truncating every comment to an empty string.
 *
 * Rather than guess what token follows a comment (which varies by BCF version and
 * vendor: `<Viewpoints>` in 2.1 schema order, `</Comments>` in 3.0, `</Markup>`, or
 * a vendor-extension element), we slice each wrapper's span from its own opening tag
 * to the NEXT wrapper opening (or end of content) and take the last `</Comment>` in
 * that span as the wrapper's real closer. That is robust across BCF 2.1/3.0 and
 * tolerates unknown sibling elements, so no comment is silently dropped.
 */
function parseComments(markupContent: string): BCFComment[] {
  const comments: BCFComment[] = [];

  // Collect every top-level comment-wrapper opening tag and where its body starts.
  const openRe = /<Comment\s+Guid="([^"]+)"[^>]*>/g;
  const opens: { guid: string; tagStart: number; bodyStart: number }[] = [];
  for (let m = openRe.exec(markupContent); m; m = openRe.exec(markupContent)) {
    opens.push({ guid: m[1], tagStart: m.index, bodyStart: m.index + m[0].length });
  }

  for (let i = 0; i < opens.length; i++) {
    const spanEnd = i + 1 < opens.length ? opens[i + 1].tagStart : markupContent.length;
    const span = markupContent.slice(opens[i].bodyStart, spanEnd);
    // The wrapper's own closer is the last </Comment> before the next wrapper/end;
    // the nested text field's closer comes earlier. (</Comments> does not match
    // </Comment> because of the trailing 's', so the 3.0 container is not confused
    // for a wrapper close.)
    const close = span.lastIndexOf('</Comment>');
    if (close < 0) continue; // malformed: no wrapper closer, skip rather than throw
    const content = span.slice(0, close);

    const date = extractElement(content, 'Date') || new Date().toISOString();
    const author = extractElement(content, 'Author') || 'Unknown';
    const comment = extractElement(content, 'Comment') || '';
    const modifiedDate = extractElement(content, 'ModifiedDate');
    const modifiedAuthor = extractElement(content, 'ModifiedAuthor');

    // Extract viewpoint reference
    const viewpointMatch = content.match(/<Viewpoint\s+Guid="([^"]+)"/);

    comments.push({
      guid: opens[i].guid,
      date,
      author,
      comment,
      viewpointGuid: viewpointMatch?.[1],
      modifiedDate,
      modifiedAuthor,
    });
  }

  return comments;
}

/**
 * Parse viewpoints from the BCF archive
 */
async function parseViewpoints(
  zip: JSZip,
  topicFolder: string,
  markupContent: string,
  budget: ExpansionBudget
): Promise<BCFViewpoint[]> {
  const viewpoints: BCFViewpoint[] = [];

  // Parse viewpoint references from markup.bcf to get snapshot filenames
  // Format: <Viewpoint Guid="xxx"><Viewpoint>filename.bcfv</Viewpoint><Snapshot>snapshot.png</Snapshot></Viewpoint>
  const viewpointInfoMap = new Map<string, { viewpointFile?: string; snapshotFile?: string }>();

  // Match full viewpoint elements with both viewpoint and snapshot references
  const viewpointElementRegex = /<Viewpoint\s+Guid="([^"]+)"[^>]*>([\s\S]*?)<\/Viewpoint>/g;
  for (const match of markupContent.matchAll(viewpointElementRegex)) {
    const guid = match[1];
    const content = match[2];

    const viewpointFileMatch = content.match(/<Viewpoint>([^<]+)<\/Viewpoint>/);
    const snapshotFileMatch = content.match(/<Snapshot>([^<]+)<\/Snapshot>/);

    viewpointInfoMap.set(guid, {
      viewpointFile: viewpointFileMatch?.[1],
      snapshotFile: snapshotFileMatch?.[1],
    });
  }

  // Also match self-closing viewpoint references
  const simpleViewpointRefs = markupContent.matchAll(/<Viewpoint\s+Guid="([^"]+)"[^>]*\/>/g);
  for (const match of simpleViewpointRefs) {
    if (!viewpointInfoMap.has(match[1])) {
      viewpointInfoMap.set(match[1], {});
    }
  }

  // Find viewpoint files directly in the folder
  const viewpointFiles: string[] = [];
  zip.forEach((relativePath: string) => {
    if (relativePath.startsWith(`${topicFolder}/`) && relativePath.endsWith('.bcfv')) {
      viewpointFiles.push(relativePath);
    }
  });

  // Parse each viewpoint file
  for (const viewpointPath of viewpointFiles) {
    try {
      const viewpointFile = zip.file(viewpointPath);
      if (!viewpointFile) continue;

      const viewpointContent = await readEntryCapped(viewpointFile, 'string', budget);
      const viewpoint = parseViewpointContent(viewpointContent);

      if (viewpoint) {
        // Get snapshot filename from markup.bcf if available
        const viewpointInfo = viewpointInfoMap.get(viewpoint.guid);
        let snapshotFile: JSZip.JSZipObject | null = null;
        let snapshotFormat = 'png';

        // First, try the snapshot filename from markup.bcf
        if (viewpointInfo?.snapshotFile) {
          const snapshotPath = `${topicFolder}/${viewpointInfo.snapshotFile}`;
          snapshotFile = zip.file(snapshotPath);
          if (viewpointInfo.snapshotFile.toLowerCase().endsWith('.jpg') ||
              viewpointInfo.snapshotFile.toLowerCase().endsWith('.jpeg')) {
            snapshotFormat = 'jpeg';
          }
        }

        // Fallback: try common naming patterns
        if (!snapshotFile) {
          const viewpointBaseName = viewpointPath.replace('.bcfv', '');

          // Handle different naming conventions:
          // 1. Viewpoint_<guid>.bcfv -> Snapshot_<guid>.png (buildingSMART standard)
          // 2. <guid>_viewpoint.bcfv -> <guid>_snapshot.png (alternative pattern)
          // 3. viewpoint.bcfv -> snapshot.png (simple default)
          const snapshotBaseName1 = viewpointBaseName.replace(/Viewpoint_/i, 'Snapshot_');
          const snapshotBaseName2 = viewpointBaseName.replace(/_viewpoint$/i, '_snapshot');

          const pathsToTry = [
            // Pattern 1: Snapshot_<guid>.png
            `${snapshotBaseName1}.png`,
            // Pattern 2: <guid>_snapshot.png
            `${snapshotBaseName2}.png`,
            // Pattern 3: same name as viewpoint but .png
            `${viewpointBaseName}.png`,
            // Default: snapshot.png
            `${topicFolder}/snapshot.png`,
            // JPG variants
            `${snapshotBaseName1}.jpg`,
            `${snapshotBaseName2}.jpg`,
            `${viewpointBaseName}.jpg`,
            `${topicFolder}/snapshot.jpg`,
          ];

          for (const path of pathsToTry) {
            snapshotFile = zip.file(path);
            if (snapshotFile) {
              if (path.toLowerCase().endsWith('.jpg') || path.toLowerCase().endsWith('.jpeg')) {
                snapshotFormat = 'jpeg';
              }
              break;
            }
          }
        }

        if (snapshotFile) {
          const snapshotData = await readEntryCapped(snapshotFile, 'uint8array', budget);
          viewpoint.snapshotData = snapshotData;
          viewpoint.snapshot = `data:image/${snapshotFormat};base64,${uint8ArrayToBase64(snapshotData)}`;
        }

        viewpoints.push(viewpoint);
      }
    } catch (error) {
      if (error instanceof BCFResourceLimitError) throw error;
      console.warn(`Failed to parse viewpoint ${viewpointPath}:`, error);
    }
  }

  // If no viewpoint files found, check for default snapshot
  if (viewpoints.length === 0) {
    const defaultSnapshot = zip.file(`${topicFolder}/snapshot.png`) || zip.file(`${topicFolder}/snapshot.jpg`);
    if (defaultSnapshot) {
      const isJpg = defaultSnapshot.name.toLowerCase().endsWith('.jpg');
      const snapshotData = await readEntryCapped(defaultSnapshot, 'uint8array', budget);
      viewpoints.push({
        guid: topicFolder, // Use topic GUID as viewpoint GUID
        snapshot: `data:image/${isJpg ? 'jpeg' : 'png'};base64,${uint8ArrayToBase64(snapshotData)}`,
        snapshotData,
      });
    }
  }

  return viewpoints;
}

/**
 * Parse viewpoint XML content
 */
function parseViewpointContent(content: string): BCFViewpoint | null {
  // Extract viewpoint GUID from root element (Guid can be anywhere in the tag)
  const guidMatch = content.match(/<VisualizationInfo[^>]+Guid="([^"]+)"/);
  const guid = guidMatch?.[1] || crypto.randomUUID?.() || `vp-${Date.now()}`;

  // Parse perspective camera
  const perspectiveCamera = parsePerspectiveCamera(content);

  // Parse orthogonal camera
  const orthogonalCamera = parseOrthogonalCamera(content);

  // Parse components
  const components = parseComponents(content);

  // Parse lines
  const lines = parseLines(content);

  // Parse clipping planes
  const clippingPlanes = parseClippingPlanes(content);

  // Parse bitmaps
  const bitmaps = parseBitmaps(content);

  return {
    guid,
    perspectiveCamera,
    orthogonalCamera,
    components,
    lines: lines.length > 0 ? lines : undefined,
    clippingPlanes: clippingPlanes.length > 0 ? clippingPlanes : undefined,
    bitmaps: bitmaps.length > 0 ? bitmaps : undefined,
  };
}

/**
 * Parse perspective camera from viewpoint content
 */
function parsePerspectiveCamera(content: string): BCFPerspectiveCamera | undefined {
  const match = content.match(/<PerspectiveCamera>([\s\S]*?)<\/PerspectiveCamera>/);
  if (!match) return undefined;

  const cameraContent = match[1];

  const viewPoint = parsePoint(cameraContent, 'CameraViewPoint');
  const direction = parseDirection(cameraContent, 'CameraDirection');
  const upVector = parseDirection(cameraContent, 'CameraUpVector');
  const fieldOfView = extractElement(cameraContent, 'FieldOfView');

  if (!viewPoint || !direction || !upVector || !fieldOfView) {
    return undefined;
  }

  return {
    cameraViewPoint: viewPoint,
    cameraDirection: direction,
    cameraUpVector: upVector,
    fieldOfView: parseFloat(fieldOfView),
  };
}

/**
 * Parse orthogonal camera from viewpoint content
 */
function parseOrthogonalCamera(content: string): BCFOrthogonalCamera | undefined {
  const match = content.match(/<OrthogonalCamera>([\s\S]*?)<\/OrthogonalCamera>/);
  if (!match) return undefined;

  const cameraContent = match[1];

  const viewPoint = parsePoint(cameraContent, 'CameraViewPoint');
  const direction = parseDirection(cameraContent, 'CameraDirection');
  const upVector = parseDirection(cameraContent, 'CameraUpVector');
  const viewToWorldScale = extractElement(cameraContent, 'ViewToWorldScale');

  if (!viewPoint || !direction || !upVector || !viewToWorldScale) {
    return undefined;
  }

  return {
    cameraViewPoint: viewPoint,
    cameraDirection: direction,
    cameraUpVector: upVector,
    viewToWorldScale: parseFloat(viewToWorldScale),
  };
}

/**
 * Parse a 3D point from XML
 */
function parsePoint(content: string, elementName: string): BCFPoint | undefined {
  const match = content.match(new RegExp(`<${elementName}>([\\s\\S]*?)<\\/${elementName}>`));
  if (!match) return undefined;

  const x = extractElement(match[1], 'X');
  const y = extractElement(match[1], 'Y');
  const z = extractElement(match[1], 'Z');

  if (x === undefined || y === undefined || z === undefined) {
    return undefined;
  }

  return {
    x: parseFloat(x),
    y: parseFloat(y),
    z: parseFloat(z),
  };
}

/**
 * Parse a 3D direction from XML
 */
function parseDirection(content: string, elementName: string): BCFDirection | undefined {
  return parsePoint(content, elementName) as BCFDirection | undefined;
}

/**
 * Parse components (selection/visibility/coloring)
 */
function parseComponents(content: string): BCFComponents | undefined {
  const componentsMatch = content.match(/<Components>([\s\S]*?)<\/Components>/);
  if (!componentsMatch) return undefined;

  const componentsContent = componentsMatch[1];

  // Parse selection
  const selection = parseComponentList(componentsContent, 'Selection');

  // Parse visibility
  const visibility = parseVisibility(componentsContent);

  // Parse coloring
  const coloring = parseColoring(componentsContent);

  if (!selection && !visibility && !coloring) {
    return undefined;
  }

  return {
    selection: selection?.length ? selection : undefined,
    visibility,
    coloring: coloring?.length ? coloring : undefined,
  };
}

/**
 * Parse a list of components
 */
function parseComponentList(content: string, elementName: string): BCFComponent[] | undefined {
  const match = content.match(new RegExp(`<${elementName}>([\\s\\S]*?)<\\/${elementName}>`));
  if (!match) return undefined;

  const components: BCFComponent[] = [];
  const componentMatches = match[1].matchAll(/<Component[^>]*(?:\/>|>[\s\S]*?<\/Component>)/g);

  for (const compMatch of componentMatches) {
    const component = parseComponent(compMatch[0]);
    if (component) {
      components.push(component);
    }
  }

  return components.length > 0 ? components : undefined;
}

/**
 * Parse a single component
 */
function parseComponent(content: string): BCFComponent | undefined {
  const ifcGuidMatch = content.match(/IfcGuid="([^"]+)"/);
  const authoringToolIdMatch = content.match(/AuthoringToolId="([^"]+)"/);
  const originatingSystemMatch = content.match(/OriginatingSystem="([^"]+)"/);

  if (!ifcGuidMatch && !authoringToolIdMatch) {
    return undefined;
  }

  return {
    ifcGuid: ifcGuidMatch?.[1],
    authoringToolId: authoringToolIdMatch?.[1],
    originatingSystem: originatingSystemMatch?.[1],
  };
}

/**
 * Parse visibility settings
 */
function parseVisibility(content: string): BCFVisibility | undefined {
  const visibilityMatch = content.match(/<Visibility[^>]*>([\s\S]*?)<\/Visibility>/);
  if (!visibilityMatch) return undefined;

  const defaultVisMatch = content.match(/DefaultVisibility="([^"]+)"/);
  const defaultVisibility = defaultVisMatch?.[1] !== 'false';

  const exceptions = parseComponentList(visibilityMatch[1], 'Exceptions');

  return {
    defaultVisibility,
    exceptions,
  };
}

/**
 * Parse coloring settings
 */
function parseColoring(content: string): BCFColoring[] | undefined {
  const coloringMatch = content.match(/<Coloring>([\s\S]*?)<\/Coloring>/);
  if (!coloringMatch) return undefined;

  const colorings: BCFColoring[] = [];
  const colorMatches = coloringMatch[1].matchAll(/<Color\s+Color="([^"]+)"[^>]*>([\s\S]*?)<\/Color>/g);

  for (const match of colorMatches) {
    const color = match[1];
    const components: BCFComponent[] = [];
    const componentMatches = match[2].matchAll(/<Component[^>]*(?:\/>|>[\s\S]*?<\/Component>)/g);

    for (const compMatch of componentMatches) {
      const component = parseComponent(compMatch[0]);
      if (component) {
        components.push(component);
      }
    }

    if (components.length > 0) {
      colorings.push({ color, components });
    }
  }

  return colorings.length > 0 ? colorings : undefined;
}

/**
 * Parse lines
 */
function parseLines(content: string): BCFLine[] {
  const lines: BCFLine[] = [];
  const linesMatch = content.match(/<Lines>([\s\S]*?)<\/Lines>/);
  if (!linesMatch) return lines;

  const lineMatches = linesMatch[1].matchAll(/<Line>([\s\S]*?)<\/Line>/g);
  for (const match of lineMatches) {
    const startPoint = parsePoint(match[1], 'StartPoint');
    const endPoint = parsePoint(match[1], 'EndPoint');
    if (startPoint && endPoint) {
      lines.push({ startPoint, endPoint });
    }
  }

  return lines;
}

/**
 * Parse clipping planes
 */
function parseClippingPlanes(content: string): BCFClippingPlane[] {
  const planes: BCFClippingPlane[] = [];
  const planesMatch = content.match(/<ClippingPlanes>([\s\S]*?)<\/ClippingPlanes>/);
  if (!planesMatch) return planes;

  const planeMatches = planesMatch[1].matchAll(/<ClippingPlane>([\s\S]*?)<\/ClippingPlane>/g);
  for (const match of planeMatches) {
    const location = parsePoint(match[1], 'Location');
    const direction = parseDirection(match[1], 'Direction');
    if (location && direction) {
      planes.push({ location, direction });
    }
  }

  return planes;
}

/**
 * Parse bitmaps
 */
function parseBitmaps(content: string): BCFBitmap[] {
  const bitmaps: BCFBitmap[] = [];
  const bitmapsMatch = content.match(/<Bitmaps>([\s\S]*?)<\/Bitmaps>/);
  if (!bitmapsMatch) return bitmaps;

  const bitmapMatches = bitmapsMatch[1].matchAll(/<Bitmap>([\s\S]*?)<\/Bitmap>/g);
  for (const match of bitmapMatches) {
    const format = extractElement(match[1], 'Format') || extractElement(match[1], 'Bitmap');
    const reference = extractElement(match[1], 'Reference');
    const location = parsePoint(match[1], 'Location');
    const normal = parseDirection(match[1], 'Normal');
    const up = parseDirection(match[1], 'Up');
    const height = extractElement(match[1], 'Height');

    if (format && reference && location && normal && up && height) {
      bitmaps.push({
        format: format.toUpperCase() === 'JPG' ? 'JPG' : 'PNG',
        reference,
        location,
        normal,
        up,
        height: parseFloat(height),
      });
    }
  }

  return bitmaps;
}

/**
 * Convert Uint8Array to base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
