/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { resolveEntityRef, resolveGlobalId, useViewerStore } from '@/store';
import { FIELD_SUGGESTIONS } from '@/lib/document/presets';
import { elementPropertyPaths, type BindingContext } from '@/lib/document/bindings';
import { modelBindingPath } from '@/lib/document/binding-path';
import { effectiveAttribute } from '@/lib/document/effective-binding-fields';
import { spatialBindingNodes } from '@/lib/document/spatial-binding-nodes';
import { field } from './BlockEditor.parts';

/** The source selection affects new insertions; each inserted path keeps its own source (#6485). */
export function FieldPicker({ bindings, onInsert }: { bindings: BindingContext; onInsert: (path: string) => void }) {
  const { t } = useTranslation();
  const [modelId, setModelId] = useState('');
  const selected = useViewerStore((s) => s.selectedEntityIds);
  const source = bindings.models.find((model) => model.id === modelId);
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of bindings.models) counts.set(model.name, (counts.get(model.name) ?? 0) + 1);
    return counts;
  }, [bindings.models]);
  const ambiguous = source !== undefined && (nameCounts.get(source.name) ?? 0) > 1;
  const options = useMemo(() => {
    const context = source ? { ...bindings, models: [source], activeModelId: source.id } : bindings;
    const options = [...FIELD_SUGGESTIONS];
    const active = context.models.find((model) => model.id === context.activeModelId) ?? context.models[0];
    const storeys = active ? spatialBindingNodes(active, 'IfcBuildingStorey') : [];
    const names = storeys.map(({ expressId }) => active?.view ? effectiveAttribute(active, expressId, 'Name') : active?.store.entities.getName(expressId));
    const storeyNameCounts = new Map<string, number>();
    for (const name of names) if (name) storeyNameCounts.set(name, (storeyNameCounts.get(name) ?? 0) + 1);
    for (let index = 0; index < Math.min(12, storeys.length); index++) {
      const name = names[index];
      if (!name) continue;
      const duplicate = (storeyNameCounts.get(name) ?? 0) > 1;
      const selector = duplicate ? String(index + 1) : `"${name}"`;
      options.push({ path: `IfcBuildingStorey[${selector}].Elevation`, label: `Storey "${name}"${duplicate ? ` (${index + 1})` : ''} elevation` });
    }
    const first = selected.values().next().value;
    const ref = first === undefined ? null : resolveEntityRef(first);
    const guid = first === undefined ? null : resolveGlobalId(first);
    if (guid && (!source || ref?.modelId === source.id)) {
      for (const attr of ['Name', 'Type', 'Description', 'ObjectType', 'Tag', 'Storey']) options.push({ path: `Element[${guid}].${attr}`, label: `Selected element · ${attr}` });
      for (const option of elementPropertyPaths(guid, context)) options.push({ path: option.path, label: `Selected element · ${option.label}` });
    }
    return source ? options.map((option) => ({ ...option, path: modelBindingPath(source.name, option.path) })) : options;
  }, [bindings, source, selected]);
  return (
    <>
      <label className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap text-muted-foreground">
        {t('document.block.fieldSourceLabel')}
        <select className={`${field} max-w-[190px]`} value={source?.id ?? ''} onChange={(event) => setModelId(event.target.value)} aria-label={t('document.block.fieldSourceAriaLabel')}>
          <option value="">{t('document.block.fieldSourceDefault')}</option>
          {bindings.models.map((model) => (
            <option key={model.id} value={model.id} disabled={(nameCounts.get(model.name) ?? 0) > 1}>
              {model.name}{(nameCounts.get(model.name) ?? 0) > 1 ? ` — ${t('document.block.fieldSourceDuplicate')}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap text-muted-foreground">
        {t('document.block.insertFieldLabel')}
        <select className={`${field} max-w-[190px]`} disabled={ambiguous} value="" onChange={(event) => { if (event.target.value) onInsert(event.target.value); }} aria-label={t('document.block.insertFieldLabel')} title={t(ambiguous ? 'document.block.fieldSourceDuplicateTitle' : 'document.block.insertFieldTitle')}>
          <option value="">…</option>
          {options.map((option) => <option key={option.path} value={option.path}>{option.label}</option>)}
        </select>
      </label>
    </>
  );
}
