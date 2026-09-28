/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector's Material layers section (charter #6232, M2 §1.7.3):
 * rows of thickness and material, outermost first, applied as ONE
 * transaction to the element or to its type.
 *
 * Applying writes any new IfcMaterial, the IfcMaterialLayerSet, and then
 * either an IfcMaterialLayerSetUsage on the element (across a wall, centred
 * on its axis; up through a slab) or the set on the type, each through
 * IfcRelAssociatesMaterial. A wall then takes the layers' total thickness.
 * In defaults mode "Element" means every element the command builds next.
 */

import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { materialsOf, type LayerRow, type LiveModel } from '@/lib/commands/modeling/authored-kinds';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import { InspectorCaption, InspectorSection } from './InspectorControls';
import { METRE_SYMBOL, formatMetres, parseMetres } from './inspector-fields';
import { applyMaterialLayers, type LayerInput } from './inspector-edits';

const NONE = 'none';
const NEW = 'new';

interface DraftRow {
  readonly key: number;
  readonly thickness: string;
  /** `none`, `new`, or an IfcMaterial express id. */
  readonly material: string;
  readonly newName: string;
}

type Target = 'element' | 'type';

export interface LayersSectionProps {
  modelId: string;
  live: LiveModel;
  kind: AuthoredElementKind;
  /** The layers applied now (the element's, or the defaults'), outermost first. */
  initial: readonly LayerRow[];
  /** Where `initial` comes from, when it is the element's type. */
  inheritedFromType?: boolean;
  /** The element to layer; absent in defaults mode. */
  elementId?: number;
  /** The element's (or the defaults') type, which "Apply to Type" writes to. */
  typeId: number | null;
  /** The new element thickness a wall gets, so the section can say so. */
  defaultThickness: number;
}

let nextKey = 0;
const row = (thickness: number, material: number | null): DraftRow =>
  ({ key: nextKey++, thickness: formatMetres(thickness), material: material === null ? NONE : String(material), newName: '' });

