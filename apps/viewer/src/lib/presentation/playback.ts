/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useSyncExternalStore } from 'react';
import { useViewerStore } from '@/store';
import { isToolAvailable } from '@/lib/features/tools';
/** How long one saved view stays up during playback: its transition (clamped) plus a settle margin. */
export function presentationStepMs(view: { transitionMs?: number | null }): number {
  const t = view.transitionMs;
  return (t && Number.isFinite(t) && t > 0 ? Math.max(150, Math.min(15000, Math.round(t))) : 700) + 180;
}
export interface PresentationPlaybackState { state: 'idle' | 'running' | 'succeeded' | 'cancelled' | 'failed'; current_view_id: string | null; played: number; error: string | null }
let snapshot: PresentationPlaybackState = { state: 'idle', current_view_id: null, played: 0, error: null };
let controller: AbortController | null = null;
const listeners = new Set<() => void>();
function publish(update: Partial<PresentationPlaybackState>) { snapshot = { ...snapshot, ...update }; for (const listener of listeners) listener(); }
export const presentationPlaybackState = () => snapshot;
export function usePresentationPlayback() { return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, presentationPlaybackState, presentationPlaybackState); }
/** Ends the run at once, as Stop did before the shared service: the run's pending
 * wait rejects later, but the stopped run no longer owns the published state. */
export function stopPresentationPlayback(): void {
  const running = controller; if (!running) return;
  controller = null; running.abort();
  publish({ state: 'cancelled', error: null });
}
function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Playback cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, milliseconds);
    signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
  });
}
/** The Presentation panel's native sequence: activate, then wait its transition + 180ms.
 * Completion describes the saved-view sequence; native camera callbacks expose no settle signal.
 * repetitions=0 is reserved for the UI's explicitly selected continuous-loop control.
 */
export async function playNativePresentation(viewIds: readonly string[], options: { repetitions: number; signal?: AbortSignal; beforeActivate?: (apply: () => void) => void } = { repetitions: 1 }): Promise<PresentationPlaybackState> {
  if (controller) throw new Error('A native presentation sequence is already running.');
  if (!viewIds.length) throw new Error('No presentation views were supplied.');
  const views = viewIds.map(id => { const view = useViewerStore.getState().basketViews.find(row => row.id === id); if (!view) throw new Error('Unknown saved presentation view.'); return structuredClone(view); });
  const abort = new AbortController(); controller = abort;
  const cancelled = () => abort.abort(options.signal?.reason); options.signal?.addEventListener('abort', cancelled, { once: true });
  const owns = () => controller === abort;
  let final: PresentationPlaybackState = { state: 'running', current_view_id: null, played: 0, error: null };
  const report = (update: Partial<PresentationPlaybackState>) => { final = { ...final, ...update }; if (owns()) publish(update); };
  report(final);
  try {
    const { activateBasketViewFromStore } = await import('@/store/basket/basketViewActivator');
    for (let repetition = 0; options.repetitions === 0 || repetition < options.repetitions; repetition++) for (const view of views) {
      abort.signal.throwIfAborted(); options.signal?.throwIfAborted();
      // A renamed or re-timed view keeps playing (as the panel always did); a deleted one stops the run.
      if (!useViewerStore.getState().basketViews.some(row => row.id === view.id)) throw new Error('A saved view was deleted during playback.');
      if (view.section?.plane.enabled && !isToolAvailable('section')) throw new Error('Section tools are disabled by the host.');
      const apply = () => activateBasketViewFromStore(view.id); if (options.beforeActivate) options.beforeActivate(apply); else apply();
      report({ current_view_id: view.id, played: final.played + 1 });
      await delay(presentationStepMs(view), abort.signal);
    }
    report({ state: 'succeeded' });
  } catch (error) {
    report({ state: abort.signal.aborted || options.signal?.aborted ? 'cancelled' : 'failed', error: abort.signal.aborted ? null : error instanceof Error ? error.message : String(error) });
  } finally { options.signal?.removeEventListener('abort', cancelled); if (owns()) controller = null; }
  return final;
}
