/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CostTreeView — the Cost panel's schedule/item tree (#4858), one section
 * per loaded model so a federated session names which model each schedule
 * belongs to (never a flattened, unattributed list).
 *
 * Each model section shows exactly one of its states, explicitly:
 *  - "unavailable" (`graph === null`) — no loaded IFC source to read cost
 *    from; DIFFERENT from "empty" (see `useCostModels` doc).
 *  - "empty" (`HasCostData === false`) — read successfully, genuinely no
 *    IfcCostItem/IfcCostSchedule data.
 *  - the tree itself, with cyclic / mixed-currency badges surfaced from the
 *    evaluator's own diagnostics — never invented, never silently merged
 *    into a generic "issues" flag.
 */

import { AlertTriangle, ChevronDown, ChevronRight, Coins, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/useTranslation';
import {
  buildCostTree,
  classifyCostModel,
  treeHasMixedCurrencyEvaluation,
  type CostTreeItemNode,
  type EntityRefLike,
} from '@/lib/cost/cost-tree';
import { useCostBackend } from './useCostBackend';
import type { CostModelEntry } from './useCostModels';

export interface CostTreeViewProps {
  entries: CostModelEntry[];
  selectedRef: EntityRefLike | null;
  onSelectItem: (modelId: string, ref: EntityRefLike) => void;
}

function refEquals(a: EntityRefLike | null, b: EntityRefLike): boolean {
  return !!a && a.modelId === b.modelId && a.expressId === b.expressId;
}

function ItemRow({
  node,
  depth,
  modelId,
  selectedRef,
  onSelectItem,
}: {
  node: CostTreeItemNode;
  depth: number;
  modelId: string;
  selectedRef: EntityRefLike | null;
  onSelectItem: (modelId: string, ref: EntityRefLike) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const selected = refEquals(selectedRef, node.ref);
  const { t } = useTranslation();
  return (
    <div>
      <div
        role="treeitem"
        aria-selected={selected}
        tabIndex={0}
        onClick={() => onSelectItem(modelId, node.ref)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          // Space would otherwise also scroll the panel.
          e.preventDefault();
          onSelectItem(modelId, node.ref);
        }}
        className={cn(
          'flex cursor-pointer items-center gap-1 rounded py-0.5 pr-2 text-xs hover:bg-accent',
          selected && 'bg-accent font-medium',
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            // Enter/Space on the toggle must not bubble to the row's
            // onKeyDown, which would also select the item.
            onKeyDown={(e) => {
              e.stopPropagation();
            }}
            className="shrink-0 text-muted-foreground"
            aria-label={expanded ? t('costPanel.collapse') : t('costPanel.expand')}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="truncate">{node.item.Name ?? t('costPanel.itemFallbackName', { id: node.ref.expressId })}</span>
        {node.item.Identification && (
          <span className="shrink-0 text-[10px] text-muted-foreground">{node.item.Identification}</span>
        )}
      </div>
      {hasChildren && expanded && node.children.map((child) => (
        <ItemRow
          key={`${child.ref.modelId}:${child.ref.expressId}`}
          node={child}
          depth={depth + 1}
          modelId={modelId}
          selectedRef={selectedRef}
          onSelectItem={onSelectItem}
        />
      ))}
    </div>
  );
}

function ModelSection({
  entry,
  federated,
  selectedRef,
  onSelectItem,
}: {
  entry: CostModelEntry;
  federated: boolean;
  selectedRef: EntityRefLike | null;
  onSelectItem: (modelId: string, ref: EntityRefLike) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="border-b p-2">
      {federated && (
        <div className="mb-1 truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {entry.modelName}
        </div>
      )}
      {entry.graph === null ? (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <RefreshCw className="h-3 w-3 shrink-0" />
          <span>{entry.error ? t('costPanel.dataUnavailableWithError', { message: entry.error }) : t('costPanel.dataUnavailable')}</span>
        </div>
      ) : !entry.graph.HasCostData ? (
        <div className="text-[11px] text-muted-foreground">{t('costPanel.empty')}</div>
      ) : (
        <CostGraphTree graph={entry.graph} modelId={entry.modelId} selectedRef={selectedRef} onSelectItem={onSelectItem} />
      )}
    </div>
  );
}

function CostGraphTree({
  graph,
  modelId,
  selectedRef,
  onSelectItem,
}: {
  graph: NonNullable<CostModelEntry['graph']>;
  modelId: string;
  selectedRef: EntityRefLike | null;
  onSelectItem: (modelId: string, ref: EntityRefLike) => void;
}) {
  const backend = useCostBackend();
  const tree = useMemo(() => buildCostTree(graph), [graph]);
  // MIXED_CURRENCY from arithmetic only appears in item evaluations, not in
  // the extraction diagnostics classifyCostModel reads; evaluate once per graph.
  const evaluationMixedCurrency = useMemo(() => {
    try {
      return treeHasMixedCurrencyEvaluation(tree, (ref) => backend.evaluateItem(ref));
    } catch (err) {
      console.warn('[CostTreeView] cost evaluation for the mixed-currency badge failed', err);
      return false;
    }
  }, [tree, backend]);
  const extractionState = classifyCostModel(graph);
  const state = { ...extractionState, mixedCurrency: extractionState.mixedCurrency || evaluationMixedCurrency };
  const { t } = useTranslation();
  return (
    <div>
      {(state.cyclic || state.mixedCurrency) && (
        <div className="mb-1 flex flex-wrap gap-1">
          {state.cyclic && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-2.5 w-2.5" /> {t('costPanel.cyclicBadge')}
            </span>
          )}
          {state.mixedCurrency && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              <Coins className="h-2.5 w-2.5" /> {t('costPanel.mixedCurrencyBadge')}
            </span>
          )}
        </div>
      )}
      {tree.schedules.map((schedule) => (
        <div key={`${modelId}:${schedule.ref.expressId}`} className="mb-1">
          <div className="truncate text-[11px] font-semibold">{schedule.schedule.Name ?? t('costPanel.scheduleFallbackName', { id: schedule.ref.expressId })}</div>
          {schedule.items.length === 0 ? (
            <div className="pl-4 text-[10px] text-muted-foreground">{t('costPanel.noItemsInSchedule')}</div>
          ) : (
            schedule.items.map((node) => (
              <ItemRow
                key={`${node.ref.modelId}:${node.ref.expressId}`}
                node={node}
                depth={1}
                modelId={modelId}
                selectedRef={selectedRef}
                onSelectItem={onSelectItem}
              />
            ))
          )}
        </div>
      ))}
      {tree.unassignedItems.length > 0 && (
        <div>
          <div className="truncate text-[11px] font-semibold text-muted-foreground">{t('costPanel.unassignedItems')}</div>
          {tree.unassignedItems.map((node) => (
            <ItemRow
              key={`${node.ref.modelId}:${node.ref.expressId}`}
              node={node}
              depth={1}
              modelId={modelId}
              selectedRef={selectedRef}
              onSelectItem={onSelectItem}
            />
          ))}
        </div>
      )}
      {tree.schedules.length === 0 && tree.unassignedItems.length === 0 && (
        <div className="text-[11px] text-muted-foreground">{t('costPanel.noItemsInModel')}</div>
      )}
    </div>
  );
}

export function CostTreeView({ entries, selectedRef, onSelectItem }: CostTreeViewProps) {
  const { t } = useTranslation();
  if (entries.length === 0) {
    return <div className="p-3 text-xs text-muted-foreground">{t('costPanel.noModelsLoaded')}</div>;
  }
  const federated = entries.length > 1;
  return (
    <div role="tree">
      {entries.map((entry) => (
        <ModelSection key={entry.modelId} entry={entry} federated={federated} selectedRef={selectedRef} onSelectItem={onSelectItem} />
      ))}
    </div>
  );
}
