/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import type { NodeRegistry } from '@ifc-lite/flow';
import { useTranslation } from '@/i18n/useTranslation';
import { KIND_COLOR, paletteGroups } from '@/lib/flow/view-model';

export function FlowPalette({ registry, onAdd }: { registry: NodeRegistry<unknown>; onAdd: (type: string) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => paletteGroups(registry, query), [registry, query]);
  return (
    <div className="flex h-full w-44 shrink-0 flex-col border-r border-border text-xs" data-flow-palette>
      <input
        className="m-1.5 rounded border border-border bg-transparent px-1.5 py-0.5"
        placeholder={t('flowPanel.palette.search')}
        aria-label={t('flowPanel.palette.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {groups.map(({ category, defs }) => (
          <div key={category} className="mb-1.5">
            <div className="px-1 py-0.5 text-2xs uppercase tracking-wide text-muted-foreground">{category}</div>
            {defs.map((def) => (
              <button
                key={def.type}
                type="button"
                className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-muted"
                title={def.doc ?? def.type}
                aria-label={t('flowPanel.palette.add', { title: def.title })}
                onClick={() => onAdd(def.type)}
              >
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[def.outputs[0]?.type.kind ?? 'any'] }} />
                <span className="truncate">{def.title}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
