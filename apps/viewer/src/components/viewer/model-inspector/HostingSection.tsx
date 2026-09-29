/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector's Hosting section (charter #6232, M2 §1.7.4, A1): a
 * door's or window's host wall, "Select host", and its offset along the wall
 * and sill. Each edit is one undo step (`moveHostedElement`): it moves the
 * opening, the filling follows it, and the host re-meshes with the void.
 */

import { useId, useMemo } from 'react';
import { readHostedFill } from '@ifc-lite/create';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { effectiveListTypeName } from '@/lib/lists/effective-provider-entities';
import { entityName } from '@/lib/commands/modeling/authored-kinds';
import { CommitField, InspectorCaption, InspectorRow, InspectorSection } from './InspectorControls';
import { METRE_SYMBOL, formatMetres } from './inspector-fields';
import { moveHostedElement } from './inspector-edits';
import type { InspectorSelection } from './useInspectorTarget';

/** A typed offset or sill in metres (a comma decimal works too): zero or more. */
function parseLength(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function HostingSection({ selection }: { selection: InspectorSelection }) {
  const { t } = useTranslation();
  const offsetId = useId();
  const sillId = useId();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const { modelId, expressId, live } = selection;
  const hosted = useMemo(() => {
    void mutationVersion;
    const read = readHostedFill(live.dataStore, expressId, live.view);
    if (!read) return null;
    const hostClass = effectiveListTypeName(live.dataStore, live.view ?? undefined, read.hostId);
    const hostName = entityName(live, read.hostId);
    return { ...read, hostLabel: hostName ? `${hostName} · ${hostClass} #${read.hostId}` : `${hostClass} #${read.hostId}` };
  }, [live, expressId, mutationVersion]);

  if (!hosted) {
    return (
      <InspectorSection title={t('modelInspector.hosting.title')}>
        <InspectorCaption>{t('modelInspector.hosting.none')}</InspectorCaption>
      </InspectorSection>
    );
  }

  const selectHost = () => {
    const s = useViewerStore.getState();
    s.setSelectedEntityId(toGlobalIdFromModels(s.models, modelId, hosted.hostId));
  };
  const commit = (field: 'offset' | 'sill') => (text: string) => {
    const metres = parseLength(text);
    if (metres === null) { toast.error(t('modelInspector.hosting.invalid')); return false; }
    return moveHostedElement(modelId, expressId, { [field]: metres });
  };

  return (
    <InspectorSection
      title={t('modelInspector.hosting.title')}
      aside={(
        <Button data-inspector-select-host size="sm" variant="ghost" className="h-6 px-1.5 text-2xs" onClick={selectHost}>
          {t('modelInspector.hosting.selectHost')}
        </Button>
      )}
    >
      <InspectorRow label={t('modelInspector.hosting.host')}>
        <span data-inspector-host className="truncate text-xs">{hosted.hostLabel}</span>
      </InspectorRow>
      <InspectorRow label={t('modelInspector.hosting.offset')} htmlFor={offsetId}>
        <CommitField
          id={offsetId}
          value={formatMetres(hosted.offset)}
          onCommit={commit('offset')}
          suffix={METRE_SYMBOL}
          ariaLabel={t('modelInspector.hosting.offset')}
        />
      </InspectorRow>
      <InspectorRow label={t('modelInspector.hosting.sill')} htmlFor={sillId}>
        <CommitField
          id={sillId}
          value={formatMetres(hosted.sill)}
          onCommit={commit('sill')}
          suffix={METRE_SYMBOL}
          ariaLabel={t('modelInspector.hosting.sill')}
        />
      </InspectorRow>
    </InspectorSection>
  );
}
