/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Equal,
  Eye,
  EyeOff,
  Minus,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Square,
  Timer,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import {
  executeBasketSet,
  executeBasketAdd,
  executeBasketRemove,
  executeBasketSaveView,
  executeBasketClear,
} from '@/store/basket/basketCommands';
import { getSmartBasketInputFromStore, isBasketIsolationActiveFromStore } from '@/store/basketVisibleSet';

export function BasketPresentationDock() {
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
  const basketPresentationVisible = useViewerStore((s) => s.basketPresentationVisible);
  const isMobile = useViewerStore((s) => s.isMobile);

  const showPinboard = useViewerStore((s) => s.showPinboard);
  const clearIsolation = useViewerStore((s) => s.clearIsolation);
  const setBasketPresentationVisible = useViewerStore((s) => s.setBasketPresentationVisible);

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

  const wait = useCallback((ms: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  }), []);

  const stopPlayAll = useCallback(() => {
    stopPlayRef.current = true;
    loopPlayRef.current = false;
    setPlayingAll(false);
  }, []);

  const activateSavedView = useCallback(async (viewId: string) => {
    const { activateBasketViewFromStore } = await import('@/store/basket/basketViewActivator');
    activateBasketViewFromStore(viewId);
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
          await activateSavedView(view.id);
          const transitionMs = toTransitionMs(view.transitionMs);
          await wait(transitionMs + 180);
        }
      } while (loopPlayRef.current && !stopPlayRef.current && orderedViews.length > 0);
    } finally {
      loopPlayRef.current = false;
      setPlayingAll(false);
    }
  }, [activateSavedView, basketViews, playingAll, toTransitionMs, wait]);

  const setViewTransitionDuration = useCallback((viewId: string, currentTransitionMs: number | null) => {
    const defaultSeconds = currentTransitionMs && currentTransitionMs > 0
      ? (currentTransitionMs / 1000).toFixed(1)
      : '';
    const input = window.prompt(
      'Transition duration in seconds (optional). Leave empty for default smooth transition.',
      defaultSeconds,
    );
    if (input === null) return;

    const trimmed = input.trim();
    if (!trimmed) {
      setBasketViewTransitionMs(viewId, null);
      return;
    }

    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    setBasketViewTransitionMs(viewId, Math.round(seconds * 1000));
  }, [setBasketViewTransitionMs]);

  if (isMobile) return null;

  if (!basketPresentationVisible) {
    return (
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="pointer-events-auto shadow-lg gap-2"
          onClick={() => setBasketPresentationVisible(true)}
        >
          Presentation
          <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
            {basketViews.length}
          </span>
        </Button>
      </div>
    );
  }

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 w-[min(980px,calc(100%-2rem))] pointer-events-none">
      <div className="pointer-events-auto rounded-xl border bg-background/90 backdrop-blur-sm shadow-lg p-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-semibold">Presentation</div>
            <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
              {pinboardEntities.size} in basket
            </span>
            <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
              {basketViews.length} views
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-1 rounded-md border bg-background/70 p-1">
              <Button type="button" variant="outline" size="icon-sm" onClick={() => applySource('set')} title="Set basket from current context">
                <Equal className="h-4 w-4" />
              </Button>
              <Button type="button" variant="outline" size="icon-sm" onClick={() => applySource('add')} title="Add current context to basket">
                <Plus className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={() => applySource('remove')}
                disabled={pinboardEntities.size === 0}
                title="Remove current context from basket"
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
                title={basketIsVisible ? 'Hide active basket' : 'Show active basket'}
              >
                {basketIsVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={executeBasketClear}
                disabled={pinboardEntities.size === 0}
                title="Clear active basket"
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
              title="Save current basket as presentation view"
            >
              <Save className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant={playingAll ? 'secondary' : 'outline'}
              size="icon-sm"
              onClick={playingAll ? stopPlayAll : (e) => { void startPlayAll(e.shiftKey); }}
              disabled={basketViews.length === 0}
              title={playingAll ? 'Stop playback' : 'Play all saved views (Shift+Click to loop)'}
            >
              {playingAll ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-1 text-xs"
              onClick={() => setBasketPresentationVisible(false)}
            >
              Hide
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => scrollStrip(-280)}
            disabled={basketViews.length <= 1}
            title="Scroll left"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <div
            ref={stripRef}
            className="flex-1 min-w-0 overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent snap-x snap-mandatory"
          >
            <div className="flex items-stretch gap-2 pr-1">
              {basketViews.length === 0 && (
                <div className="h-[102px] min-w-[340px] rounded-md border border-dashed text-xs text-muted-foreground px-3 py-2 flex items-center">
                  Save basket views here. Click any card to restore both visibility and viewpoint.
                </div>
              )}

              {basketViews.map((view) => (
                <div key={view.id} className="relative w-[186px] h-[102px] shrink-0 snap-start">
                  <button
                    type="button"
                    onClick={() => {
                      if (editingViewId) return;
                      void activateSavedView(view.id);
                    }}
                    className={cn(
                      'h-full w-full rounded-md border bg-card text-left overflow-hidden transition-colors',
                      activeBasketViewId === view.id && 'ring-2 ring-primary border-primary',
                    )}
                  >
                    {view.thumbnailDataUrl ? (
                      <img
                        src={view.thumbnailDataUrl}
                        alt={view.name}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : (
                      <div className="absolute inset-0 bg-muted" />
                    )}

                    {activeBasketViewId === view.id && (
                      <div className="absolute left-1 top-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                        Active
                      </div>
                    )}

                  </button>

                  <div
                    className={cn(
                      'absolute inset-x-0 bottom-0 bg-black/60 text-white px-2 py-1',
                      editingViewId !== view.id && 'pointer-events-none',
                    )}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {editingViewId === view.id ? (
                      <Input
                        autoFocus
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRename();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelRename();
                          }
                        }}
                        className="h-6 bg-black/40 text-xs border-white/30 text-white placeholder:text-white/60"
                      />
                    ) : (
                      <>
                        <div className="text-[12px] font-medium truncate">{view.name}</div>
                        <div className="text-[10px] opacity-80">
                          {view.entityRefs.length} objects
                          {view.transitionMs ? ` · ${(view.transitionMs / 1000).toFixed(1)}s` : ''}
                        </div>
                      </>
                    )}
                  </div>

                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-xs"
                    className="absolute top-1 right-7"
                    title="Rename view"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(view.id, view.name);
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-xs"
                    className="absolute top-1 right-[3.25rem]"
                    title="Set transition duration"
                    onClick={(e) => {
                      e.stopPropagation();
                      setViewTransitionDuration(view.id, view.transitionMs);
                    }}
                  >
                    <Timer className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-xs"
                    className="absolute top-1 right-1"
                    title="Delete view"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (playingAll) stopPlayAll();
                      if (editingViewId === view.id) cancelRename();
                      removeBasketView(view.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => scrollStrip(280)}
            disabled={basketViews.length <= 1}
            title="Scroll right"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
