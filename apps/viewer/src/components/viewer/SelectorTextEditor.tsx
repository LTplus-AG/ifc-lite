/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SelectorTextEditor` — type a selector, get `FilterGroup[]`.
 *
 * Lifted out of `SearchModal.filter.selector.tsx` as a CONTROLLED
 * component (#5138 PR 5): no `useViewerStore` subscription for the groups
 * it edits, so the same "type text, get groups back, or get told what
 * stopped it" behaviour (#4091) backs both the Filter tab's Selector field
 * (`SearchModalFilterSelector`, now a thin adapter) and the validation rule
 * editor's `RuleBlockEditor` selector mode. It never applies a partial
 * reading silently — the reason this component exists in the first place.
 */

import { useCallback, useState } from 'react';
import { HelpCircle, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readSelector } from '@/lib/search/selector-to-rules';
import { groupsToSelectorText, type FilterGroup } from '@ifc-lite/rules';
import { useTranslation } from '@/i18n';
import { describeSelectorParseError, SelectorFeedbackList, type SelectorFeedback } from './SearchModal.filter.feedback';

export const DOCS_URL = 'https://ifclite.dev/docs/guide/selector-syntax/';

export interface SelectorTextEditorProps {
  groups: FilterGroup[];
  onChange: (groups: FilterGroup[]) => void;
  schemaVersion?: string;
}

export function SelectorTextEditor({ groups, onChange, schemaVersion }: SelectorTextEditorProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<SelectorFeedback | null>(null);

  const apply = useCallback(() => {
    const query = text.trim();
    if (!query) return;

    const reading = readSelector(query, { schemaVersion });
    if (!reading.ok) {
      setFeedback({ tone: 'error', lines: [describeSelectorParseError(query, reading.error)] });
      return;
    }

    const { groups: readGroups, unsupported } = reading;

    if (readGroups.length === 0) {
      setFeedback({
        tone: 'error',
        lines: [t('searchModal.filterSelector.nothingMapped'), ...unsupported],
      });
      return;
    }

    onChange(readGroups);
    setFeedback(
      unsupported.length > 0
        ? { tone: 'warning', lines: [t('searchModal.filterSelector.appliedWithoutParts'), ...unsupported] }
        : null,
    );
  }, [onChange, schemaVersion, text]);

  // Round-trips class-name / GlobalId groups back to selector text — a `+`
  // added via the builder's "Add group" button shows up here without
  // leaving the builder (#4904). `''` when the current groups have no
  // clause this echo can render; the input keeps whatever the user is
  // typing either way.
  const currentAsText = groupsToSelectorText(groups);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
          placeholder={t('searchModal.filterSelector.placeholder')}
          aria-label={t('searchModal.filterSelector.inputAriaLabel')}
          spellCheck={false}
          className="h-7 flex-1 font-mono text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={apply}
          disabled={text.trim().length === 0}
          className="h-7 gap-1 text-2xs"
          title={t('searchModal.filterSelector.applyTitle')}
        >
          <Wand2 className="h-3 w-3" /> {t('searchModal.filterSelector.apply')}
        </Button>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          aria-label={t('searchModal.filterSelector.docsAriaLabel')}
          title={t('searchModal.filterSelector.docsAriaLabel')}
          className="text-muted-foreground hover:text-foreground"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </a>
      </div>

      {feedback && <SelectorFeedbackList feedback={feedback} />}

      {currentAsText.length > 0 && (
        <p
          className="truncate font-mono text-2xs text-muted-foreground"
          title={t('filterGroups.readbackTitle')}
        >
          {currentAsText}
        </p>
      )}
    </div>
  );
}
