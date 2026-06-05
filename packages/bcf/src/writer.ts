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
  BCFColoring,
  BCFPerspectiveCamera,
  BCFOrthogonalCamera,
  BCFLine,
  BCFClippingPlane,
  BCFBitmap,
  BCFPoint,
  BCFDirection,
} from './types.js';
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
    writeProjectFile(zip, project);
  }

  // Write topics
  for (const [guid, topic] of project.topics) {
    await writeTopicFolder(zip, topic);
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
 */
function writeVersionFile(zip: JSZip, version: '2.1' | '3.0'): void {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<Version xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" VersionId="${version}">
  <DetailedVersion>${version}</DetailedVersion>
</Version>`;

  zip.file('bcf.version', content);
}

/**
 * Write project.bcfp file
 * Uses buildingSMART standard format
 */
function writeProjectFile(zip: JSZip, project: BCFProject): void {
  const projectId = project.projectId || generateUuid();
  const nameElement = project.name ? `\n    <Name>${escapeXml(project.name)}</Name>` : '';

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<ProjectExtension xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Project ProjectId="${projectId}">${nameElement}
  </Project>
</ProjectExtension>`;

  zip.file('project.bcfp', content);
}

/**
 * Write a topic folder with all its contents
 */
async function writeTopicFolder(zip: JSZip, topic: BCFTopic): Promise<void> {
  const folder = zip.folder(topic.guid);
  if (!folder) return;

  // Write markup.bcf
  writeMarkupFile(folder, topic);

  // Write viewpoints
  for (let i = 0; i < topic.viewpoints.length; i++) {
    const viewpoint = topic.viewpoints[i];
    const isDefault = i === 0;
    await writeViewpointFiles(folder, viewpoint, isDefault);
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

/**
 * Write markup.bcf file
 * Uses buildingSMART standard format
 */
function writeMarkupFile(folder: JSZip, topic: BCFTopic): void {
  let content = `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Topic Guid="${escapeXml(topic.guid)}"${topic.topicType ? ` TopicType="${escapeXml(topic.topicType)}"` : ''}${topic.topicStatus ? ` TopicStatus="${escapeXml(topic.topicStatus)}"` : ''}>
    <Title>${escapeXml(topic.title)}</Title>`;

  if (topic.description) {
    content += `\n    <Description>${escapeXml(topic.description)}</Description>`;
  }

  if (topic.priority) {
    content += `\n    <Priority>${escapeXml(topic.priority)}</Priority>`;
  }

  if (topic.index !== undefined) {
    content += `\n    <Index>${topic.index}</Index>`;
  }

  content += `\n    <CreationDate>${escapeXml(topic.creationDate)}</CreationDate>`;
  content += `\n    <CreationAuthor>${escapeXml(topic.creationAuthor)}</CreationAuthor>`;

  if (topic.modifiedDate) {
    content += `\n    <ModifiedDate>${escapeXml(topic.modifiedDate)}</ModifiedDate>`;
    // BCF spec requires ModifiedAuthor when ModifiedDate is present
    const modifiedAuthor = topic.modifiedAuthor || topic.creationAuthor;
    content += `\n    <ModifiedAuthor>${escapeXml(modifiedAuthor)}</ModifiedAuthor>`;
  }

  if (topic.dueDate) {
    content += `\n    <DueDate>${escapeXml(topic.dueDate)}</DueDate>`;
  }

  if (topic.assignedTo) {
    content += `\n    <AssignedTo>${escapeXml(topic.assignedTo)}</AssignedTo>`;
  }

  if (topic.stage) {
    content += `\n    <Stage>${escapeXml(topic.stage)}</Stage>`;
  }

  if (topic.labels && topic.labels.length > 0) {
    for (const label of topic.labels) {
      content += `\n    <Labels>${escapeXml(label)}</Labels>`;
    }
  }

  if (topic.relatedTopics && topic.relatedTopics.length > 0) {
    for (const relatedGuid of topic.relatedTopics) {
      content += `\n    <RelatedTopic Guid="${escapeXml(relatedGuid)}"/>`;
    }
  }

  content += `\n  </Topic>`;

  // Write viewpoint references
  for (let i = 0; i < topic.viewpoints.length; i++) {
    const viewpoint = topic.viewpoints[i];
    // Use standard buildingSMART naming convention: Viewpoint_<guid>.bcfv
    const filename = `Viewpoint_${viewpoint.guid}.bcfv`;
    const snapshotName = `Snapshot_${viewpoint.guid}.${snapshotExt(viewpoint)}`;

    content += `\n  <Viewpoints Guid="${escapeXml(viewpoint.guid)}">`;
    content += `\n    <Viewpoint>${filename}</Viewpoint>`;
    if (viewpoint.snapshot || viewpoint.snapshotData) {
      content += `\n    <Snapshot>${snapshotName}</Snapshot>`;
    }
    content += `\n  </Viewpoints>`;
  }

  // Write comments
  for (const comment of topic.comments) {
    content += `\n  <Comment Guid="${escapeXml(comment.guid)}">`;
    content += `\n    <Date>${escapeXml(comment.date)}</Date>`;
    content += `\n    <Author>${escapeXml(comment.author)}</Author>`;
    content += `\n    <Comment>${escapeXml(comment.comment)}</Comment>`;
    if (comment.viewpointGuid) {
      content += `\n    <Viewpoint Guid="${escapeXml(comment.viewpointGuid)}"/>`;
    }
    if (comment.modifiedDate) {
      content += `\n    <ModifiedDate>${escapeXml(comment.modifiedDate)}</ModifiedDate>`;
    }
    if (comment.modifiedAuthor) {
      content += `\n    <ModifiedAuthor>${escapeXml(comment.modifiedAuthor)}</ModifiedAuthor>`;
    }
    content += `\n  </Comment>`;
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
  _isDefault: boolean
): Promise<void> {
  // Use standard buildingSMART naming convention: Viewpoint_<guid>.bcfv
  const filename = `Viewpoint_${viewpoint.guid}.bcfv`;
  const snapshotName = `Snapshot_${viewpoint.guid}.${snapshotExt(viewpoint)}`;

  // Write viewpoint XML - use buildingSMART standard format
  let content = `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" Guid="${escapeXml(viewpoint.guid)}">`;

  // Write components
  if (viewpoint.components) {
    content += writeComponents(viewpoint.components);
  }

  // Write perspective camera
  if (viewpoint.perspectiveCamera) {
    content += writePerspectiveCamera(viewpoint.perspectiveCamera);
  }

  // Write orthogonal camera
  if (viewpoint.orthogonalCamera) {
    content += writeOrthogonalCamera(viewpoint.orthogonalCamera);
  }

  // Write lines
  if (viewpoint.lines && viewpoint.lines.length > 0) {
    content += `\n  <Lines>`;
    for (const line of viewpoint.lines) {
      content += writeLine(line);
    }
    content += `\n  </Lines>`;
  }

  // Write clipping planes
  if (viewpoint.clippingPlanes && viewpoint.clippingPlanes.length > 0) {
    content += `\n  <ClippingPlanes>`;
    for (const plane of viewpoint.clippingPlanes) {
      content += writeClippingPlane(plane);
    }
    content += `\n  </ClippingPlanes>`;
  }

  // Write bitmaps
  if (viewpoint.bitmaps && viewpoint.bitmaps.length > 0) {
    content += `\n  <Bitmaps>`;
    for (const bitmap of viewpoint.bitmaps) {
      content += writeBitmap(bitmap);
    }
    content += `\n  </Bitmaps>`;
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
function writeComponents(components: BCFComponents): string {
  let content = `\n  <Components>`;

  // 1. Write ViewSetupHints (if present in visibility)
  if (components.visibility?.viewSetupHints) {
    const hints = components.visibility.viewSetupHints;
    content += `\n    <ViewSetupHints`;
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
  content += writeVisibility(components.visibility);

  // 4. Write coloring
  if (components.coloring && components.coloring.length > 0) {
    content += `\n    <Coloring>`;
    for (const coloring of components.coloring) {
      content += writeColoringEntry(coloring);
    }
    content += `\n    </Coloring>`;
  }

  content += `\n  </Components>`;
  return content;
}

/**
 * Write visibility XML
 *
 * Per BCF 2.1 schema:
 * - Visibility is REQUIRED inside Components
 * - DefaultVisibility attribute defaults to false
 * - Exceptions contains Component elements (entities to show/hide opposite of default)
 * - ViewSetupHints is NOT inside Visibility (moved to Components level)
 */
function writeVisibility(visibility: BCFVisibility | undefined): string {
  // Default visibility to true (show all) if not specified
  const defaultVis = visibility?.defaultVisibility ?? true;

  let content = `\n    <Visibility DefaultVisibility="${defaultVis}">`;

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
 */
function writeColoringEntry(coloring: BCFColoring): string {
  let content = `\n      <Color Color="${escapeXml(coloring.color)}">`;
  for (const component of coloring.components) {
    content += writeComponent(component, '        ');
  }
  content += `\n      </Color>`;
  return content;
}

/**
 * Write perspective camera XML
 */
function writePerspectiveCamera(camera: BCFPerspectiveCamera): string {
  return `\n  <PerspectiveCamera>
    <CameraViewPoint>
      <X>${camera.cameraViewPoint.x}</X>
      <Y>${camera.cameraViewPoint.y}</Y>
      <Z>${camera.cameraViewPoint.z}</Z>
    </CameraViewPoint>
    <CameraDirection>
      <X>${camera.cameraDirection.x}</X>
      <Y>${camera.cameraDirection.y}</Y>
      <Z>${camera.cameraDirection.z}</Z>
    </CameraDirection>
    <CameraUpVector>
      <X>${camera.cameraUpVector.x}</X>
      <Y>${camera.cameraUpVector.y}</Y>
      <Z>${camera.cameraUpVector.z}</Z>
    </CameraUpVector>
    <FieldOfView>${camera.fieldOfView}</FieldOfView>
  </PerspectiveCamera>`;
}

/**
 * Write orthogonal camera XML
 */
function writeOrthogonalCamera(camera: BCFOrthogonalCamera): string {
  return `\n  <OrthogonalCamera>
    <CameraViewPoint>
      <X>${camera.cameraViewPoint.x}</X>
      <Y>${camera.cameraViewPoint.y}</Y>
      <Z>${camera.cameraViewPoint.z}</Z>
    </CameraViewPoint>
    <CameraDirection>
      <X>${camera.cameraDirection.x}</X>
      <Y>${camera.cameraDirection.y}</Y>
      <Z>${camera.cameraDirection.z}</Z>
    </CameraDirection>
    <CameraUpVector>
      <X>${camera.cameraUpVector.x}</X>
      <Y>${camera.cameraUpVector.y}</Y>
      <Z>${camera.cameraUpVector.z}</Z>
    </CameraUpVector>
    <ViewToWorldScale>${camera.viewToWorldScale}</ViewToWorldScale>
  </OrthogonalCamera>`;
}

/**
 * Write line XML
 */
function writeLine(line: BCFLine): string {
  return `\n    <Line>
      <StartPoint>
        <X>${line.startPoint.x}</X>
        <Y>${line.startPoint.y}</Y>
        <Z>${line.startPoint.z}</Z>
      </StartPoint>
      <EndPoint>
        <X>${line.endPoint.x}</X>
        <Y>${line.endPoint.y}</Y>
        <Z>${line.endPoint.z}</Z>
      </EndPoint>
    </Line>`;
}

/**
 * Write clipping plane XML
 */
function writeClippingPlane(plane: BCFClippingPlane): string {
  return `\n    <ClippingPlane>
      <Location>
        <X>${plane.location.x}</X>
        <Y>${plane.location.y}</Y>
        <Z>${plane.location.z}</Z>
      </Location>
      <Direction>
        <X>${plane.direction.x}</X>
        <Y>${plane.direction.y}</Y>
        <Z>${plane.direction.z}</Z>
      </Direction>
    </ClippingPlane>`;
}

/**
 * Write bitmap XML
 */
function writeBitmap(bitmap: BCFBitmap): string {
  return `\n    <Bitmap>
      <Format>${bitmap.format}</Format>
      <Reference>${escapeXml(bitmap.reference)}</Reference>
      <Location>
        <X>${bitmap.location.x}</X>
        <Y>${bitmap.location.y}</Y>
        <Z>${bitmap.location.z}</Z>
      </Location>
      <Normal>
        <X>${bitmap.normal.x}</X>
        <Y>${bitmap.normal.y}</Y>
        <Z>${bitmap.normal.z}</Z>
      </Normal>
      <Up>
        <X>${bitmap.up.x}</X>
        <Y>${bitmap.up.y}</Y>
        <Z>${bitmap.up.z}</Z>
      </Up>
      <Height>${bitmap.height}</Height>
    </Bitmap>`;
}

/**
 * Escape XML special characters
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
