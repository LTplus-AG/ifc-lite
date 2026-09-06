/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parsing of a single BCFV viewpoint file's XML content: the two camera
 * shapes, the shared point/direction primitive, and the geometry overlays
 * (lines, clipping planes, bitmaps). Split out of reader.ts, which still owns
 * the zip-level orchestration (locating .bcfv files, resolving snapshots) that
 * calls into {@link parseViewpointContent}.
 */

import { extractElement } from './xml-text.js';
import type {
  BCFViewpoint,
  BCFPerspectiveCamera,
  BCFOrthogonalCamera,
  BCFLine,
  BCFClippingPlane,
  BCFBitmap,
  BCFPoint,
  BCFDirection,
} from './types.js';
import { parseFiniteFloat } from './numeric.js';
import { parseComponents } from './reader-components.js';

/**
 * Parse viewpoint XML content
 */
export function parseViewpointContent(content: string, versionId: '2.1' | '3.0'): BCFViewpoint | null {
  // Extract viewpoint GUID from root element (Guid can be anywhere in the tag)
  const guidMatch = content.match(/<VisualizationInfo[^>]+Guid="([^"]+)"/);
  const guid = guidMatch?.[1] || crypto.randomUUID?.() || `vp-${Date.now()}`;

  // Parse perspective camera
  const perspectiveCamera = parsePerspectiveCamera(content);

  // Parse orthogonal camera
  const orthogonalCamera = parseOrthogonalCamera(content);

  // Parse components
  const components = parseComponents(content, versionId);

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

  // Same treatment as the coordinates: an unusable scalar is a missing one.
  // `fieldOfView` is converted to radians and handed to the viewer camera,
  // and the parser already drops the whole camera when the element is absent.
  const fov = parseFiniteFloat(fieldOfView);
  if (fov === undefined) return undefined;

  return {
    cameraViewPoint: viewPoint,
    cameraDirection: direction,
    cameraUpVector: upVector,
    fieldOfView: fov,
    ...parseAspectRatio(cameraContent),
  };
}

/**
 * Parse the optional `<AspectRatio>` of either camera type.
 *
 * BCF 3.0's visinfo.xsd makes `AspectRatio` (a `PositiveDouble`) a REQUIRED
 * child of both camera types; BCF 2.1 has no such element. It is read here for
 * both, since the element's presence — not the archive's declared version — is
 * what says whether there is a value to keep.
 *
 * Reading it matters beyond fidelity: the writer refuses to emit a 3.0 camera
 * without one, so a 3.0 archive from another tool could otherwise be read and
 * then not written back. Returned as a spread-able partial so an absent or
 * unusable value leaves the property off entirely rather than setting it to
 * `undefined`, and a non-positive value is dropped rather than carried into
 * output the schema would reject.
 */
function parseAspectRatio(cameraContent: string): { aspectRatio?: number } {
  const raw = extractElement(cameraContent, 'AspectRatio');
  if (!raw) return {};
  const value = parseFiniteFloat(raw);
  if (value === undefined || !(value > 0)) return {};
  return { aspectRatio: value };
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

  // `viewToWorldScale` becomes the orthographic half-height, which is the
  // value `getOrthoSize()` hands back into a saved viewpoint — so a
  // non-finite one persists past the session if it is allowed in (#2461).
  const scale = parseFiniteFloat(viewToWorldScale);
  if (scale === undefined) return undefined;

  return {
    cameraViewPoint: viewPoint,
    cameraDirection: direction,
    cameraUpVector: upVector,
    viewToWorldScale: scale,
    ...parseAspectRatio(cameraContent),
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

  // A coordinate that is not a real number is treated as a missing one.
  // `parseFloat` has no out-of-band failure value — `"NaN"` parses to `NaN`
  // and the well-formed literal `"1e999"` parses to `Infinity` — and from here
  // the value reaches `Camera.setPosition`/`setTarget`, which store a pose
  // verbatim by design. Once stored, a single non-finite coordinate spreads
  // across the whole pose on the next gesture. Rejecting at the file boundary
  // means it never gets there, and it costs no new branch: every caller
  // already drops the thing it was parsing when a coordinate is missing
  // (#2466).
  const px = parseFiniteFloat(x);
  const py = parseFiniteFloat(y);
  const pz = parseFiniteFloat(z);

  if (px === undefined || py === undefined || pz === undefined) {
    return undefined;
  }

  return { x: px, y: py, z: pz };
}

/**
 * Parse a 3D direction from XML
 */
function parseDirection(content: string, elementName: string): BCFDirection | undefined {
  return parsePoint(content, elementName) as BCFDirection | undefined;
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
 *
 * The two BCF versions diverge in shape (see writer.ts's writeBitmap/
 * writeViewpointFiles for the write side of this):
 * - BCF 3.0: entries sit inside a `<Bitmaps>` wrapper, and the per-entry
 *   format element is named `<Format>`. No tag inside an entry shares the
 *   entry's own name, so a plain non-greedy `<Bitmap>...</Bitmap>` match
 *   is unambiguous.
 * - BCF 2.1: entries sit DIRECTLY under `<VisualizationInfo>` (no wrapper),
 *   and the format element is confusingly also named `<Bitmap>`, nested one
 *   level inside the entry (`<Bitmap><Bitmap>PNG</Bitmap><Reference>...`).
 *   A naive non-greedy `<Bitmap>...</Bitmap>` match on that shape terminates
 *   at the FIRST `</Bitmap>` it sees -- the inner format tag's closing tag,
 *   not the entry's -- and silently drops the rest of the entry. It must be
 *   matched with an explicit two-level pattern instead.
 */
function parseBitmaps(content: string): BCFBitmap[] {
  const bitmaps: BCFBitmap[] = [];
  const bitmapsMatch = content.match(/<Bitmaps>([\s\S]*?)<\/Bitmaps>/);

  const pushBitmap = (format: string | undefined, body: string) => {
    const reference = extractElement(body, 'Reference');
    const location = parsePoint(body, 'Location');
    const normal = parseDirection(body, 'Normal');
    const up = parseDirection(body, 'Up');
    const height = extractElement(body, 'Height');
    const parsedHeight = height === undefined ? undefined : parseFiniteFloat(height);

    if (format && reference && location && normal && up && parsedHeight !== undefined) {
      bitmaps.push({
        format: format.toUpperCase() === 'JPG' ? 'JPG' : 'PNG',
        reference,
        location,
        normal,
        up,
        height: parsedHeight,
      });
    }
  };

  if (bitmapsMatch) {
    // BCF 3.0 shape: <Bitmaps><Bitmap><Format>...</Format>...</Bitmap>...</Bitmaps>
    for (const match of bitmapsMatch[1].matchAll(/<Bitmap>([\s\S]*?)<\/Bitmap>/g)) {
      pushBitmap(extractElement(match[1], 'Format'), match[1]);
    }
  } else {
    // BCF 2.1 shape: <Bitmap><Bitmap>PNG</Bitmap>...</Bitmap>, unwrapped,
    // directly under VisualizationInfo.
    for (const match of content.matchAll(
      /<Bitmap>\s*<Bitmap>([\s\S]*?)<\/Bitmap>([\s\S]*?)<\/Bitmap>/g,
    )) {
      pushBitmap(match[1], match[2]);
    }
  }

  return bitmaps;
}
