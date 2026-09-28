/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One element's history, in the properties panel.
 *
 * The question this answers is "when did this wall change, and into what" —
 * and it answers it WITHOUT loading a single historical model, because
 * `listElementHistory` is a metadata call. That is what makes it worth
 * putting beside the properties rather than behind a separate flow.
 *
 * Collapsed by default and fetched on expand: the properties panel
 * re-renders on every selection, and a request per click would be a round
 * trip for every element a user passes through.
 */

import { useCallback, useState } from 'react';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import type { ElementHistoryEntry } from '@ifc-lite/plugin-api';

import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { getLocale } from '@/i18n/registry';
import { useElementHistory } from '@/hooks/history/useElementHistory';
import { orderChangeKinds, readableComponentName, shortCommitId } from '@/lib/history/commitLabels';
import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';

const STATE_LABEL: Readonly<Record<ElementHistoryEntry['state'], TranslationKey>> = {
  added: 'history.element.state.added',
  modified: 'history.element.state.modified',
  deleted: 'history.element.state.deleted',
  renamed: 'history.element.state.renamed',
  split: 'history.element.state.split',
  merged: 'history.element.state.merged',
  replaced: 'history.element.state.replaced',
};

const CHANGE_KIND_LABEL = {
  data: 'history.element.changeKind.data',
  geometry: 'history.element.changeKind.geometry',
  container: 'history.element.changeKind.container',
} as const satisfies Record<string, TranslationKey>;

export interface ElementHistoryCardProps {
  /** Viewer model id of the selected entity. */
  readonly modelId: string;
  /** The entity's GlobalId, or the compare `keyProperty` value when one is set. */
  readonly elementKey: string | null;
}

function EntryRow({ entry }: { entry: ElementHistoryEntry }) {
  const { t } = useTranslation();
  const locale = getLocale();
  const kinds = orderChangeKinds(entry.changeKinds).map((kind) => t(CHANGE_KIND_LABEL[kind]));
  const components = (entry.changedComponents ?? []).map(readableComponentName);
  const detail = [...kinds, ...components].join(', ');
  const label =
    entry.state === 'renamed'
      ? t('history.element.state.renamed', { from: shortCommitId(entry.relatedKeys?.[0] ?? '') })
      : t(STATE_LABEL[entry.state]);

  return (
    <li className="flex gap-2 py-1 text-[11px]">
      <span
        className={cn(
          'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
          entry.state === 'added' && 'bg-emerald-500',
          entry.state === 'deleted' && 'bg-rose-500',
          entry.state !== 'added' && entry.state !== 'deleted' && 'bg-amber-500',
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{label}</span>
        {detail && <span className="text-muted-foreground"> · {detail}</span>}
        <span className="block truncate text-muted-foreground">
          {shortCommitId(entry.commitId)} ·{' '}
          {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(entry.createdAt))}
        </span>
      </span>
    </li>
  );
}

export function ElementHistoryCard({ modelId, elementKey }: ElementHistoryCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasCommitTag = useViewerStore((s) => s.commitTags.has(modelId));
  const history = useElementHistory(modelId, elementKey, expanded);

  const toggle = useCallback(() => setExpanded((open) => !open), []);

  // Rendered only for a commit-tagged model: for anything else there is no
  // history to ask about, and an always-present card saying "not available"
  // is noise on every selection in every locally-opened file.
  if (!hasCommitTag || !elementKey) return null;

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <History className="h-3 w-3" />
        <span>{t('history.element.title')}</span>
      </button>

      {expanded && (
        <div className="px-1">
          {!history.supported && <p className="text-[11px] text-muted-foreground">{t('history.element.unsupported')}</p>}
          {history.supported && history.error && <p className="text-[11px] text-destructive">{history.error}</p>}
          {history.supported && !history.error && history.loading && history.entries.length === 0 && (
            <p className="text-[11px] text-muted-foreground">{t('history.state.loading')}</p>
          )}
          {history.supported && !history.error && !history.loading && history.entries.length === 0 && (
            <p className="text-[11px] text-muted-foreground">{t('history.element.empty')}</p>
          )}
          {history.entries.length > 0 && (
            <ul className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
              {history.entries.map((entry) => (
                <EntryRow key={`${entry.commitId}:${entry.key}`} entry={entry} />
              ))}
            </ul>
          )}
          {history.hasMore && (
            <button type="button" onClick={history.loadMore} className="mt-1 text-[11px] underline">
              {t('history.element.showAll')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
