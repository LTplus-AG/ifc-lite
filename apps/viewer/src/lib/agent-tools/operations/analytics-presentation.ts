/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { isToolAvailable } from '@/lib/features/tools';
import { playNativePresentation, stopPresentationPlayback, presentationPlaybackState, presentationStepMs } from '@/lib/presentation/playback';
import { executeBasketSaveView } from '@/store/basket/basketCommands';
import { activateBasketViewFromStore } from '@/store/basket/basketViewActivator';
import { viewerOperation, emptySchema } from './contract';
import { metadata, idSchema, removedSchema, checkpoint } from './analytics-common';
import { disabled, internal, invalidInput, stale, unavailable } from './refusals';
const output = { type: 'object', properties: { views: { type: 'array' }, activeId: { type: ['string', 'null'] }, basketSize: { type: 'integer' } }, required: ['views', 'activeId', 'basketSize'], additionalProperties: false };
function inspect() { const s = useViewerStore.getState(); return { views: s.basketViews.map(({ thumbnailDataUrl: _thumbnail, ...view }) => ({ ...view, hasThumbnail: Boolean(_thumbnail) })), activeId: s.activeBasketViewId, basketSize: s.pinboardEntities.size }; }
function saved(id: string) { const view = useViewerStore.getState().basketViews.find(row => row.id === id); if (!view) throw invalidInput('unknown-target', 'Unknown saved presentation view.'); return view; }
export const analyticsPresentationOperations = [
  viewerOperation(metadata('presentation.views', 'presentation', 'Read saved camera/section/entity snapshots and transition durations without embedding thumbnail data.', ['read'], output), emptySchema, inspect),
  viewerOperation<{ name: string; transition_ms: number }>(metadata('presentation.save', 'presentation', 'Save the current native basket/view snapshot without generating a thumbnail. Uses the same native save action as the UI capture service.', ['configuration'], { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }), {
    type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, transition_ms: { type: 'integer', minimum: 150, maximum: 15000 } }, required: ['name', 'transition_ms'], additionalProperties: false,
  } satisfies JSONSchemaType<{ name: string; transition_ms: number }>, (i, c) => {
    if (useViewerStore.getState().pinboardEntities.size === 0) throw unavailable('The native basket is empty.');
    checkpoint(c); const id = c.commit(() => useViewerStore.getState().saveCurrentBasketView({ name: i.name, transitionMs: i.transition_ms, source: 'manual' }));
    if (!id) throw internal('Native presentation save failed.'); return { id };
  }),
  viewerOperation(metadata('presentation.capture', 'presentation', 'Await the native basket thumbnail/camera/section capture used by the Presentation Save button and return its actual saved view. Capture admission is non-cancellable; a missing native thumbnail is reported explicitly.', ['configuration', 'view', 'selection'], { type: 'object', properties: { id: { type: 'string' }, has_thumbnail: { type: 'boolean' } }, required: ['id', 'has_thumbnail'], additionalProperties: false }), emptySchema, async (_, c) => {
    if (!useViewerStore.getState().pinboardEntities.size) throw unavailable('The native basket is empty.');
    checkpoint(c); const id = await c.commitAsync(() => executeBasketSaveView('manual'));
    if (!id) throw internal('Native presentation capture did not create a view.'); return { id, has_thumbnail: Boolean(saved(id).thumbnailDataUrl) };
  }),
  viewerOperation<{ id: string }>(metadata('presentation.apply', 'presentation', 'Restore the native saved basket, section planes and camera transition. Returns the applied state; camera animation is dispatched, not claimed finished.', ['view', 'selection', 'configuration'], output), idSchema, (i, c) => {
    const view = saved(i.id);
    if (view.section?.plane.enabled && !isToolAvailable('section')) throw disabled('Section tools are disabled by the host.');
    checkpoint(c); c.commit(() => activateBasketViewFromStore(i.id)); return inspect();
  }),
  viewerOperation<{ id: string; expected_name: string; name: string; transition_ms: number }>(metadata('presentation.configureView', 'presentation', 'Rename and change native transition timing with an expected-name conflict check.', ['configuration'], output), {
    type: 'object', properties: { id: idSchema.properties.id, expected_name: { type: 'string', maxLength: 2_000_000 }, name: { type: 'string', minLength: 1, maxLength: 200 }, transition_ms: { type: 'integer', minimum: 150, maximum: 15000 } }, required: ['id', 'expected_name', 'name', 'transition_ms'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_name: string; name: string; transition_ms: number }>, (i, c) => {
    if (saved(i.id).name !== i.expected_name) throw stale('View name changed since inspection.');
    checkpoint(c); c.commit(() => { const s = useViewerStore.getState(); s.renameBasketView(i.id, i.name); s.setBasketViewTransitionMs(i.id, i.transition_ms); }); return inspect();
  }),
  viewerOperation<{ id: string }>(metadata('presentation.delete', 'presentation', 'Delete one saved native presentation view.', ['configuration'], removedSchema), idSchema, (i, c) => { saved(i.id); checkpoint(c); c.commit(() => useViewerStore.getState().removeBasketView(i.id)); return { removed: i.id }; }),
  viewerOperation(metadata('presentation.playback', 'presentation', 'Inspect viewer-scoped saved-view sequence completion, cancellation or failure independently of the panel.', ['read'], { type: 'object', properties: { state: { type: 'string' }, current_view_id: { type: ['string', 'null'] }, played: { type: 'integer' }, error: { type: ['string', 'null'] } }, required: ['state', 'current_view_id', 'played', 'error'], additionalProperties: false }), emptySchema, presentationPlaybackState),
  viewerOperation<{ view_ids: string[]; repetitions: number }>(metadata('presentation.play', 'presentation', 'Await a finite native saved-view sequence using the same playback service as Play All, with stop/signal cancellation and exact-view conflict checks. Completion follows native transition durations; camera callbacks have no separate settled acknowledgement.', ['view', 'selection', 'configuration'], { type: 'object', properties: { state: { type: 'string' }, current_view_id: { type: ['string', 'null'] }, played: { type: 'integer' }, error: { type: ['string', 'null'] } }, required: ['state', 'current_view_id', 'played', 'error'], additionalProperties: false }), {
    type: 'object', properties: { view_ids: { type: 'array', items: idSchema.properties.id, minItems: 1, maxItems: 100 }, repetitions: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['view_ids', 'repetitions'], additionalProperties: false,
  } satisfies JSONSchemaType<{ view_ids: string[]; repetitions: number }>, async (i, c) => {
    const duration = i.view_ids.reduce((total, id) => total + presentationStepMs(saved(id)), 0) * i.repetitions;
    if (duration > 120000) throw invalidInput('limit', 'Choose a finite saved-view sequence lasting at most two minutes.'); checkpoint(c);
    return playNativePresentation(i.view_ids, { repetitions: i.repetitions, maxDurationMs: 120000, signal: c.signal, beforeActivate: apply => c.commit(apply) });
  }),
  viewerOperation({ ...metadata('presentation.stop', 'presentation', 'Request cancellation of the viewer-scoped native presentation sequence. Inspect presentation.playback for its terminal state; applied views are not rolled back.', ['view'], { type: 'object', properties: { requested: { type: 'boolean' } }, required: ['requested'], additionalProperties: false }), completion: 'dispatched' }, emptySchema, (_, c) => { checkpoint(c); const requested = presentationPlaybackState().state === 'running'; c.commit(stopPresentationPlayback); return { requested }; }),

];
