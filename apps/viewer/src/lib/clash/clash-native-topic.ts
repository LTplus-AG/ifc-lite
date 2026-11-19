/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { isTouching, penetrationDepth, DUPLICATES_RULE, type Clash } from '@ifc-lite/clash';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import { getGlobalRenderer, getGlobalCanvas } from '@/hooks/useBCF';
import { captureNativeBcfViewpoint } from '@/hooks/bcf/capture-viewpoint';
import { headerFilesForNativeViewpoints } from '@/hooks/bcf/header-for-viewpoints';
import { captureViewpointForCreate } from '@/hooks/bcf/capture-viewpoint-for-create';
import { resolve } from '@/i18n/registry';
import { focusedSceneRevisionIsCurrent, focusedCameraViewpointIsCurrent, type FocusedClashGroup } from './group-focus';
import type { ClashFocusMode } from '@/store/slices/clashSlice';
import { CLASH_COLOR_A, CLASH_COLOR_B, clashColorToBcfArgb } from './clash-colors';
export function describeNativeClash(c: Clash): string {
  if (c.rule === DUPLICATES_RULE.id)
    return c.severity === 'major'
      ? 'Exact duplicate — coincident geometry with the same shape'
      : 'Overlapping — near-coincident objects in the same place';
  if (c.status === 'clearance') return `Clearance violation — ${c.distance.toFixed(3)} m gap, closer than required`;
  if (isTouching(c)) return 'Touching contact (≈0 m) — surfaces meet but barely overlap';
  if (c.distanceKind === undefined)
    return `Hard clash — ~${penetrationDepth(c).toFixed(3)} m interpenetration (depth provenance unavailable)`;
  return c.distanceKind === 'estimate'
    ? `Hard clash — ~${penetrationDepth(c).toFixed(3)} m interpenetration (AABB estimate)`
    : `Hard clash — ${penetrationDepth(c).toFixed(3)} m interpenetration`;
}
interface TopicOptions {
  clashes: readonly Clash[];
  total: number;
  groupName?: string;
  mode: ClashFocusMode;
  focusClash?: (clash: Clash, mode: ClashFocusMode) => void;
  focusClashes: (clashes: readonly Clash[], mode: ClashFocusMode) => FocusedClashGroup | null;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  commit?: <T>(write: () => T) => T;
  /** Create nothing when the snapshot frame fails, rather than a camera-only topic (the agent operation's contract). */
  requireSnapshot?: boolean;
}
/** The run is still wanted but the scene or camera changed under the capture (a cancelled run returns null). */
export class StaleCaptureError extends Error {
  constructor() { super('The loaded models changed while the BCF viewpoint was being captured. Try again.'); }
}
/** One native create path for panel single/report topics and manual-group topics.
 * Captured camera/scene checks run before publication; failures create nothing. */
