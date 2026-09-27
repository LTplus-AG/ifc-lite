/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The example library: a picker in the toolbar, and the gallery that fills
 * the empty canvas. Both open a *copy* — the library is never edited.
 *
 * An empty panel with a "connect their ports" hint is not a starting
 * point; a ladder of runnable graphs is. The gallery is the first thing a
 * user with no saved graph sees.
 */

import type { FlowDocument } from '@ifc-lite/flow';
import { useTranslation } from '@/i18n/useTranslation';
import { flowExamples } from '@/lib/flow/examples';

export interface FlowExamplesProps {
  readonly onOpen: (doc: FlowDocument) => void;
}

const select = 'min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5';

/** Toolbar picker; resets to its placeholder so the same example can be opened twice. */
export function FlowExamplePicker({ onOpen }: FlowExamplesProps) {
  const { t } = useTranslation();
  const examples = flowExamples();
  return (
    <select
      className={select}
      value=""
      aria-label={t('flowPanel.examples.ariaLabel')}
      onChange={(e) => {
        const found = examples.find((doc) => doc.id === e.target.value);
        if (found) onOpen(found);
        e.currentTarget.value = '';
      }}
    >
      <option value="">{t('flowPanel.examples.open')}</option>
      {examples.map((doc) => <option key={doc.id} value={doc.id}>{doc.name}</option>)}
    </select>
  );
}

export function FlowExampleGallery({ onOpen }: FlowExamplesProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4" data-flow-examples>
      <div className="mb-2 text-muted-foreground">{t('flowPanel.examples.heading')}</div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {flowExamples().map((doc) => (
          <button
            key={doc.id}
            type="button"
            className="rounded border border-border p-2 text-left hover:border-[#7aa2f7] hover:bg-muted"
            onClick={() => onOpen(doc)}
          >
            <div className="font-medium">{doc.name}</div>
            <div className="mt-0.5 line-clamp-4 text-2xs text-muted-foreground">{doc.description}</div>
            <div className="mt-1 font-mono text-2xs text-muted-foreground">
              {t('flowPanel.examples.size', { nodes: doc.nodes.length, edges: doc.edges.length })}
              {doc.capabilities.length > 0 ? ` · ${doc.capabilities.join(' ')}` : ''}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
