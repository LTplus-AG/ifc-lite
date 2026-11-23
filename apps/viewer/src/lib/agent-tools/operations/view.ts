/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JSONSchemaType } from 'ajv';
import type { CameraState, SectionPlane } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { resolveRef } from '../refs';
import { isToolAvailable } from '@/lib/features/tools';
import { viewerSdk } from './context';
import { operation, viewerOperation, emptySchema, pointSchema, referenceSchema, type OperationContext } from './contract';
import { disabled, invalidInput, unavailable } from './refusals';

const view = (id: string, owner: string, description: string) => ({
  id, owner, description, features: id.startsWith('section.') ? ['tools.section'] as const : undefined, effects: ['view'] as const, synchronous: true, capability: 'commands-and-edits' as const, implementation: 'sdk' as const,
});
const read = (id: string, owner: string, description: string) => ({
  id, owner, description, features: id.startsWith('section.') ? ['tools.section'] as const : undefined, effects: ['read'] as const, capability: 'read' as const, implementation: 'sdk' as const,
});
const refs = (input: { express_ids: number[] }, ctx: OperationContext) => input.express_ids.map(express_id => resolveRef(ctx.model, { express_id }));
const sectionSchema: JSONSchemaType<SectionPlane> = {
  type: 'object', properties: {
    axis: { type: 'string', enum: ['x', 'y', 'z'] }, position: { type: 'number' },
    enabled: { type: 'boolean' }, flipped: { type: 'boolean' },
    id: { type: 'string', nullable: true }, name: { type: 'string', nullable: true },
  }, required: ['axis', 'position', 'enabled', 'flipped'], additionalProperties: false,
};
const cameraSchema: JSONSchemaType<CameraState> = {
  type: 'object', properties: {
    mode: { type: 'string', enum: ['perspective', 'orthographic'] },
    position: { ...pointSchema, nullable: true }, target: { ...pointSchema, nullable: true }, up: { ...pointSchema, nullable: true },
  }, required: ['mode'], additionalProperties: false,
};
function sectionEnabled() {
  if (!isToolAvailable('section')) throw disabled('Section tools are disabled by the host.');
}

export const viewOperations = [
  viewerOperation(read('selection.read', 'hierarchy', 'Read renderer selection as model-qualified references.'), emptySchema,
    (_, c) => viewerSdk(c).viewer.getSelection()),
  operation({ ...view('selection.replace', 'hierarchy', 'Replace native selection after validating all entities.'), effects: ['selection'] }, referenceSchema,
    (i, c) => { c.model.bim.viewer.select(refs(i, c)); return viewerSdk(c).viewer.getSelection(); }),
  viewerOperation({ ...view('selection.clear', 'hierarchy', 'Clear native renderer selection.'), effects: ['selection'] }, emptySchema,
    (_, c) => { viewerSdk(c).viewer.deselect(); return viewerSdk(c).viewer.getSelection(); }),
  operation(view('visibility.hide', 'hierarchy', 'Hide validated model entities.'), referenceSchema,
    (i, c) => { const r = refs(i, c); c.model.bim.viewer.hide(r); return { applied: r }; }),
  operation(view('visibility.show', 'hierarchy', 'Show validated model entities.'), referenceSchema,
    (i, c) => { const r = refs(i, c); c.model.bim.viewer.show(r); return { applied: r }; }),
  operation(view('visibility.isolate', 'hierarchy', 'Isolate validated model entities.'), referenceSchema,
    (i, c) => { const r = refs(i, c); c.model.bim.viewer.isolate(r); return { applied: r }; }),
  viewerOperation(view('visibility.reset', 'hierarchy', 'Reset native visibility.'), emptySchema,
    (_, c) => { viewerSdk(c).viewer.resetVisibility(); return { applied: true }; }),
  operation({ ...view('camera.frame', 'viewport', 'Frame validated entities using the native camera adapter; animation may continue.'), completion: 'dispatched' }, referenceSchema,
    (i, c) => {
      const r = refs(i, c);
      if (!useViewerStore.getState().cameraCallbacks?.frameEntities) throw unavailable('A mounted viewport camera is required.');
      c.model.bim.viewer.flyTo(r); return { dispatched: true };
    }),
  viewerOperation(read('camera.read', 'viewport', 'Inspect native camera. Coordinates are renderer Y-up metres.'), emptySchema,
    (_, c) => viewerSdk(c).viewer.getCamera()),
  viewerOperation(view('camera.set', 'viewport', 'Set native camera in renderer Y-up metres.'), cameraSchema,
    (i, c) => {
      if (Object.values(i).some(value => value === null)) throw invalidInput('invalid-value', 'Camera values cannot be null.');
      if (!useViewerStore.getState().cameraCallbacks?.applyViewpoint) throw unavailable('A mounted viewport camera is required.');
      if (i.up?.every(value => value === 0)) throw invalidInput('invalid-value', 'Camera up vector must be nonzero.');
      if (i.position && i.target && i.position.every((value, index) => value === i.target?.[index])) throw invalidInput('invalid-value', 'Camera position and target must differ.');
      viewerSdk(c).viewer.setCamera(i); return viewerSdk(c).viewer.getCamera();
    }),
  viewerOperation(read('section.read', 'viewport', 'Inspect all cutting planes. Positions use renderer Y-up metres.'), emptySchema,
    (_, c) => viewerSdk(c).viewer.getSections()),
  viewerOperation<{ planes: SectionPlane[] }>(view('section.replace', 'viewport', 'Replace cutting planes in renderer Y-up metres. Empty list clears.'), {
    type: 'object', properties: { planes: { type: 'array', items: sectionSchema, maxItems: 8 } }, required: ['planes'], additionalProperties: false,
  } satisfies JSONSchemaType<{ planes: SectionPlane[] }>, (i, c) => {
    sectionEnabled(); viewerSdk(c).viewer.setSections(i.planes); return viewerSdk(c).viewer.getSections();
  }),
  viewerOperation(view('section.add', 'viewport', 'Add a cutting plane. Returns null when the host refuses the addition.'), sectionSchema,
    (i, c) => { sectionEnabled(); return { id: viewerSdk(c).viewer.addSection(i), planes: viewerSdk(c).viewer.getSections() }; }),
  viewerOperation<{ id: string }>(view('section.remove', 'viewport', 'Remove the cutting plane with this native ID.'), {
    type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['id'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string }>, (i, c) => { sectionEnabled(); return { removed: viewerSdk(c).viewer.removeSection(i.id) }; }),
  operation<{ express_ids: number[]; color: string }>(view('appearance.colorize', 'appearance', 'Apply a hex color override to validated model entities.'), {
    type: 'object', properties: { express_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 1000 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } },
    required: ['express_ids', 'color'], additionalProperties: false,
  } satisfies JSONSchemaType<{ express_ids: number[]; color: string }>, (i, c) => {
    const r = refs(i, c); c.model.bim.viewer.colorize(r, i.color); return { applied: r, color: i.color };
  }),
  operation(view('appearance.resetEntities', 'appearance', 'Reset color overrides for validated entities; empty list is a no-op.'), referenceSchema,
    (i, c) => { const r = refs(i, c); c.model.bim.viewer.resetColors(r); return { applied: r }; }),
  viewerOperation(view('appearance.resetAll', 'appearance', 'Reset every color override.'), emptySchema,
    (_, c) => { viewerSdk(c).viewer.resetColors(); return { applied: true }; }),
];