export function LayersSection({ modelId, live, kind, initial, inheritedFromType, elementId, typeId, defaultThickness }: LayersSectionProps) {
  const { t } = useTranslation();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const materials = useMemo(() => { void mutationVersion; return materialsOf(live); }, [live, mutationVersion]);
  const [rows, setRows] = useState<DraftRow[]>(() => (initial.length > 0
    ? initial.map((layer) => row(layer.thickness, layer.materialId))
    : [row(defaultThickness, null)]));
  const [picked, setTarget] = useState<Target>('element');
  const target: Target = typeId === null ? 'element' : picked;
  const total = rows.reduce((sum, r) => sum + (parseMetres(r.thickness) ?? 0), 0);
  const update = (key: number, patch: Partial<DraftRow>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const apply = () => {
    const parsed = rows.map((r) => ({ thickness: parseMetres(r.thickness), material: r.material, name: r.newName.trim() }));
    if (parsed.some((l) => l.thickness === null)) { toast.error(t('modelInspector.layers.needLayer')); return; }
    if (parsed.some((l) => l.material === NEW && !l.name)) { toast.error(t('modelInspector.layers.needName')); return; }
    const layers: LayerInput[] = parsed.map((l) => ({
      thickness: l.thickness ?? 0,
      material: l.material === NEW ? { name: l.name } : l.material === NONE ? null : { id: Number(l.material) },
    }));
    const layerSetId = applyMaterialLayers(modelId, { kind, layers, target, elementId, typeId });
    if (layerSetId !== null && elementId === undefined && target === 'element') {
      const s = useViewerStore.getState();
      s.setAuthoringDefaults({ layerSetIds: { ...s.authoringDefaults.layerSetIds, [kind]: { modelId, expressId: layerSetId } } });
      // The next wall is built as thick as its layers, as a layered selected wall is.
      if (kind === 'wall') s.setAuthoringDims('wall', { Thickness: layers.reduce((sum, l) => sum + l.thickness, 0) });
    }
  };

  return (
    <InspectorSection
      title={t('modelInspector.layers.title')}
      aside={<span className="text-2xs tabular-nums text-muted-foreground">{t('modelInspector.layers.total', { total: formatMetres(total) })}</span>}
    >
      {inheritedFromType && <InspectorCaption>{t('modelInspector.layers.viaType')}</InspectorCaption>}
      <ol className="space-y-1.5">
        {rows.map((r, index) => (
          <LayerRowEditor
            key={r.key}
            n={index + 1}
            row={r}
            materials={materials}
            onChange={(patch) => update(r.key, patch)}
            onRemove={rows.length > 1 ? () => setRows((all) => all.filter((x) => x.key !== r.key)) : undefined}
          />
        ))}
      </ol>
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-2xs" onClick={() => setRows((all) => [...all, row(0.05, null)])}>
          <Plus aria-hidden className="!size-3.5" />
          {t('modelInspector.layers.add')}
        </Button>
        <div className="flex items-center gap-1.5">
          <span className="text-2xs text-muted-foreground">{t('modelInspector.layers.applyTo')}</span>
          <SegmentedControl
            size="sm"
            label={t('modelInspector.layers.applyTo')}
            value={target}
            onValueChange={setTarget}
            options={[
              { value: 'element', label: t('modelInspector.layers.targetElement') },
              { value: 'type', label: t('modelInspector.layers.targetType'), disabled: typeId === null },
            ]}
          />
          <Button size="sm" variant="outline" data-inspector-apply-layers className="h-7 px-2.5 text-2xs" onClick={apply}>
            {t('modelInspector.layers.apply')}
          </Button>
        </div>
      </div>
      {elementId === undefined && <InspectorCaption>{t('modelInspector.layers.defaultsHint')}</InspectorCaption>}
      {kind === 'wall' && target === 'element' && <InspectorCaption>{t('modelInspector.layers.wallFollows')}</InspectorCaption>}
    </InspectorSection>
  );
}

function LayerRowEditor({ n, row: r, materials, onChange, onRemove }: {
  n: number;
  row: DraftRow;
  materials: ReadonlyArray<{ expressId: number; name: string }>;
  onChange: (patch: Partial<DraftRow>) => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return (
    <li data-inspector-layer className="space-y-1">
      <div className="flex items-center gap-1">
        <div className="relative w-20 shrink-0">
          <Input
            value={r.thickness}
            aria-label={t('modelInspector.layers.thicknessAria', { n })}
            onChange={(event) => onChange({ thickness: event.target.value })}
            onKeyDown={stop}
            className="h-7 pr-5 text-xs tabular-nums"
          />
          <span aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">{METRE_SYMBOL}</span>
        </div>
        <Select value={r.material} onValueChange={(material) => onChange({ material })}>
          <SelectTrigger aria-label={t('modelInspector.layers.materialAria', { n })} className="h-7 min-w-0 flex-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE} className="text-xs">{t('modelInspector.layers.noMaterial')}</SelectItem>
            {materials.map((m) => <SelectItem key={m.expressId} value={String(m.expressId)} className="text-xs">{m.name}</SelectItem>)}
            <SelectSeparator />
            <SelectItem value={NEW} className="text-xs">{t('modelInspector.layers.newMaterial')}</SelectItem>
          </SelectContent>
        </Select>
        {onRemove
          ? <IconButton label={t('modelInspector.layers.remove', { n })} size="icon-xs" className="shrink-0" onClick={onRemove}><X className="!size-3.5" /></IconButton>
          : <span aria-hidden className="w-7 shrink-0" />}
      </div>
      {r.material === NEW && (
        <Input
          value={r.newName}
          placeholder={t('modelInspector.layers.newMaterialName')}
          aria-label={t('modelInspector.layers.newMaterialName')}
          onChange={(event) => onChange({ newName: event.target.value })}
          onKeyDown={stop}
          className="ml-[5.25rem] h-7 w-[calc(100%-7.25rem)] text-xs"
        />
      )}
    </li>
  );
}
