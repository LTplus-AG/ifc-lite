/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens panel — rule-based 3D filtering and coloring
 *
 * Shows saved lens presets and allows activating/deactivating them.
 * Users can create, edit, and delete custom lenses with full rule editing.
 * Supports both manual rule-based lenses and auto-color lenses that
 * automatically color entities by distinct values of any IFC data column.
 * When a lens is active, a color legend displays the matched rules/values.
 * Unmatched entities are ghosted (semi-transparent) for visual context.
 *
 * All dropdowns are populated dynamically from the loaded model data
 * via discoveredLensData (IFC types, property sets, quantity sets,
 * classification systems, materials). No hardcoded IFC class lists.
 */

import { trackExportCompleted } from '@/lib/analytics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, EyeOff, Palette, Check, Plus, Trash2, Pencil, Copy, Save, Download, Upload, Sparkles, ArrowUpDown } from 'lucide-react';
import { discoverDataSources } from '@ifc-lite/lens';
import { emptyFilterGroup } from '@ifc-lite/rules';
import { SearchableSelect } from './SearchableSelect';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { downloadFile } from '@/lib/export/download';
import { toast } from '@/components/ui/toast';
import { tourAnchor, TOUR_ANCHORS, lensCardAnchor } from '@/lib/tours/anchors';
import { useViewerStore } from '@/store';
import { useLensDiscovery } from '@/hooks/useLensDiscovery';
import { createLensDataProvider } from '@/lib/lens';
import { buildAutoColorLensToSave, moveItem, cloneLensRules, isRuleValid } from './lens-editor-utils';
import { importLensFile } from './lens-import';
import { ruleIsolationOwnsChannel } from './lens-visibility-ownership';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import type { Lens, LensRule, AutoColorSpec, AutoColorLegendEntry, DiscoveredLensData } from '@/store/slices/lensSlice';
import { LENS_PALETTE, ENTITY_ATTRIBUTE_NAMES, AUTO_COLOR_SOURCES } from '@/store/slices/lensSlice';
import { useTranslation } from '@/i18n';
import { TYPE_LABEL_KEYS } from './lens-editor-labels';
import { LensRuleEditor } from './LensRuleEditor';
import { RuleRow, AutoColorRow } from './LensLegendRows';

interface LensPanelProps {
  onClose?: () => void;
}

// ─── Lens editor (create/edit mode) ─────────────────────────────────────────

function LensEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: Lens;
  onSave: (lens: Lens) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  // Editing a built-in or duplicate must not mutate the source's groups.
  const [rules, setRules] = useState<LensRule[]>(() => cloneLensRules(initial.rules));
  // Drag-to-reorder state. Rule order is meaningful: the engine applies the
  // first matching rule per entity, so order = priority. (#1403)
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const moveRule = (from: number, to: number) => {
    setRules((prev) => moveItem(prev, from, to));
  };

  const handleDrop = (to: number) => {
    setRules((prev) => (dragIndex === null ? prev : moveItem(prev, dragIndex, to)));
    setDragIndex(null);
    setDragOverIndex(null);
  };

  // Unique rule id: a random suffix (not the array length) so add / duplicate /
  // remove interleaving within one millisecond can never collide React keys. (#1460)
  const newRuleId = () => `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const addRule = () => {
    const colorIndex = rules.length % LENS_PALETTE.length;
    setRules([...rules, {
      id: newRuleId(),
      name: 'New Rule',
      enabled: true,
      groups: [emptyFilterGroup()],
      action: 'colorize',
      color: LENS_PALETTE[colorIndex],
    }]);
  };

  const updateRule = (index: number, patch: Partial<LensRule>) => {
    setRules((prev) => prev.map((r, i) => i === index ? { ...r, ...patch } : r));
  };

  const removeRule = (index: number) => {
    setRules(rules.filter((_, i) => i !== index));
  };

  // Clone the filter groups rather than sharing mutable chip arrays. (#1460)
  const duplicateRule = (index: number) => {
    setRules((prev) => {
      const src = prev[index];
      if (!src) return prev;
      const copy: LensRule = {
        ...src,
        id: newRuleId(),
        groups: structuredClone(src.groups),
        unreadableLegacy: src.unreadableLegacy ? structuredClone(src.unreadableLegacy) : undefined,
      };
      const next = [...prev];
      next.splice(index + 1, 0, copy);
      return next;
    });
  };

  const handleSave = () => {
    const validRules = rules.filter(isRuleValid);
    if (!name.trim() || validRules.length === 0) return;
    onSave({ ...initial, name: name.trim(), rules: validRules });
  };

  const canSave = name.trim().length > 0 && rules.some(isRuleValid);

  return (
    <div className="border-2 border-primary bg-white dark:bg-zinc-900 rounded-sm">
      {/* Name input */}
      <div className="px-3 pt-3 pb-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('lensPanel.editor.namePlaceholder')}
          className="w-full px-2 py-1.5 text-xs font-bold uppercase tracking-wider bg-zinc-50 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm placeholder:normal-case placeholder:font-normal placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
          autoFocus
        />
      </div>

      {/* Rules */}
      <div className="border-t border-zinc-200 dark:border-zinc-700 py-1 bg-zinc-50/50 dark:bg-zinc-800/50">
        {rules.map((rule, i) => (
          <LensRuleEditor
            key={rule.id}
            rule={rule}
            index={i}
            onChange={(patch) => updateRule(i, patch)}
            onRemove={() => removeRule(i)}
            onDuplicate={() => duplicateRule(i)}
            isDragging={dragIndex === i}
            isDragOver={dragOverIndex === i && dragIndex !== null && dragIndex !== i}
            // Indicator edge matches where moveItem lands the rule: a downward
            // drag (source above target) lands below the hovered row. (#1403)
            dropEdge={dragIndex !== null && dragIndex < i ? 'bottom' : 'top'}
            onDragStart={rules.length > 1 ? setDragIndex : undefined}
            onDragEnter={setDragOverIndex}
            onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
            onDrop={dragIndex !== null ? handleDrop : undefined /* a file drag is not a reorder (#5845) */}
            onMove={rules.length > 1 ? moveRule : undefined}
          />
        ))}

        <button
          onClick={addRule}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary hover:text-primary/80 w-full"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('lensPanel.editor.addRule')}
        </button>
      </div>

      {/* Actions */}
      <div className="flex gap-1.5 p-2 border-t border-zinc-200 dark:border-zinc-700">
        <Button
          variant="default"
          size="sm"
          className="flex-1 h-7 text-[10px] uppercase tracking-wider rounded-sm"
          onClick={handleSave}
          disabled={!canSave}
        >
          <Save className="h-3 w-3 mr-1" />
          {t('lensPanel.editor.save')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[10px] uppercase tracking-wider rounded-sm"
          onClick={onCancel}
        >
          {t('lensPanel.editor.cancel')}
        </Button>
      </div>
    </div>
  );
}

// ─── Auto-color lens editor ─────────────────────────────────────────────────

export function AutoColorEditor({
  initial,
  onSave,
  onCancel,
  discovered,
  onRequestDiscovery,
}: {
  initial: { id?: string; name: string; autoColor: AutoColorSpec };
  onSave: (lens: Lens) => void;
  onCancel: () => void;
  discovered: DiscoveredLensData | null;
  onRequestDiscovery: (categories: { properties?: boolean; quantities?: boolean; classifications?: boolean; materials?: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [source, setSource] = useState<AutoColorSpec['source']>(initial.autoColor.source);
  const [psetName, setPsetName] = useState(initial.autoColor.psetName ?? '');
  const [propertyName, setPropertyName] = useState(initial.autoColor.propertyName ?? '');
  // Opt-in "unclassified bucket" toggle (#unclassified-bucket) - meaningless
  // outside `source: 'classification'`, so it's only rendered there. Not
  // reset on source change like psetName/propertyName: if the user flips
  // away from classification and back, restoring their choice is friendlier
  // than silently discarding it, and the flag is dropped from the saved
  // spec entirely when the source isn't classification (see handleSave).
  const [includeUnclassified, setIncludeUnclassified] = useState(initial.autoColor.includeUnclassified ?? false);

  const needsPset = source === 'property' || source === 'quantity' || source === 'classification';
  const needsPropertyName = source === 'attribute' || source === 'property' || source === 'quantity';

  // Trigger lazy discovery when source changes to a category that needs it
  useEffect(() => {
    if (!discovered) return;
    if (source === 'property' && !discovered.propertySets) {
      onRequestDiscovery({ properties: true });
    } else if (source === 'quantity' && !discovered.quantitySets) {
      onRequestDiscovery({ quantities: true });
    } else if (source === 'material' && !discovered.materials) {
      onRequestDiscovery({ materials: true });
    } else if (source === 'classification' && !discovered.classificationSystems) {
      onRequestDiscovery({ classifications: true });
    }
  }, [source, discovered, onRequestDiscovery]);

  // Dynamic options from discovered data
  const psetOptions = useMemo(() => {
    if (!discovered) return [];
    if (source === 'quantity') return discovered.quantitySets ? Array.from(discovered.quantitySets.keys()).sort() : [];
    if (source === 'classification') return discovered.classificationSystems ?? [];
    return discovered.propertySets ? Array.from(discovered.propertySets.keys()).sort() : [];
  }, [discovered, source]);

  const propertyOptions = useMemo(() => {
    if (!discovered) return [];
    if (source === 'property') return discovered.propertySets?.get(psetName) ?? [];
    if (source === 'quantity') return discovered.quantitySets?.get(psetName) ?? [];
    return [];
  }, [discovered, source, psetName]);

  const handleSave = () => {
    if (!name.trim()) return;
    if (needsPset && !psetName.trim()) return;
    if (needsPropertyName && !propertyName.trim()) return;

    const autoColor: AutoColorSpec = { source };
    if (needsPset) autoColor.psetName = psetName.trim();
    if (needsPropertyName) autoColor.propertyName = propertyName.trim();
    // Only emitted when true, on a classification source: unset/false must
    // reproduce the pre-existing ghosting behaviour exactly (see
    // AutoColorSpec.includeUnclassified in @ifc-lite/lens), and the flag is
    // meaningless on any other source.
    if (source === 'classification' && includeUnclassified) autoColor.includeUnclassified = true;

    onSave(buildAutoColorLensToSave(
      initial,
      { name: name.trim(), autoColor },
      () => `lens-auto-${Date.now()}`,
    ));
  };

  const canSave = name.trim().length > 0
    && (!needsPset || psetName.trim().length > 0)
    && (!needsPropertyName || propertyName.trim().length > 0);

  const selectClass = 'text-xs px-1.5 py-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm';

  return (
    <div className="border-2 border-primary bg-white dark:bg-zinc-900 rounded-sm">
      <div className="px-3 pt-3 pb-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('lensPanel.autoColor.namePlaceholder')}
          className="w-full px-2 py-1.5 text-xs font-bold uppercase tracking-wider bg-zinc-50 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm placeholder:normal-case placeholder:font-normal placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
          autoFocus
        />
      </div>

      <div className="border-t border-zinc-200 dark:border-zinc-700 px-3 py-2 space-y-2 bg-zinc-50/50 dark:bg-zinc-800/50">
        <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          <Sparkles className="h-3 w-3" />
          <span>{t('lensPanel.autoColor.byDistinctValues')}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500 w-[50px]">{t('lensPanel.autoColor.sourceLabel')}</label>
          <select
            value={source}
            onChange={(e) => {
              const s = e.target.value as AutoColorSpec['source'];
              setSource(s);
              setPsetName('');
              setPropertyName('');
              if (!name || name.startsWith('Color by ')) {
                setName(`Color by ${t(TYPE_LABEL_KEYS[s])}`);
              }
            }}
            className={cn(selectClass, 'flex-1')}
          >
            {AUTO_COLOR_SOURCES.map(s => (
              <option key={s} value={s}>{t(TYPE_LABEL_KEYS[s])}</option>
            ))}
          </select>
        </div>

        {needsPset && (
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 w-[50px]">
              {source === 'property' ? t('lensPanel.autoColor.psetLabel') : source === 'classification' ? t('lensPanel.autoColor.systemLabel') : t('lensPanel.autoColor.qsetLabel')}
            </label>
            <SearchableSelect
              value={psetName}
              options={psetOptions}
              onChange={(v) => { setPsetName(v); setPropertyName(''); }}
              placeholder={source === 'property' ? t('lensPanel.autoColor.selectPropertySetPlaceholder') : source === 'classification' ? t('lensPanel.autoColor.selectSystemPlaceholder') : t('lensPanel.autoColor.selectQuantitySetPlaceholder')}
              className="flex-1"
            />
          </div>
        )}

        {needsPropertyName && (
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 w-[50px]">{t('lensPanel.autoColor.nameLabel')}</label>
            {source === 'attribute' ? (
              <select
                value={propertyName}
                onChange={(e) => setPropertyName(e.target.value)}
                className={cn(selectClass, 'flex-1')}
              >
                <option value="">{t('lensPanel.autoColor.selectPlaceholderOption')}</option>
                {ENTITY_ATTRIBUTE_NAMES.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            ) : (
              <SearchableSelect
                value={propertyName}
                options={propertyOptions}
                onChange={setPropertyName}
                placeholder={source === 'property' ? t('lensPanel.autoColor.selectPropertyPlaceholder') : t('lensPanel.autoColor.selectQuantityPlaceholder')}
                className="flex-1"
              />
            )}
          </div>
        )}

        {source === 'classification' && (
          <label className="flex items-center justify-between gap-2 cursor-pointer pt-0.5">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">{t('lensPanel.autoColor.showUnclassified')}</span>
            <input
              type="checkbox"
              checked={includeUnclassified}
              onChange={(e) => setIncludeUnclassified(e.target.checked)}
              className="accent-primary"
            />
          </label>
        )}
      </div>

      <div className="flex gap-1.5 p-2 border-t border-zinc-200 dark:border-zinc-700">
        <Button
          variant="default"
          size="sm"
          className="flex-1 h-7 text-[10px] uppercase tracking-wider rounded-sm"
          onClick={handleSave}
          disabled={!canSave}
        >
          <Save className="h-3 w-3 mr-1" />
          {t('lensPanel.editor.save')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[10px] uppercase tracking-wider rounded-sm"
          onClick={onCancel}
        >
          {t('lensPanel.editor.cancel')}
        </Button>
      </div>
    </div>
  );
}

// ─── Lens card (read-only display) ──────────────────────────────────────────

function LensCard({
  lens,
  isActive,
  onToggle,
  onEdit,
  onDuplicate,
  onDelete,
  isolatedRuleId,
  onIsolateRule,
  ruleCounts,
  autoColorLegend,
}: {
  lens: Lens;
  isActive: boolean;
  onToggle: (id: string) => void;
  onEdit?: (lens: Lens) => void;
  onDuplicate?: (id: string) => void;
  onDelete?: (id: string) => void;
  isolatedRuleId?: string | null;
  onIsolateRule?: (ruleId: string) => void;
  ruleCounts?: Map<string, number>;
  autoColorLegend?: AutoColorLegendEntry[];
}) {
  const { t } = useTranslation();
  const isAutoColor = !!lens.autoColor;
  const enabledRuleCount = lens.rules.filter(r => r.enabled).length;
  const [legendSort, setLegendSort] = useState<'count' | 'name-asc' | 'name-desc'>('count');

  const legendToShow = useMemo(() => {
    if (!isAutoColor || !autoColorLegend) return undefined;
    if (legendSort === 'count') return autoColorLegend; // already sorted by count desc from engine
    const sorted = [...autoColorLegend];
    if (legendSort === 'name-asc') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else sorted.sort((a, b) => b.name.localeCompare(a.name));
    return sorted;
  }, [isAutoColor, autoColorLegend, legendSort]);

  const cycleLegendSort = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setLegendSort(prev => prev === 'count' ? 'name-asc' : prev === 'name-asc' ? 'name-desc' : 'count');
  }, []);

  const sortLabel = legendSort === 'count'
    ? t('lensPanel.card.sortCount')
    : legendSort === 'name-asc' ? t('lensPanel.card.sortNameAsc') : t('lensPanel.card.sortNameDesc');

  return (
    /* Nested legend and action buttons prevent a native wrapper button; the header button supplies keyboard activation. */
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      className={cn(
        'border-2 transition-colors group rounded-sm',
        isActive
          ? 'border-primary bg-white dark:bg-zinc-900'
          : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:border-zinc-400 dark:hover:border-zinc-500',
      )}
      onClick={(event) => {
        if (!(event.target as Element).closest('button')) onToggle(lens.id);
      }}
      {...tourAnchor(lensCardAnchor(lens.id))}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <button
          type="button"
          aria-pressed={isActive}
          onClick={() => onToggle(lens.id)}
          className="flex flex-1 items-center justify-between gap-2 min-w-0 self-stretch cursor-pointer text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          {isActive ? (
            <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />
          ) : isAutoColor ? (
            <Sparkles className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
          ) : (
            <Palette className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
          )}
          <span className="text-xs font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-100 truncate">
            {lens.name}
          </span>
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-mono ml-auto shrink-0">
            {isAutoColor ? t(TYPE_LABEL_KEYS[lens.autoColor!.source]) : t('lensPanel.card.ruleCount', { count: enabledRuleCount })}
          </span>
        </button>
        <div className="flex items-center gap-1">
          {onDuplicate && (
            <button
              onClick={(e) => { e.stopPropagation(); onDuplicate(lens.id); }}
              className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 p-0.5"
              title={lens.builtin ? t('lensPanel.card.duplicateBuiltinTooltip') : t('lensPanel.card.duplicateTooltip')}
            >
              <Copy className="h-3 w-3" />
            </button>
          )}
          {onEdit && !lens.builtin && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(lens); }}
              className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 p-0.5"
              title={t('lensPanel.card.editTooltip')}
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {!lens.builtin && onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(lens.id); }}
              className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400 p-0.5"
              title={t('lensPanel.card.deleteTooltip')}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      {isActive && legendToShow && legendToShow.length > 0 && (
        <div className="border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60" {...tourAnchor(TOUR_ANCHORS.lensLegend)}>
          <div className="flex items-center justify-between px-3 py-1 border-b border-zinc-200/60 dark:border-zinc-700/60">
            <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-medium">
              {t('lensPanel.card.legendValuesCount', { count: legendToShow.length })}
            </span>
            <button
              onClick={cycleLegendSort}
              className="flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300"
              title={t('lensPanel.card.sortLegendTooltip')}
            >
              <ArrowUpDown className="h-2.5 w-2.5" />
              {sortLabel}
            </button>
          </div>
          <div className="max-h-[220px] overflow-y-auto py-0.5">
          {legendToShow.map(entry => (
            <AutoColorRow
              key={entry.id}
              entry={entry}
              isIsolated={isolatedRuleId === entry.id}
              onClick={onIsolateRule ? () => onIsolateRule(entry.id) : undefined}
            />
          ))}
          </div>
        </div>
      )}

      {/* Rule-based color legend (shown when active + rule lens) */}
      {isActive && !isAutoColor && (
        <div className="border-t border-zinc-200 dark:border-zinc-700 py-0.5 bg-zinc-50 dark:bg-zinc-800/60" {...tourAnchor(TOUR_ANCHORS.lensLegend)}>
          {lens.rules.map(rule => {
            const count = ruleCounts?.get(rule.id) ?? 0;
            return (
              <RuleRow
                key={rule.id}
                rule={rule}
                count={count}
                isIsolated={isolatedRuleId === rule.id}
                onClick={onIsolateRule ? () => onIsolateRule(rule.id) : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main panel ─────────────────────────────────────────────────────────────

export function LensPanel({ onClose }: LensPanelProps) {
  const { t } = useTranslation();
  const activeLensId = useViewerStore((s) => s.activeLensId);
  const savedLenses = useViewerStore((s) => s.savedLenses);
  // Discovery feeds this panel's rule pickers only; evaluation is the
  // always-mounted `LensRuntimeHost`'s.
  useLensDiscovery();
  const setActiveLens = useViewerStore((s) => s.setActiveLens);
  const createLens = useViewerStore((s) => s.createLens);
  const updateLens = useViewerStore((s) => s.updateLens);
  const deleteLens = useViewerStore((s) => s.deleteLens);
  const duplicateLens = useViewerStore((s) => s.duplicateLens);
  const importLenses = useViewerStore((s) => s.importLenses);
  const exportLenses = useViewerStore((s) => s.exportLenses);
  const isolateEntities = useViewerStore((s) => s.isolateEntities);
  const clearIsolation = useViewerStore((s) => s.clearIsolation);
  // Viewport's aggregation resolver (#2531): rule isolation runs a rule's
  // matches through it so a geometry-less assembly isolates as its parts.
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  // Rule-isolation ownership lives in the STORE (not component state/refs) so
  // a panel unmount/remount cannot strand an isolation it can no longer release.
  const lensRuleIsolation = useViewerStore((s) => s.lensRuleIsolation);
  const setLensRuleIsolation = useViewerStore((s) => s.setLensRuleIsolation);
  // Footer count only: useLens pushes colours via pendingColorUpdates, so no effect keys off this and `.size` is safe (#5206).
  const lensColorMapSize = useViewerStore((s) => s.lensColorMap.size);
  const lensHiddenCount = useViewerStore((s) => s.lensHiddenIds.size); // footer count only
  const lensRuleCounts = useViewerStore((s) => s.lensRuleCounts);
  const lensAutoColorLegend = useViewerStore((s) => s.lensAutoColorLegend);
  // Discovered data from loaded models (classes = instant, rest = lazy)
  const discoveredLensData = useViewerStore((s) => s.discoveredLensData);
  const mergeDiscoveredData = useViewerStore((s) => s.mergeDiscoveredData);

  // Track which categories are currently being discovered (prevent double-fire)
  const discoveringRef = useRef(new Set<string>());

  // Reset discovery flags when discoveredLensData changes (e.g. new model loaded)
  useEffect(() => {
    if (!discoveredLensData) {
      discoveringRef.current.clear();
    }
  }, [discoveredLensData]);

  /** Trigger lazy discovery for expensive data categories (psets, quantities, etc.) */
  const handleRequestDiscovery = useCallback((categories: { properties?: boolean; quantities?: boolean; classifications?: boolean; materials?: boolean }) => {
    // Skip categories already discovered or in-flight
    const toDiscover: typeof categories = {};
    const current = useViewerStore.getState().discoveredLensData;
    if (!current) return;

    if (categories.properties && !current.propertySets && !discoveringRef.current.has('properties')) {
      toDiscover.properties = true;
      discoveringRef.current.add('properties');
    }
    if (categories.quantities && !current.quantitySets && !discoveringRef.current.has('quantities')) {
      toDiscover.quantities = true;
      discoveringRef.current.add('quantities');
    }
    if (categories.classifications && !current.classificationSystems && !discoveringRef.current.has('classifications')) {
      toDiscover.classifications = true;
      discoveringRef.current.add('classifications');
    }
    if (categories.materials && !current.materials && !discoveringRef.current.has('materials')) {
      toDiscover.materials = true;
      discoveringRef.current.add('materials');
    }

    if (Object.keys(toDiscover).length === 0) return;

    // Run discovery async to not block the UI
    setTimeout(() => {
      const { models, ifcDataStore, mutationViews, resolveGlobalIdFromModels } = useViewerStore.getState();
      if (models.size === 0 && !ifcDataStore) return;
      const provider = createLensDataProvider(models, ifcDataStore, mutationViews, resolveGlobalIdFromModels);
      const result = discoverDataSources(provider, toDiscover);
      mergeDiscoveredData(result);
    }, 0);
  }, [mergeDiscoveredData]);

  // Editor state: null = not editing, Lens object = editing/creating
  const [editingLens, setEditingLens] = useState<Lens | null>(null);
  const [creatingAutoColor, setCreatingAutoColor] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Rule isolation applied by the lens (persisted in the store so it survives
  // panel remounts). Only the ruleId is needed for the card highlight.
  const isolatedRuleId = lensRuleIsolation?.ruleId ?? null;

  /**
   * Release the lens's rule isolation. Clears the shared isolation channel
   * ONLY if the lens still owns it (the channel still holds exactly the ids
   * the rule click applied) — if the user or the basket has isolated something
   * else since, their isolation is left alone and only the stale claim drops.
   */
  const releaseRuleIsolation = useCallback(() => {
    const state = useViewerStore.getState();
    const isolation = state.lensRuleIsolation;
    if (!isolation) return;
    if (ruleIsolationOwnsChannel(state.isolatedEntities, isolation.entityIds)) {
      clearIsolation();
    }
    setLensRuleIsolation(null);
  }, [clearIsolation, setLensRuleIsolation]);

  const handleToggle = useCallback((id: string) => {
    // Release any rule-isolation this lens applied (both when turning it off
    // and when switching to another lens). The sync effect below restores the
    // lens-owned hidden ids — so no showAll(), which would nuke the user's
    // own visibility.
    releaseRuleIsolation();
    if (activeLensId === id) {
      setActiveLens(null);
    } else {
      setActiveLens(id);
    }
  }, [activeLensId, setActiveLens, releaseRuleIsolation]);

  /** Click a rule/value row in the active lens to isolate matching entities */
  const handleIsolateRule = useCallback((ruleId: string) => {
    // Toggle off if clicking the already-isolated rule
    if (useViewerStore.getState().lensRuleIsolation?.ruleId === ruleId) {
      releaseRuleIsolation();
      return;
    }

    // Look up entities matched by this specific rule/value
    const matchingIds = useViewerStore.getState().lensRuleEntityIds.get(ruleId);
    if (!matchingIds || matchingIds.length === 0) return;

    // A geometry-less assembly (IfcElementAssembly, an IfcStair used as a
    // container, ...) owns no mesh: its geometry hangs off the
    // IfcRelAggregates parts, and the renderer resolves `isolatedEntities`
    // against mesh ids directly (viewportUtils' buildRenderOptions ->
    // `isolatedIds`). Isolating the bare matched id therefore blanks the view.
    // Resolve through the Viewport channel #2531 added (`resolveHighlightIds`,
    // backed by expandToGeometryBearingIds), exactly as SearchModal.text.tsx's
    // commit and SearchModal.filter.tsx's "Isolate in 3D" (#2660) do: a
    // geometry-bearing id passes through untouched and deduplicated, a
    // geometry-less one is replaced by its geometry-bearing parts.
    //
    // Resolved ids are APPENDED to the raw matches, never substituted (#2680),
    // via `resolvePresentationIds`. The resolver bounds-checks against the
    // type-visibility FILTERED mesh list -- TYPE_VISIBILITY_SEMANTIC_DEFAULTS
    // starts `spaces`/`spatialZones`/`openings`/`virtualElements` OFF -- so a
    // rule matching walls AND spaces resolves the walls, returns non-empty,
    // and the spaces would silently drop under replace semantics; carrying an
    // id that owns no mesh is free, it just never matches the whitelist.
    //
    // An empty resolve keeps the raw ids rather than isolating nothing: `[]`
    // is also what a set hidden by a type toggle, or one whose meshes have
    // not streamed in yet, answers, and isolating an empty set hides the
    // ENTIRE model. See `resolvePresentationIds` for why the three cases cannot
    // be told apart here.
    //
    // #2660's second fallback -- walking IfcRelAggregates when the resolver
    // is empty because the parts are HIDDEN types -- is deliberately not
    // replicated here: `expandFilterRowsThroughAggregation` consumes
    // filter-result rows, not a lens rule's globalIds, and only pays off next
    // to a type-visibility gate the lens panel doesn't have. Adding one is a
    // feature, not this fix.
    const isolationIds = resolvePresentationIds(cameraCallbacks.resolveHighlightIds, matchingIds);

    // `isolateEntities` is a same-set TOGGLE (visibilitySlice.ts, `isolateEntities`): if
    // the channel already holds exactly these ids it CLEARS instead of
    // isolating. Switching from rule A to a rule B that lands on the SAME set
    // would therefore un-isolate the model while the record below claims B
    // owns an isolation that no longer exists -- and the next release, finding
    // an empty channel, would disown it silently.
    //
    // This is PRE-EXISTING and the resolution above does not widen it: two
    // rules whose criteria differ but whose matches coincide ("walls with a
    // fire rating of 60" and "walls on level 2" over a model where those are
    // the same walls) always collided this way, and appending the raw matches
    // unconditionally keeps every other pair distinguishable -- an
    // assembly-matching rule yields {assembly, ...parts} while a
    // parts-matching rule yields {...parts}, sets that differ by the
    // assembly's own id and cannot collapse onto each other.
    //
    // Release the channel first so the isolate call below always takes its
    // isolate branch -- same
    // `ruleIsolationOwnsChannel` set-equality predicate the teardown path uses,
    // so both ends agree on when the channel holds a given set, and the
    // re-isolate re-runs the un-hide the toggle branch would have skipped.
    // Clicking the SAME rule again still un-isolates: that path returned above.
    if (ruleIsolationOwnsChannel(useViewerStore.getState().isolatedEntities, isolationIds)) {
      clearIsolation();
    }
    isolateEntities(isolationIds);
    // Record ownership: rule id + the exact ids pushed into the channel, so a
    // later release can verify the channel still holds what the lens applied.
    // These MUST be the ids just isolated, not the raw matches: releaseRuleIsolation
    // compares this record set-wise against the channel
    // (ruleIsolationOwnsChannel), so recording the raw matches while pushing
    // the expanded ones makes the lens disown its own isolation and the
    // un-isolate click leaves the model stuck isolated.
    setLensRuleIsolation({ ruleId, entityIds: [...isolationIds] });
  }, [cameraCallbacks, clearIsolation, isolateEntities, releaseRuleIsolation, setLensRuleIsolation]);

  const handleNewLens = useCallback(() => {
    setCreatingAutoColor(false);
    setEditingLens({
      id: `lens-${Date.now()}`,
      name: '',
      rules: [],
    });
  }, []);

  const handleNewAutoColorLens = useCallback(() => {
    setEditingLens(null);
    setCreatingAutoColor(true);
  }, []);

  // `lens` is the SAME object the store holds in `savedLenses` - a shallow
  // `{ ...r }` per rule would still alias a compound rule's `conditions`
  // array with the store's copy, so an edit-then-cancel-elsewhere sequence
  // (or a future in-place mutation) could corrupt the saved lens.
  const handleEditLens = useCallback((lens: Lens) => {
    setEditingLens({ ...lens, rules: cloneLensRules(lens.rules) });
  }, []);

  /** Duplicate a lens (incl. a builtin) and open the editable copy for editing. */
  const handleDuplicateLens = useCallback((id: string) => {
    const result = duplicateLens(id);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    const copy = result.lens;
    if (!copy) return;
    setCreatingAutoColor(false);
    setEditingLens({ ...copy, rules: cloneLensRules(copy.rules) });
  }, [duplicateLens]);

  const handleSaveLens = useCallback((lens: Lens) => {
    const exists = savedLenses.some(l => l.id === lens.id);
    const result = exists
      ? updateLens(lens.id, { name: lens.name, rules: lens.rules, autoColor: lens.autoColor })
      : createLens(lens);
    if (!result.ok) {
      // The store rejected the edit because it could not be persisted. Keep the
      // editor open so the user's work is still there to retry or export,
      // rather than closing over a lens that was never saved.
      toast.error(result.message);
      return;
    }
    setEditingLens(null);
    setCreatingAutoColor(false);
  }, [savedLenses, createLens, updateLens]);

  const handleDeleteLens = useCallback((id: string) => {
    if (activeLensId === id) {
      // Deactivate first — the sync effect below un-hides the lens-owned
      // hidden ids. Release only the lens's own rule-isolation, never a
      // global showAll().
      releaseRuleIsolation();
      setActiveLens(null);
    }
    // A delete that could not be persisted is not applied: the lens stays in
    // the list (merely deactivated, which is not persisted state anyway) so it
    // cannot reappear out of nowhere on the next reload.
    const result = deleteLens(id);
    if (!result.ok) toast.error(result.message);
  }, [activeLensId, setActiveLens, deleteLens, releaseRuleIsolation]);

  const handleExport = useCallback(() => {
    downloadFile(JSON.stringify(exportLenses(), null, 2), 'lenses.json', 'application/json');
    trackExportCompleted({ format: 'json', surface: 'lens_panel' });
  }, [exportLenses]);
  const handleImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    // Upsert-by-id happens in the store (mergeImportedLenses), so this just
    // hands it the parsed value normalized to an array. Re-importing an
    // edited export updates lenses in place instead of no-op'ing. (#1403)
    // `importLensFile` wires BOTH `FileReader#onload` and `#onerror` — a read
    // that fails (removed/unreadable file) reports a failure here instead of
    // never resolving at all (PR #2091 review).
    void importLensFile(file, importLenses).then((result) => {
      if (!result.ok) toast.error(result.message);
    });
  }, [importLenses]);

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-primary" />
          <h2 className="font-bold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">
            {t('lensPanel.title')}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 rounded-sm"
            onClick={handleExport}
            title={t('lensPanel.exportTooltip')}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 rounded-sm"
            onClick={() => fileInputRef.current?.click()}
            title={t('lensPanel.importTooltip')}
          >
            <Upload className="h-3.5 w-3.5" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImport}
          />
          {activeLensId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[10px] uppercase tracking-wider rounded-sm"
              onClick={() => {
                // Release the lens's own rule-isolation; the sync effect
                // restores the lens-owned hidden ids. No showAll() — keep
                // the user's hides.
                releaseRuleIsolation();
                setActiveLens(null);
              }}
              {...tourAnchor(TOUR_ANCHORS.lensClear)}
            >
              <EyeOff className="h-3 w-3 mr-1" />
              {t('lensPanel.clearButton')}
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 rounded-sm"
              aria-label={t('lensPanel.closeAriaLabel')}
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Lens list + editor */}
      <div className="flex-1 overflow-auto p-3 space-y-2" {...tourAnchor(TOUR_ANCHORS.lensList)}>
        {savedLenses.length === 0 && !editingLens && !creatingAutoColor && (
          <EmptyState icon={<Palette className="size-8" />} title={t('lensPanel.emptyTitle')} description={t('lensPanel.emptyDescription')} />
        )}
        {savedLenses.map(lens => (
          editingLens?.id === lens.id ? (
            editingLens.autoColor ? (
              <AutoColorEditor
                key={lens.id}
                initial={{ id: editingLens.id, name: editingLens.name, autoColor: editingLens.autoColor }}
                onSave={handleSaveLens}
                onCancel={() => setEditingLens(null)}
                discovered={discoveredLensData}
                onRequestDiscovery={handleRequestDiscovery}
              />
            ) : (
              <LensEditor
                key={lens.id}
                initial={editingLens}
                onSave={handleSaveLens}
                onCancel={() => setEditingLens(null)}
              />
            )
          ) : (
            <LensCard
              key={lens.id}
              lens={lens}
              isActive={activeLensId === lens.id}
              onToggle={handleToggle}
              onEdit={handleEditLens}
              onDuplicate={handleDuplicateLens}
              onDelete={handleDeleteLens}
              isolatedRuleId={activeLensId === lens.id ? isolatedRuleId : null}
              onIsolateRule={activeLensId === lens.id ? handleIsolateRule : undefined}
              ruleCounts={activeLensId === lens.id ? lensRuleCounts : undefined}
              autoColorLegend={activeLensId === lens.id ? lensAutoColorLegend : undefined}
            />
          )
        ))}

        {/* New lens editor (when creating rule-based lens) */}
        {editingLens && !savedLenses.some(l => l.id === editingLens.id) && (
          <LensEditor
            initial={editingLens}
            onSave={handleSaveLens}
            onCancel={() => setEditingLens(null)}
          />
        )}

        {/* Auto-color editor (when creating auto-color lens) */}
        {creatingAutoColor && (
          <AutoColorEditor
            initial={{ name: 'Color by IFC Class', autoColor: { source: 'ifcType' } }}
            onSave={handleSaveLens}
            onCancel={() => setCreatingAutoColor(false)}
            discovered={discoveredLensData}
            onRequestDiscovery={handleRequestDiscovery}
          />
        )}

        {/* New lens buttons */}
        {!editingLens && !creatingAutoColor && (
          <div className="space-y-1.5">
            <button
              onClick={handleNewLens}
              className="w-full border-2 border-dashed border-zinc-300 dark:border-zinc-600 hover:border-primary dark:hover:border-primary py-2.5 flex items-center justify-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-primary transition-colors rounded-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('lensPanel.newRuleLensButton')}
            </button>
            <button
              onClick={handleNewAutoColorLens}
              className="w-full border-2 border-dashed border-zinc-300 dark:border-zinc-600 hover:border-primary dark:hover:border-primary py-2.5 flex items-center justify-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-primary transition-colors rounded-sm"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t('lensPanel.newAutoColorLensButton')}
            </button>
          </div>
        )}
      </div>

      {/* Status footer */}
      <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-600 dark:text-zinc-400 text-center bg-zinc-50 dark:bg-zinc-900 font-mono">
        {activeLensId
          ? t('lensPanel.footer.active', {
              colored: lensColorMapSize,
              hidden: lensHiddenCount > 0
                ? t('lensPanel.footer.hiddenCount', { count: lensHiddenCount })
                : t('lensPanel.footer.ghosted'),
            })
          : t('lensPanel.footer.clickToActivate')}
      </div>
    </div>
  );
}
