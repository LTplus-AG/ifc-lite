/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  BCFBitmap, BCFBimSnippet, BCFClippingPlane, BCFColoring, BCFComment, BCFComponent, BCFComponents,
  BCFDocumentReference, BCFExtensions, BCFHeaderFile, BCFLine, BCFOrthogonalCamera, BCFPerspectiveCamera,
  BCFPoint, BCFProject, BCFTopic, BCFViewpoint, BCFViewSetupHints, BCFVisibility,
} from '@ifc-lite/bcf';

export const BCF_PROJECT_LIMIT = 32 * 1024 * 1024;
export type BcfProjectEncoding = { ok: true; data: string } | { ok: false; reason: 'too-large' | 'invalid' };

type Check = (value: unknown) => boolean;
type RecordValue = Record<string, unknown>;
type SavedViewpoint = Omit<BCFViewpoint, 'snapshotData'> & { snapshotData?: string };
type SavedTopic = Omit<BCFTopic, 'viewpoints'> & { viewpoints: SavedViewpoint[] };
type SavedProject = Omit<BCFProject, 'topics'> & { topics: SavedTopic[] };

const record = (v: unknown): v is RecordValue =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const text = (v: unknown): v is string => typeof v === 'string';
const guid = (v: unknown) => text(v) && v.length > 0;
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const boolean = (v: unknown) => typeof v === 'boolean';
const optional = (check: Check): Check => v => v === undefined || check(v);
const list = (check: Check): Check => v => Array.isArray(v) && v.every(check);
function shape<T>(fields: { [K in keyof T]-?: Check }) {
  const checks = Object.entries<Check>(fields);
  return (v: unknown): v is T => record(v) && checks.every(([key, check]) => check(Object.hasOwn(v, key) ? v[key] : undefined));
}

const optionalText = optional(text);
const optionalTexts = optional(list(text));
const extensions = shape<BCFExtensions>({
  topicTypes: optionalTexts, topicStatuses: optionalTexts, priorities: optionalTexts,
  topicLabels: optionalTexts, users: optionalTexts, stages: optionalTexts,
});
const point = shape<BCFPoint>({ x: number, y: number, z: number });
const camera = { cameraViewPoint: point, cameraDirection: point, cameraUpVector: point, aspectRatio: optional(number) };
const perspective = shape<BCFPerspectiveCamera>({ ...camera, fieldOfView: number });
const orthogonal = shape<BCFOrthogonalCamera>({ ...camera, viewToWorldScale: number });
const component = shape<BCFComponent>({ ifcGuid: optionalText, authoringToolId: optionalText, originatingSystem: optionalText });
const viewHints = shape<BCFViewSetupHints>({
  spacesVisible: optional(boolean), spaceBoundariesVisible: optional(boolean), openingsVisible: optional(boolean),
});
const visibility = shape<BCFVisibility>({
  defaultVisibility: boolean, exceptions: optional(list(component)), viewSetupHints: optional(viewHints),
});
const coloring = shape<BCFColoring>({ color: text, components: list(component) });
const components = shape<BCFComponents>({
  selection: optional(list(component)), visibility: optional(visibility), coloring: optional(list(coloring)),
});
const line = shape<BCFLine>({ startPoint: point, endPoint: point });
const plane = shape<BCFClippingPlane>({ location: point, direction: point });
const bitmap = shape<BCFBitmap>({
  format: v => v === 'PNG' || v === 'JPG', reference: text, location: point, normal: point, up: point, height: number,
});
const base64 = (v: unknown) => text(v) && v.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(v);
const viewpoint = shape<SavedViewpoint>({
  guid, perspectiveCamera: optional(perspective), orthogonalCamera: optional(orthogonal), lines: optional(list(line)),
  clippingPlanes: optional(list(plane)), bitmaps: optional(list(bitmap)), snapshot: optionalText,
  snapshotData: optional(base64), components: optional(components),
});
const comment = shape<BCFComment>({
  guid, date: optionalText, author: optionalText, comment: text, viewpointGuid: optionalText,
  modifiedDate: optionalText, modifiedAuthor: optionalText,
});
const header = shape<BCFHeaderFile>({
  ifcProject: optionalText, ifcSpatialStructureElement: optionalText, isExternal: optional(boolean),
  filename: optionalText, date: optionalText, reference: optionalText,
});
const snippet = shape<BCFBimSnippet>({ snippetType: text, isExternal: boolean, reference: text, referenceSchema: optionalText });
const documentReference = shape<BCFDocumentReference>({
  guid: optionalText, isExternal: optional(boolean), referencedDocument: optionalText,
  documentGuid: optionalText, url: optionalText, description: optionalText,
});
const topic = shape<SavedTopic>({
  guid, title: text, description: optionalText, topicType: optionalText, topicStatus: optionalText, priority: optionalText,
  index: optional(number), creationDate: optionalText, creationAuthor: optionalText, modifiedDate: optionalText,
  modifiedAuthor: optionalText, dueDate: optionalText, assignedTo: optionalText, stage: optionalText, labels: optionalTexts,
  bimSnippet: optional(snippet), documentReferences: optional(list(documentReference)), relatedTopics: optionalTexts,
  comments: list(comment), viewpoints: list(viewpoint), header: optional(list(header)),
});
const project = shape<SavedProject>({
  version: v => v === '2.1' || v === '3.0', projectId: optionalText, name: optionalText,
  extensions: optional(extensions), topics: list(topic),
});

