/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EntityCard: one entity's attributes, properties, quantities, materials,
 * classifications and location, read live. `"selection"` follows the 3D
 * selection; a ref to a model that is not loaded says so.
 */

import { useMemo, type ReactNode } from 'react';
import { Crosshair } from 'lucide-react';
import { createComponentImplementation } from '@a2ui/react';
import { encodeRef, parseRef, type WireEntityRef } from '@ifc-lite/a2ui';
import { EntityCardApi } from '@ifc-lite/a2ui/catalog';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import type { A2uiViewerHost } from '@/lib/a2ui/host';
import { weightStyle } from './basic-layout';
import { Note } from './notes';
import { formatValue, useA2uiRuntime, useModelsVersion, useRunFunction } from './runtime';

type Section = 'attributes' | 'properties' | 'quantities' | 'materials' | 'classifications' | 'spatial';
const DEFAULT_SECTIONS: Section[] = ['attributes', 'properties'];
const SECTION_KEY: Record<Section, TranslationKey> = {
  attributes: 'a2ui.card.attributes',
  properties: 'a2ui.card.properties',
  quantities: 'a2ui.card.quantities',
  materials: 'a2ui.card.materials',
  classifications: 'a2ui.card.classifications',
  spatial: 'a2ui.card.spatial',
};

/** The selection channel, as a value that changes when the selection does. */
function useSelectionVersion(): unknown {
  const ids = useViewerStore((s) => s.selectedEntityIds);
  const id = useViewerStore((s) => s.selectedEntityId);
  return useMemo(() => ({ ids, id }), [ids, id]);
}

interface KeyValue { key: string; value: unknown }
interface SectionData { section: Section; groups: Array<{ title?: string; rows: KeyValue[] }> }

function readSection(host: A2uiViewerHost, ref: WireEntityRef, section: Section): SectionData {
  switch (section) {
    case 'attributes':
      return { section, groups: [{ rows: host.attributes(ref).map((a) => ({ key: a.name, value: a.value })) }] };
    case 'properties':
      return { section, groups: host.properties(ref).map((p) => ({ title: p.name, rows: p.properties.map((x) => ({ key: x.name, value: x.value })) })) };
    case 'quantities':
      return { section, groups: host.quantities(ref).map((q) => ({ title: q.name, rows: q.quantities.map((x) => ({ key: x.name, value: x.value })) })) };
    case 'materials': {
      const m = host.materials(ref);
      if (!m) return { section, groups: [] };
      const rows = [
        ...(m.name ? [{ key: m.type, value: m.name }] : []),
        ...(m.layers ?? []).map((l, i) => ({ key: `${i + 1}`, value: [l.materialName ?? l.name, l.thickness].filter((v) => v !== undefined).join(' · ') })),
        ...(m.constituents ?? []).map((c, i) => ({ key: c.name ?? `${i + 1}`, value: c.materialName })),
        ...(m.profiles ?? []).map((p, i) => ({ key: p.name ?? `${i + 1}`, value: p.materialName })),
        ...(m.materials ?? []).map((x, i) => ({ key: `${i + 1}`, value: x.name })),
      ];
      return { section, groups: [{ rows }] };
    }
    case 'classifications':
      return { section, groups: [{ rows: host.classifications(ref).map((c) => ({ key: c.system ?? '', value: [c.identification, c.name].filter(Boolean).join(' · ') })) }] };
    case 'spatial':
      return { section, groups: [{ rows: host.spatialPath(ref).map((e) => ({ key: e.type, value: e.name })) }] };
  }
}

function KeyValueList({ rows, noValue }: { rows: KeyValue[]; noValue: string }): ReactNode {
  return (
    <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-2 gap-y-0.5">
      {rows.map((r, i) => (
        <div key={`${r.key}:${i}`} className="contents">
          <dt className="truncate text-muted-foreground">{r.key}</dt>
          <dd className="truncate">{formatValue(r.value, noValue)}</dd>
        </div>
      ))}
    </dl>
  );
}

export const EntityCardImpl = createComponentImplementation(EntityCardApi, ({ props }) => {
  const { t } = useTranslation();
  const { host } = useA2uiRuntime();
  const models = useModelsVersion();
  const selection = useSelectionVersion();
  const run = useRunFunction();
  const raw = typeof props.entity === 'string' ? props.entity.trim() : '';
  const followsSelection = raw.toLowerCase() === 'selection';
  const sections = (Array.isArray(props.sections) && props.sections.length ? props.sections : DEFAULT_SECTIONS) as Section[];

  const view = useMemo(() => {
    const ref = followsSelection ? host.getSelection().at(-1) ?? null : parseRef(raw);
    if (!ref) return { kind: followsSelection ? 'noSelection' : 'notFound' } as const;
    if (!host.loadedModelIds().includes(ref.modelId)) return { kind: 'unloaded', modelId: ref.modelId } as const;
    const entity = host.entity(ref);
    if (!entity) return { kind: 'notFound' } as const;
    return { kind: 'entity', entity, data: sections.map((s) => readSection(host, ref, s)) } as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- models/selection are change keys
  }, [host, raw, followsSelection, sections.join(','), models, followsSelection ? selection : null]);

  const noValue = t('a2ui.noValue');
  return (
    <div style={weightStyle(props.weight)} className="flex min-w-0 flex-col gap-2 rounded-md border p-2.5 text-xs">
      {view.kind === 'noSelection' && <Note>{t('a2ui.card.selectionEmpty')}</Note>}
      {view.kind === 'notFound' && <Note tone="warn">{t('a2ui.card.notFound')}</Note>}
      {view.kind === 'unloaded' && <Note tone="warn">{t('a2ui.unloadedModel', { model: host.modelName(view.modelId) ?? view.modelId })}</Note>}
      {view.kind === 'entity' && (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{view.entity.name || view.entity.globalId}</div>
              <div className="text-muted-foreground">{view.entity.type}</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => run('flyTo', { refs: [encodeRef(view.entity.ref)] })}>
              <Crosshair className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t('a2ui.card.flyTo')}
            </Button>
          </div>
          {view.data.map((d) => (
            <section key={d.section} className="flex flex-col gap-1">
              <h4 className="font-semibold">{t(SECTION_KEY[d.section])}</h4>
              {d.groups.every((g) => g.rows.length === 0) && <span className="text-muted-foreground">{noValue}</span>}
              {d.groups.filter((g) => g.rows.length > 0).map((g, i) => (
                <div key={`${g.title ?? ''}:${i}`} className="flex flex-col gap-0.5">
                  {g.title && <div className="font-medium">{g.title}</div>}
                  <KeyValueList rows={g.rows} noValue={noValue} />
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
});
