/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One change set's edits, grouped by element; a click selects the element (#6232 D4). */

import { useMemo } from 'react';
import { Focus } from 'lucide-react';
import type { ChangeSet, Mutation } from '@ifc-lite/mutations';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { groupChangeSetByElement } from '@/lib/change-sets/change-set-view';
import { selectChangedEntity } from '@/lib/changes/select-changed-entity';

const TYPE_LABEL: Partial<Record<Mutation['type'], TranslationKey>> = {
  CREATE_ENTITY: 'changeSets.contents.created',
  DELETE_ENTITY: 'changeSets.contents.deleted',
  UPDATE_ENTITY_TYPE: 'changeSets.contents.retyped',
};

/** What an edit touched, in EXPRESS / property-set names where it has one. */
function useWhatChanged(mutations: readonly Mutation[]): string {
  const { t } = useTranslation();
  const labels = new Set<string>();
  for (const mutation of mutations) {
    const key = TYPE_LABEL[mutation.type];
    if (key) labels.add(t(key));
    else if (mutation.psetName) labels.add(mutation.propName ? `${mutation.psetName}.${mutation.propName}` : mutation.psetName);
    else if (mutation.attributeName) labels.add(mutation.attributeName);
  }
  return [...labels].join(', ');
}

export function ChangeSetContents({ changeSet }: { changeSet: ChangeSet }) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupChangeSetByElement(changeSet), [changeSet]);
  if (groups.length === 0) return <p className="px-3 pb-3 text-xs text-muted-foreground">{t('changeSets.contents.empty')}</p>;
  return (
    <ul data-change-set-contents className="space-y-0.5 px-2 pb-2">
      {groups.map((group) => <ElementRow key={`${group.modelId}:${group.entityId}`} {...group} />)}
    </ul>
  );
}

function ElementRow({ modelId, entityId, mutations }: { modelId: string; entityId: number; mutations: Mutation[] }) {
  const { t } = useTranslation();
  const model = useViewerStore((s) => s.models.get(modelId));
  const what = useWhatChanged(mutations);
  const count = <span className="shrink-0 text-2xs text-muted-foreground">{t('changeSets.contents.edits', { count: mutations.length })}</span>;
  if (entityId === 0) {
    return (
      <li className="flex items-center gap-1.5 px-1 py-0.5 text-xs">
        <span className="min-w-0 flex-1 truncate">{t('changeSets.contents.modelLevel')}</span>
        {count}
      </li>
    );
  }
  const store = model?.ifcDataStore;
  const entity = t('changeSets.contents.entity', { type: store?.entities.getTypeName(entityId) ?? 'IFC', id: entityId });
  const name = store?.entities.getName(entityId);
  return (
    <li>
      <button
        type="button"
        data-change-set-element={`${modelId}:${entityId}`}
        className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
        aria-label={t('changeSets.contents.select', { entity, model: model?.name ?? modelId })}
        onClick={() => selectChangedEntity(modelId, entityId)}
      >
        <Focus className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{entity}{name ? ` — ${name}` : ''}</span>
          {what && <span className="block truncate text-2xs text-muted-foreground">{what}</span>}
        </span>
        {count}
      </button>
    </li>
  );
}
