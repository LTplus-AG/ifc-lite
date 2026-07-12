/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer-stack panel (#1717 V1) — the composition behind a federated IFCX
 * model, rendered as strata: strongest opinion on top, exactly the order
 * the composition engine resolves. Each stratum carries its provenance
 * (author kind, intent, checks, content address) and can isolate its
 * contribution as a stack diff (05-merge.md StackDiff shape).
 *
 * Registered as the `layers` workspace panel; the activity bar surfaces it
 * only while a federated stack is loaded. All layer data is path-keyed —
 * expressIds are synthetic per parse — so 3D selection goes through the
 * composition's `layerStackPathToId` bridge and nothing here persists ids.
 */

import { useCallback, useRef, useState } from 'react';
import { Bot, FolderOpen, GitMerge, Layers, Sparkles, User, Users2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import type { LayerAuthorKind, LayerStackEntry } from '@/store/slices/layerStackSlice';
import { computeLayerContribution, shortContentId } from '@/lib/layers/stack';
import { LayerDiffView } from './LayerDiffView';
import { LayerProvenanceDetail } from './LayerProvenanceDetail';
import { LayerDraftSection } from './LayerDraftSection';
import { LayerMergeSection } from './LayerMergeSection';
import { useIfc } from '@/hooks/useIfc';
import { loadDemoLayerStack } from '@/lib/layers/demo-stack';
import { toast } from '@/components/ui/toast';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';

interface LayersPanelProps {
  onClose: () => void;
}

/** Author kind → badge tint + icon. Mirrors the RoomPanel role-badge system. */
const AUTHOR_META: Record<LayerAuthorKind, { label: string; cls: string; Icon: typeof User }> = {
  human: {
    label: 'Human',
    cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    Icon: User,
  },
  agent: {
    label: 'Agent',
    cls: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300',
    Icon: Bot,
  },
  hybrid: {
    label: 'Hybrid',
    cls: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300',
    Icon: Users2,
  },
};

/** Stratum accent by author kind; unsigned layers stay neutral. */
function accentClass(kind: LayerAuthorKind | undefined): string {
  switch (kind) {
    case 'human': return 'bg-emerald-500/60';
    case 'agent': return 'bg-violet-500/60';
    case 'hybrid': return 'bg-amber-500/60';
    default: return 'bg-border';
  }
}

function AuthorBadge({ kind, principal }: { kind?: LayerAuthorKind; principal?: string }) {
  if (!kind) {
    return (
      <span className="shrink-0 rounded-full border border-dashed px-1.5 py-px text-[10px] leading-none text-muted-foreground">
        unsigned
      </span>
    );
  }
  const m = AUTHOR_META[kind];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-none ${m.cls}`}
        >
          <m.Icon className="size-2.5" aria-hidden />
          {m.label}
        </span>
      </TooltipTrigger>
      {principal && <TooltipContent side="top">{principal}</TooltipContent>}
    </Tooltip>
  );
}

/** One stratum row. `position` is 1-based from the TOP (1 = strongest). */
function LayerStratum({
  entry,
  position,
  total,
  active,
  expanded,
  busy,
  onInspect,
  onToggleDetail,
}: {
  entry: LayerStackEntry;
  position: number;
  total: number;
  active: boolean;
  expanded: boolean;
  busy: boolean;
  onInspect: () => void;
  onToggleDetail: () => void;
}) {
  const created = entry.created ? entry.created.slice(0, 10) : undefined;
  const subParts: string[] = [];
  if (entry.authorPrincipal) subParts.push(entry.authorPrincipal);
  if (created) subParts.push(created);
  subParts.push(`${entry.nodeCount} ${entry.nodeCount === 1 ? 'node' : 'nodes'}`);

  return (
    <div
      className={`group relative flex animate-in fade-in slide-in-from-top-1 items-stretch gap-2 rounded-md border bg-card/50 py-1.5 pl-0 pr-1.5 transition-colors hover:bg-muted/50 ${
        active ? 'border-primary/40 bg-muted/40' : ''
      }`}
      style={{ animationDelay: `${(position - 1) * 40}ms`, animationFillMode: 'backwards' }}
    >
      {/* Stratum accent: author-kind tinted, the panel's one signature detail. */}
      <span className={`w-[3px] shrink-0 self-stretch rounded-full ${accentClass(entry.authorKind)}`} aria-hidden />
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={onToggleDetail}
        aria-expanded={expanded}
        aria-label={`Provenance of ${entry.name}`}
      >
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] leading-4 text-muted-foreground">
            {total - position + 1}
          </span>
          <span className="truncate text-xs font-medium" title={entry.name}>
            {entry.name}
          </span>
          {entry.isMerge && (
            <Tooltip>
              <TooltipTrigger asChild>
                <GitMerge className="size-3 shrink-0 text-muted-foreground" aria-label="Merge layer" />
              </TooltipTrigger>
              <TooltipContent side="top">Merge layer</TooltipContent>
            </Tooltip>
          )}
          <AuthorBadge kind={entry.authorKind} principal={entry.authorPrincipal} />
        </div>
        {entry.intent && (
          <div className="truncate text-[11px] italic text-muted-foreground" title={entry.intent}>
            {entry.intent}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="truncate">{subParts.join(' · ')}</span>
          {entry.checksTotal !== undefined && (
            <span
              className={`shrink-0 rounded-full border px-1 leading-3 ${
                entry.checksPassed === entry.checksTotal
                  ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-300'
                  : 'border-amber-500/30 text-amber-600 dark:text-amber-300'
              }`}
            >
              {entry.checksPassed}/{entry.checksTotal} checks
            </span>
          )}
          {entry.contentId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 rounded bg-muted px-1 font-mono leading-3">
                  {shortContentId(entry.contentId)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="font-mono text-[10px]">
                {entry.contentId}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 self-center px-1.5 text-[11px] opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        disabled={busy}
        onClick={onInspect}
      >
        {active ? 'Hide' : 'Changes'}
      </Button>
    </div>
  );
}

export function LayersPanel(_props: LayersPanelProps) {
  const layerStack = useViewerStore((s) => s.layerStack);
  const layerStackDiff = useViewerStore((s) => s.layerStackDiff);
  const layerDiffBusy = useViewerStore((s) => s.layerDiffBusy);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { loadFederatedIfcx } = useIfc();
  const stackInputRef = useRef<HTMLInputElement>(null);
  const [demoBusy, setDemoBusy] = useState(false);

  const loadDemo = useCallback(async () => {
    setDemoBusy(true);
    try {
      await loadDemoLayerStack();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDemoBusy(false);
    }
  }, []);

  const inspect = useCallback(
    async (layerId: string) => {
      const state = useViewerStore.getState();
      if (state.layerStackDiff?.layerId === layerId) {
        state.setLayerStackDiff(null);
        return;
      }
      state.setLayerDiffBusy(true);
      try {
        const diff = await computeLayerContribution(state.layerStack, layerId);
        if (diff) useViewerStore.getState().setLayerStackDiff({ layerId, diff });
      } finally {
        useViewerStore.getState().setLayerDiffBusy(false);
      }
    },
    [],
  );

  if (layerStack.length === 0) {
    return (
      <ScrollArea className="h-full">
        <div className="flex flex-col items-center gap-2 p-6 pt-10 text-center">
          <Layers className="size-8 text-muted-foreground/50" aria-hidden />
          <p className="text-xs font-medium">Layers: version your model like code</p>
          <p className="max-w-[30ch] text-[11px] text-muted-foreground">
            An IFC5 model composes from immutable layers. Inspect who changed
            what, publish your edits as new layers, and merge them with
            reviews, checks, and conflict resolution.
          </p>
          <div className="flex flex-col gap-1.5 pt-2">
            <Button
              size="sm"
              className="h-7 gap-1.5 px-3 text-[11px]"
              onClick={() => void loadDemo()}
              disabled={demoBusy}
              {...tourAnchor(TOUR_ANCHORS.layersDemo)}
            >
              <Sparkles className="size-3.5" aria-hidden />
              {demoBusy ? 'Loading…' : 'Load demo stack'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-3 text-[11px]"
              onClick={() => stackInputRef.current?.click()}
            >
              <FolderOpen className="size-3.5" aria-hidden />
              Open .ifcx files
            </Button>
            <input
              ref={stackInputRef}
              type="file"
              accept=".ifcx"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length > 0) void loadFederatedIfcx(files);
              }}
            />
          </div>
          <p className="max-w-[30ch] pt-1 text-[10px] text-muted-foreground/70">
            You can also drop several .ifcx files anywhere in the viewer.
          </p>
          {/* Local candidates from earlier sessions stay actionable even
              before a stack is loaded (self-hides when the store is empty). */}
          <div className="w-full pt-2 text-left">
            <LayerMergeSection />
          </div>
        </div>
      </ScrollArea>
    );
  }

  // Composition order in the slice is weakest first; the stack renders the
  // way it resolves — strongest opinion on top.
  const strata = [...layerStack].reverse();
  const activeEntry = layerStackDiff
    ? layerStack.find((entry) => entry.id === layerStackDiff.layerId)
    : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] text-muted-foreground">
        <Layers className="size-3.5" aria-hidden />
        <span>
          {layerStack.length} {layerStack.length === 1 ? 'layer' : 'layers'}, strongest on top
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 px-2 pb-2">
          <div {...tourAnchor(TOUR_ANCHORS.layersDraft)}>
            <LayerDraftSection />
          </div>
          <div {...tourAnchor(TOUR_ANCHORS.layersMerge)}>
            <LayerMergeSection />
          </div>
          <div className="flex flex-col gap-1" {...tourAnchor(TOUR_ANCHORS.layersStrata)}>
          {strata.map((entry, i) => (
            <div key={entry.id} className="flex flex-col gap-1">
              <LayerStratum
                entry={entry}
                position={i + 1}
                total={strata.length}
                active={layerStackDiff?.layerId === entry.id}
                expanded={expandedId === entry.id}
                busy={layerDiffBusy}
                onInspect={() => void inspect(entry.id)}
                onToggleDetail={() => setExpandedId((prev) => (prev === entry.id ? null : entry.id))}
              />
              {expandedId === entry.id && <LayerProvenanceDetail file={entry.file} />}
            </div>
          ))}
          </div>
          {layerDiffBusy && (
            <p className="px-1 py-2 text-center text-[11px] text-muted-foreground">Computing changes…</p>
          )}
          {layerStackDiff && activeEntry && !layerDiffBusy && (
            <LayerDiffView entry={activeEntry} diff={layerStackDiff.diff} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
