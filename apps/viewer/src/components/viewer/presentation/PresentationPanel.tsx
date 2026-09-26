/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `presentation` workspace panel's body (#5508): a filmstrip of saved
 * basket views, docked in the bottom strip, floating, or popped out — the
 * same regions every other bottom panel lives in. Replaces
 * `BasketPresentationDock`, which drew an always-on "Presentation 0" pill at
 * the viewport's bottom-center even with an empty basket, and opened as its
 * own draggable / resizable floating card over the model. The strip / float /
 * pop-out host now owns title, Close, drag-to-detach and resize (#5498), so
 * this is just the action row (basket source, visibility, save, play-all) and
 * the saved-view strip.
 *
 * Entry points: the status bar (`StatusBar.tsx`) and the ribbon / classic
 * toolbar's Present button, both routed through the bottom-panel table
 * (`lib/panels/bottom-panels`) like every other bottom panel — no bespoke
 * visibility toggle.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Equal,
  Eye,
  EyeOff,
  Minus,
  Play,
  Plus,
  RotateCcw,
  Save,
  Square,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { promptDialog } from '@/components/ui/confirm-dialog';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import {
  executeBasketSet,
  executeBasketAdd,
  executeBasketRemove,
  executeBasketSaveView,
  executeBasketClear,
} from '@/store/basket/basketCommands';
import { getSmartBasketInputFromStore, isBasketIsolationActiveFromStore } from '@/store/basketVisibleSet';
import { PresentationViewCard } from './PresentationViewCard';

export function PresentationPanel() {
  const { t } = useTranslation();
  const [savingThumbnail, setSavingThumbnail] = useState(false);
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [playingAll, setPlayingAll] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const stopPlayRef = useRef(false);
  const loopPlayRef = useRef(false);

  const pinboardEntities = useViewerStore((s) => s.pinboardEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const basketViews = useViewerStore((s) => s.basketViews);
  const activeBasketViewId = useViewerStore((s) => s.activeBasketViewId);

  const showPinboard = useViewerStore((s) => s.showPinboard);
  const clearIsolation = useViewerStore((s) => s.clearIsolation);

  const removeBasketView = useViewerStore((s) => s.removeBasketView);
  const renameBasketView = useViewerStore((s) => s.renameBasketView);
  const setBasketViewTransitionMs = useViewerStore((s) => s.setBasketViewTransitionMs);

  const basketIsVisible = useMemo(
    () => pinboardEntities.size > 0 && isolatedEntities !== null && isBasketIsolationActiveFromStore(),
    [pinboardEntities, isolatedEntities],
  );

  const applySource = useCallback((mode: 'set' | 'add' | 'remove') => {
    if (mode === 'set') executeBasketSet();
    else if (mode === 'add') executeBasketAdd();
    else executeBasketRemove();
  }, []);

  const handleSaveCurrent = useCallback(async () => {
    if (pinboardEntities.size === 0 || savingThumbnail) return;

    setSavingThumbnail(true);
    try {
      const { source } = getSmartBasketInputFromStore();
      await executeBasketSaveView(source === 'empty' ? 'manual' : source);
    } finally {
      setSavingThumbnail(false);
    }
  }, [pinboardEntities, savingThumbnail]);

  const startRename = useCallback((viewId: string, name: string) => {
    setEditingViewId(viewId);
    setEditingName(name);
  }, []);

  const cancelRename = useCallback(() => {
    setEditingViewId(null);
    setEditingName('');
  }, []);

  const commitRename = useCallback(() => {
    if (!editingViewId) return;
    const nextName = editingName.trim();
    if (nextName.length > 0) {
      renameBasketView(editingViewId, nextName);
    }
    setEditingViewId(null);
    setEditingName('');
  }, [editingViewId, editingName, renameBasketView]);

  const scrollStrip = useCallback((delta: number) => {
    stripRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  }, []);

  const toTransitionMs = useCallback((value: number | null | undefined) => {
    if (!value || !Number.isFinite(value) || value <= 0) return 700;
    return Math.max(150, Math.min(15000, Math.round(value)));
  }, []);

  const wait = useCallback((ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)), []);

  const stopPlayAll = useCallback(() => {
    stopPlayRef.current = true;
    loopPlayRef.current = false;
    setPlayingAll(false);
  }, []);

  /**
   * Activate a saved view. Resolves `false` when the activator chunk could not
   * be loaded.
   *
   * Contained here so BOTH call sites are covered: the `void` in the thumbnail's
   * onClick below, and `startPlayAll`, whose try/finally has no catch - either
   * would otherwise become an unhandled rejection when a deploy rotates this
   * chunk's hash under an open tab (see lib/chunk-version-skew.ts).
   *
   * The result is REPORTED rather than swallowed because the recovery is not
   * guaranteed: the skew handler reloads at most once per debounce window, so a
   * chunk that stays missing leaves the tab running. Play-all must stop there
   * instead of looping forever over views that can no longer be applied.
   */
  const activateSavedView = useCallback(async (viewId: string): Promise<boolean> => {
    try {
      const { activateBasketViewFromStore } = await import('@/store/basket/basketViewActivator');
      activateBasketViewFromStore(viewId);
      return true;
    } catch (err) {
      console.warn('[presentation-panel] could not load the basket-view activator', err);
      return false;
    }
  }, []);

  const startPlayAll = useCallback(async (loop = false) => {
    if (playingAll || basketViews.length === 0) return;
    stopPlayRef.current = false;
    loopPlayRef.current = loop;
    setPlayingAll(true);

    try {
      const orderedViews = [...basketViews];
      do {
        for (const view of orderedViews) {
          if (stopPlayRef.current) break;
          if (!(await activateSavedView(view.id))) {
            // The activator chunk is gone. Reuse the normal stop signal so the
            // `while` below also ends and the finally block resets the UI, and
            // do not wait out this view's transition on the way out.
            stopPlayRef.current = true;
            break;
          }
          const transitionMs = toTransitionMs(view.transitionMs);
          await wait(transitionMs + 180);
        }
      } while (loopPlayRef.current && !stopPlayRef.current && orderedViews.length > 0);
    } finally {
      loopPlayRef.current = false;
      setPlayingAll(false);
    }
  }, [activateSavedView, basketViews, playingAll, toTransitionMs, wait]);

  const setViewTransitionDuration = useCallback(async (viewId: string, currentTransitionMs: number | null) => {
    const defaultSeconds = currentTransitionMs && currentTransitionMs > 0
      ? (currentTransitionMs / 1000).toFixed(1)
      : '';
    const input = await promptDialog({
      description: t('presentationPanel.transitionDurationPrompt'),
      defaultValue: defaultSeconds,
    });
    if (input === null) return;

    const trimmed = input.trim();
    if (!trimmed) {
      setBasketViewTransitionMs(viewId, null);
      return;
    }

    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    setBasketViewTransitionMs(viewId, Math.round(seconds * 1000));
  }, [setBasketViewTransitionMs, t]);

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">
      {/* Action row — counts + basket source / visibility / save / play-all.
          Title and Close are the strip header's (#5498); this only owns the
          controls that act on the basket. */}
      <div className="flex items-center justify-between gap-3 border-b px-3 py-1.5 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
            {t('presentationPanel.inBasketCount', { count: pinboardEntities.size })}
          </span>
          <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
            {t('presentationPanel.viewsCount', { count: basketViews.length })}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1 rounded-md border bg-background/70 p-1">
            <Button type="button" variant="outline" size="icon-sm" onClick={() => applySource('set')} title={t('presentationPanel.setFromContextTitle')}>
              <Equal className="h-4 w-4" />
            </Button>
            <Button type="button" variant="outline" size="icon-sm" onClick={() => applySource('add')} title={t('presentationPanel.addToBasketTitle')}>
              <Plus className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => applySource('remove')}
              disabled={pinboardEntities.size === 0}
              title={t('presentationPanel.removeFromBasketTitle')}
            >
              <Minus className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-1 rounded-md border bg-background/70 p-1">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => {
                if (basketIsVisible) clearIsolation();
                else showPinboard();
              }}
              disabled={pinboardEntities.size === 0}
              title={basketIsVisible ? t('presentationPanel.hideActiveBasketTitle') : t('presentationPanel.showActiveBasketTitle')}
            >
              {basketIsVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={executeBasketClear}
              disabled={pinboardEntities.size === 0}
              title={t('presentationPanel.clearActiveBasketTitle')}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
          <Button
            type="button"
            variant="default"
            size="icon-sm"
            onClick={handleSaveCurrent}
            disabled={pinboardEntities.size === 0 || savingThumbnail}
            title={t('presentationPanel.saveCurrentViewTitle')}
          >
            <Save className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant={playingAll ? 'secondary' : 'outline'}
            size="icon-sm"
            onClick={playingAll ? stopPlayAll : (e) => { void startPlayAll(e.shiftKey); }}
            disabled={basketViews.length === 0}
            title={playingAll ? t('presentationPanel.stopPlaybackTitle') : t('presentationPanel.playAllTitle')}
          >
            {playingAll ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Saved-view filmstrip */}
      <div className="flex-1 min-h-0 flex items-center gap-2 px-3 py-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => scrollStrip(-280)}
          disabled={basketViews.length <= 1}
          title={t('presentationPanel.scrollLeftTitle')}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <div
          ref={stripRef}
          className="flex-1 min-w-0 h-full overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent snap-x snap-mandatory"
        >
          <div className="flex h-full items-stretch gap-2 pr-1">
            {basketViews.length === 0 && (
              <div className="h-full min-w-[340px] rounded-md border border-dashed text-xs text-muted-foreground px-3 py-2 flex items-center">
                {t('presentationPanel.emptyStripHint')}
              </div>
            )}

            {basketViews.map((view) => (
              <PresentationViewCard
                key={view.id}
                view={view}
                isActive={activeBasketViewId === view.id}
                isEditing={editingViewId === view.id}
                editingName={editingName}
                onSelect={() => void activateSavedView(view.id)}
                onStartRename={() => startRename(view.id, view.name)}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
                onEditingNameChange={setEditingName}
                onSetTransition={() => setViewTransitionDuration(view.id, view.transitionMs)}
                onDelete={() => {
                  if (playingAll) stopPlayAll();
                  if (editingViewId === view.id) cancelRename();
                  removeBasketView(view.id);
                }}
              />
            ))}
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => scrollStrip(280)}
          disabled={basketViews.length <= 1}
          title={t('presentationPanel.scrollRightTitle')}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
