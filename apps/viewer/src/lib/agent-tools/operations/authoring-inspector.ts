/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { rectangleSides, type AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import { operation, viewerOperation, emptySchema } from './contract';
import { assertToolActive } from '../cancellation';
import { resolveRef } from '../refs';
import { invalidInput, stale, decodedInput, parseJsonInput } from './refusals';
const kinds: AuthoredElementKind[] = ['wall', 'slab', 'beam', 'column', 'door', 'window', 'space', 'roof', 'plate', 'member'];
const kindSchema = { type: 'string' as const, enum: kinds };
const outputSchema = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
const meta = (id: string, description: string, model = false) => ({ id, owner: 'model', description, effects: model ? ['model'] as const : ['configuration'] as const,
  capability: 'commands-and-edits' as const, implementation: 'native-store' as const, outputSchema, policy: model ? { model: 'native-reviewed' as const } : undefined });
function expected(value: string) { if (JSON.stringify(useViewerStore.getState().authoringDefaults) !== value) throw stale('Authoring defaults changed. Inspect them again.'); }
export const inspectorOperations = [
  viewerOperation({ ...meta('authoring.defaults.read', 'Read the exact native per-kind dimensions, type/layer picks, profile choices, drawing modes and Room defaults.'), effects: ['read'], capability: 'read' }, emptySchema, () => out({ defaults: useViewerStore.getState().authoringDefaults, expected_defaults: JSON.stringify(useViewerStore.getState().authoringDefaults) })),
  operation<{ kind: AuthoredElementKind; Name: string; express_id: number }>(meta('authoring.type.create', 'Create a native element type through the Model inspector transaction. express_id=0 creates only the type; otherwise native typing and inherited layer-set behavior apply to that validated element.', true), {
    type: 'object', properties: { kind: kindSchema, Name: { type: 'string', minLength: 1, maxLength: 240 }, express_id: { type: 'integer', minimum: 0 } }, required: ['kind', 'Name', 'express_id'], additionalProperties: false,
  }, async (i, c) => { const { createElementType } = await import('@/components/viewer/model-inspector/inspector-edits'); if (i.express_id) resolveRef(c.model, { express_id: i.express_id }); assertToolActive(c);
    const id = c.commit(() => { const created = createElementType(c.model.id, i.kind, i.Name, i.express_id || undefined); if (created === null) throw invalidInput('refused', 'The native inspector refused this type creation.'); return created; }); return out({ modelId: c.model.id, expressId: id });
  }),
  operation<{ express_id: number; Name: string; Color: string; Category: string; Description: string }>(meta('authoring.material.createAndAssign', 'Create and assign a material using the same native Model-inspector transaction, including supported color/category/description.', true), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 }, Name: { type: 'string', minLength: 1, maxLength: 240 }, Color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, Category: { type: 'string', maxLength: 240 }, Description: { type: 'string', maxLength: 2000 } }, required: ['express_id', 'Name', 'Color', 'Category', 'Description'], additionalProperties: false,
  }, async (i, c) => { const { setElementMaterial } = await import('@/components/viewer/model-inspector/inspector-edits'); const ref = resolveRef(c.model, { express_id: i.express_id }); assertToolActive(c);
    c.commit(() => {
      const changed = setElementMaterial(c.model.id, ref.expressId, { Name: i.Name, Color: i.Color, Category: i.Category, Description: i.Description });
      if (!changed) throw invalidInput('refused', 'The native inspector refused this material edit.');
    });
    return out({ changed: true });
  }),
  viewerOperation<{ kind: AuthoredElementKind; field: string; metres: number; expected_defaults: string }>(meta('authoring.defaults.dimension', 'Set one existing native default dimension in metres, preserving the command HUD/inspector’s shared state.'), {
    type: 'object', properties: { kind: kindSchema, field: { type: 'string', minLength: 1, maxLength: 100 }, metres: { type: 'number', minimum: -1000000, maximum: 1000000 }, expected_defaults: { type: 'string', maxLength: 200000 } }, required: ['kind', 'field', 'metres', 'expected_defaults'], additionalProperties: false,
  }, (i, c) => out(c.commit(() => { const s = useViewerStore.getState(); if (!Object.hasOwn(s.authoringDefaults.dims[i.kind], i.field)) throw invalidInput('unknown-target', 'Unknown native dimension.'); expected(i.expected_defaults);
    // A beam's Bottom is an offset and may be anything; a sill may sit on the floor; sizes must be positive (#10793).
    if (i.field !== 'Bottom' && (i.field === 'SillHeight' ? i.metres < 0 : i.metres <= 0)) throw invalidInput('invalid-value', 'A native construction dimension must be positive (a SillHeight may be zero).'); s.setAuthoringDims(i.kind, { [i.field]: i.metres }); return { expected_defaults: JSON.stringify(useViewerStore.getState().authoringDefaults) };
  }))),
  viewerOperation<{ wallAlign: 'left' | 'centre' | 'right'; wallTop: 'storeyAbove' | 'fixed'; chain: boolean; slabMode: 'rectangle' | 'polygon'; spaceMode: 'rectangle' | 'polygon'; slabClass: 'slab' | 'roof' | 'plate'; beamClass: 'beam' | 'member'; expected_defaults: string }>(meta('authoring.defaults.drawing', 'Set all native drawing modes/alignment/top/chain/class defaults after inspecting their exact snapshot.'), {
    type: 'object', properties: { wallAlign: { type: 'string', enum: ['left', 'centre', 'right'] }, wallTop: { type: 'string', enum: ['storeyAbove', 'fixed'] }, chain: { type: 'boolean' }, slabMode: { type: 'string', enum: ['rectangle', 'polygon'] }, spaceMode: { type: 'string', enum: ['rectangle', 'polygon'] }, slabClass: { type: 'string', enum: ['slab', 'roof', 'plate'] }, beamClass: { type: 'string', enum: ['beam', 'member'] }, expected_defaults: { type: 'string', maxLength: 200000 } }, required: ['wallAlign', 'wallTop', 'chain', 'slabMode', 'spaceMode', 'slabClass', 'beamClass', 'expected_defaults'], additionalProperties: false,
  }, (i, c) => out(c.commit(() => { expected(i.expected_defaults); useViewerStore.getState().setAuthoringDefaults({ wallAlign: i.wallAlign, wallTop: i.wallTop, chain: i.chain, slabMode: i.slabMode, spaceMode: i.spaceMode, slabClass: i.slabClass, beamClass: i.beamClass }); return { expected_defaults: JSON.stringify(useViewerStore.getState().authoringDefaults) }; }))),
  viewerOperation<{ owner: 'column' | 'beam' | 'member'; profile_json: string; expected_defaults: string }>(meta('authoring.defaults.profile', 'Set a native cross-section choice using the same canonical profile parser and native per-kind dimension storage. profile_json is a ProfileSection in metres (Type plus exact EXPRESS dimension names).'), {
    type: 'object', properties: { owner: { type: 'string', enum: ['column', 'beam', 'member'] }, profile_json: { type: 'string', maxLength: 20000 }, expected_defaults: { type: 'string', maxLength: 200000 } }, required: ['owner', 'profile_json', 'expected_defaults'], additionalProperties: false,
  }, async (i, c) => { const { parseProfileSectionParams } = await import('@/lib/actions/model-authoring-shape-params'); const profile = decodedInput('profile_json', () => parseProfileSectionParams(parseJsonInput(i.profile_json, 'profile_json'), 'm', 'authoring defaults')); assertToolActive(c);
    return out(c.commit(() => { expected(i.expected_defaults); const s = useViewerStore.getState();
      // A rectangle is built from the kind's own Width x Height (a column's Width x Depth), never from profiles.dims (#10793).
      if (profile.Type === 'Rectangle') { s.setAuthoringProfile(i.owner, 'Rectangle'); const [across, up] = rectangleSides(i.owner); s.setAuthoringDims(i.owner, { [across]: profile.XDim, [up]: profile.YDim }); }
      else s.setAuthoringProfile(i.owner, profile.Type, Object.fromEntries(Object.entries(profile).filter((entry): entry is [string, number] => typeof entry[1] === 'number')));
      return { expected_defaults: JSON.stringify(useViewerStore.getState().authoringDefaults) }; }));
  }),
  viewerOperation<{ minArea: number; namePattern: string; PredefinedType: string; ObjectType: string; expected_defaults: string }>(meta('authoring.defaults.room', 'Set the Room tool’s native minimum area, name pattern, exact PredefinedType and ObjectType defaults.'), {
    type: 'object', properties: { minArea: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 }, namePattern: { type: 'string', minLength: 1, maxLength: 240 }, PredefinedType: { type: 'string', minLength: 1, maxLength: 100 }, ObjectType: { type: 'string', maxLength: 240 }, expected_defaults: { type: 'string', maxLength: 200000 } }, required: ['minArea', 'namePattern', 'PredefinedType', 'ObjectType', 'expected_defaults'], additionalProperties: false,
  }, (i, c) => out(c.commit(() => { expected(i.expected_defaults); useViewerStore.getState().setAuthoringDefaults({ roomCreation: { minArea: i.minArea, namePattern: i.namePattern, PredefinedType: i.PredefinedType, ObjectType: i.ObjectType } }); return { expected_defaults: JSON.stringify(useViewerStore.getState().authoringDefaults) }; }))),
  operation<{ kind: AuthoredElementKind; channel: 'type' | 'layers'; express_id: number; expected_defaults: string }>(meta('authoring.defaults.pick', 'Set or clear the current model’s exact native default type/layer-set pick for one construction kind. express_id=0 clears; cross-model/incorrect IFC classes are refused.'), {
    type: 'object', properties: { kind: kindSchema, channel: { type: 'string', enum: ['type', 'layers'] }, express_id: { type: 'integer', minimum: 0 }, expected_defaults: { type: 'string', maxLength: 200000 } }, required: ['kind', 'channel', 'express_id', 'expected_defaults'], additionalProperties: false,
  }, async (i, c) => {
    const { AUTHORED_KINDS } = await import('@/lib/commands/modeling/authored-kinds'); assertToolActive(c);
    if (i.express_id) { const ref = resolveRef(c.model, { express_id: i.express_id }), type = c.model.bim.entity(ref)?.type;
      if (type !== (i.channel === 'type' ? AUTHORED_KINDS[i.kind].type : 'IfcMaterialLayerSet')) throw invalidInput('invalid-value', 'The chosen entity has the wrong native IFC type.'); }
    return out(c.commit(() => { expected(i.expected_defaults); const s = useViewerStore.getState(), picks = { ...(i.channel === 'type' ? s.authoringDefaults.typeIds : s.authoringDefaults.layerSetIds) };
      // Setting replaces the kind's one pick with this model's; clearing must not drop a pick another model set (#10793).
      if (i.express_id) picks[i.kind] = { modelId: c.model.id, expressId: i.express_id }; else if (picks[i.kind] && picks[i.kind]?.modelId !== c.model.id) throw invalidInput('wrong-target', 'That default pick belongs to another model.'); else delete picks[i.kind];
      s.setAuthoringDefaults(i.channel === 'type' ? { typeIds: picks } : { layerSetIds: picks }); return { expected_defaults: JSON.stringify(useViewerStore.getState().authoringDefaults) };
    }));
  }),
];