export async function createNativeClashTopic(options: TopicOptions): Promise<{ guid: string } | null> {
  const { clashes, total, groupName, mode, isCurrent } = options;
  options.signal?.throwIfAborted();
  const clash = !groupName ? clashes[0] : undefined;
  let focused: FocusedClashGroup | null = null;
  if (groupName) {
    focused = options.focusClashes(clashes, mode === 'ghost' ? 'highlight' : mode);
    if (!focused) throw new Error('None of this group’s objects are available in the loaded models.');
  } else if (clash) {
    if (!options.focusClash) throw new Error('Native pair focus is required.');
    options.focusClash(clash, mode);
    if (useViewerStore.getState().clashSelectedId !== clash.id)
      throw new Error(useViewerStore.getState().clashError ?? 'Native clash focus refused.');
  }
  let framedCamera: Awaited<FocusedClashGroup['frameReady']> | null = null;
  if (focused) {
    framedCamera = await focused.frameReady;
    await frame(options.signal);
  } else if (clash) {
    await frame(options.signal);
    await frame(options.signal);
  }
  const captureIsCurrent = () =>
    isCurrent() &&
    (!focused || (focusedSceneRevisionIsCurrent(focused) && focusedCameraViewpointIsCurrent(framedCamera)));
  // Superseded or cancelled: quiet. Still wanted but the scene/camera moved: say so.
  const staleOrQuiet = (): null => { if (isCurrent()) throw new StaleCaptureError(); return null; };
  if (!captureIsCurrent()) return staleOrQuiet();
  const state = useViewerStore.getState();
  const title =
    groupName ??
    (clash ? `Clash: ${clash.a.tag} × ${clash.b.tag}` : `Clash report — ${total} ${total === 1 ? 'clash' : 'clashes'}`);
  const description = groupName
    ? `${clashes.length} manually grouped clash${clashes.length === 1 ? '' : 'es'}.`
    : clash
      ? `${describeNativeClash(clash)}\n${clash.a.name ?? clash.a.key} ↔ ${clash.b.name ?? clash.b.key}`
      : `${total} ${total === 1 ? 'clash' : 'clashes'} detected across the loaded model(s).`;
  const topic = createBCFTopic({
    title,
    description,
    author: state.bcfAuthor,
    topicType: 'Clash',
    topicStatus: 'Open',
  });
  let visibilityModelIds: readonly string[] = [];
  const captured = await captureViewpointForCreate(
    () =>
      captureNativeBcfViewpoint(getGlobalRenderer(), getGlobalCanvas(), {
        includeSnapshot: true,
        requireSnapshot: options.requireSnapshot,
        includeSelection: !focused,
        includeHidden: true,
        // Only a group capture stops early when stale: it re-checks the framed camera and
        // scene. A pair capture runs to its end so a real failure (a lost frame, no camera)
        // is logged even after the panel closed; a stale result is dropped below.
        ...(focused
          ? {
              isCaptureStillValid: captureIsCurrent,
              onVisibilityModelIdsCaptured: (ids: readonly string[]) => {
                visibilityModelIds = ids;
              },
              additionalSelectedGuids: focused.selectedGuids,
              additionalColoredGuids: [
                { color: clashColorToBcfArgb(CLASH_COLOR_A), guids: focused.aGuids },
                { color: clashColorToBcfArgb(CLASH_COLOR_B), guids: focused.bGuids },
              ].filter((entry) => entry.guids.length > 0),
              additionalVisibleGuids: mode === 'isolate' ? focused.visibleGuids : undefined,
            }
          : {}),
      }),
    captureIsCurrent,
    resolve('bcf.panel.captureViewpointFailed'),
    'clash',
  );
  options.signal?.throwIfAborted();
  // A stale capture also comes back !ok (the capture skips its own toast then); only a real failure reported itself.
  if (!captureIsCurrent()) return staleOrQuiet();
  if (!captured.ok) return null;
  const viewpoint = captured.viewpoint;
  const publish = () => {
    if (!captureIsCurrent()) throw new Error('Clash capture became stale before publication.');
    const s = useViewerStore.getState();
    if (!s.bcfProject) s.setBcfProject(createBCFProject({ name: 'Clash report' }));
    const header = headerFilesForNativeViewpoints(
      [viewpoint],
      topic.creationDate,
      focused ? [...focused.modelIds, ...visibilityModelIds] : undefined,
    );
    if (header.length) topic.header = header;
    s.addTopic(topic);
    s.addViewpoint(topic.guid, viewpoint);
    return { guid: topic.guid };
  };
  return options.commit ? options.commit(publish) : publish();
}
/** Do not race camera paint against a timeout and publish an earlier camera.
 * Explicit cancellation can still end an agent-owned hidden-tab wait. */
function frame(signal?: AbortSignal): Promise<void> {
  return new Promise((resolveFrame, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      cancelAnimationFrame(id);
      reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    const id = requestAnimationFrame(() => {
      signal?.removeEventListener('abort', abort);
      resolveFrame();
    });
    signal?.addEventListener('abort', abort, { once: true });
  });
}