function parseProject(data: string): SavedProject | null {
  const value: unknown = JSON.parse(data);
  if (!record(value) || value.version !== 1 || !project(value.project)) return null;
  const saved = value.project;
  if (new Set(saved.topics.map(item => item.guid)).size !== saved.topics.length) return null;
  return saved;
}

export function decodeBcfProject(data: unknown): BCFProject | null {
  try {
    if (!text(data) || data.length > BCF_PROJECT_LIMIT || new Blob([data]).size > BCF_PROJECT_LIMIT) return null;
    const saved = parseProject(data);
    if (!saved) return null;
    const topics = new Map<string, BCFTopic>();
    for (const item of saved.topics) {
      topics.set(item.guid, { ...item, viewpoints: item.viewpoints.map(({ snapshotData, ...view }) => ({
        ...view, ...(snapshotData === undefined ? {} : { snapshotData: Uint8Array.from(atob(snapshotData), c => c.charCodeAt(0)) }),
      })) });
    }
    return { ...saved, topics };
  } catch (error) {
    console.warn('[BCF autosave] Project could not be decoded', error);
    return null;
  }
}

function encodeBytes(bytes: Uint8Array): string {
  const parts: string[] = [];
  // Use multiples of three so only the last chunk can need base64 padding.
  for (let i = 0; i < bytes.length; i += 12_288) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 12_288))));
  }
  return parts.join('');
}

export function encodeBcfProject(value: BCFProject): BcfProjectEncoding {
  let measured = 0;
  const tooLarge = new Error('BCF project exceeds the size limit');
  const count = (length: number) => {
    measured += length;
    if (measured > BCF_PROJECT_LIMIT) throw tooLarge;
  };
  try {
    for (const [id, item] of value.topics) if (id !== item.guid) return { ok: false, reason: 'invalid' };
    const data = JSON.stringify({ version: 1, project: { ...value, topics: [...value.topics.values()] } }, function (this: unknown, key, field: unknown) {
      // Bound work before allocating the full JSON string or expanding binary snapshots.
      count(Array.isArray(this) ? 1 : key.length + 1);
      if (field instanceof Uint8Array) {
        count(Math.ceil(field.length / 3) * 4);
        return encodeBytes(field);
      }
      if (text(field)) count(field.length);
      return field;
    });
    if (new Blob([data]).size > BCF_PROJECT_LIMIT) return { ok: false, reason: 'too-large' };
    return parseProject(data) ? { ok: true, data } : { ok: false, reason: 'invalid' };
  } catch (error) {
    if (error === tooLarge) return { ok: false, reason: 'too-large' };
    console.warn('[BCF autosave] Project could not be encoded', error);
    return { ok: false, reason: 'invalid' };
  }
}
