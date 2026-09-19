/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type a selector, get filter rules.
 *
 * The Filter tab had no text entry at all, so anyone arriving with the
 * IfcOpenShell syntax in hand had nowhere to put it (#4091). This is that
 * place: parse, adapt, and replace the rule list — or apply nothing and say
 * what stopped it. It never applies a partial reading silently, because
 * "matched nothing, said nothing" is the defect being fixed.
 */

import { useCallback, useState } from 'react';
import { HelpCircle, Wand2 } from 'lucide-react';
import type { SelectorParseError } from '@ifc-lite/query';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readSelector } from '@/lib/search/selector-to-rules';
import { groupsToSelectorText } from '@/lib/search/filter-groups';
import { useTranslation } from '@/i18n';

const DOCS_URL = 'https://ifclite.dev/docs/guide/selector-syntax/';
const PLACEHOLDER = 'IfcWall, Pset_WallCommon.FireRating=/REI.*/';

interface Feedback {
  tone: 'error' | 'warning';
  lines: string[];
}

/**
 * The active model's IFC schema version, which is what decides how far a class
 * term expands. Both selector surfaces need it and neither needs the model
 * map, so the subscription lives here once.
 */
export function useActiveSchemaVersion(): string | undefined {
  return useViewerStore(
    (s) => (s.activeModelId ? s.models.get(s.activeModelId) : undefined)?.schemaVersion,
  );
}

export function SearchModalFilterSelector() {
  const limit = useViewerStore((s) => s.searchFilter.limit);
  const groups = useViewerStore((s) => s.searchFilter.groups);
  const setSearchFilter = useViewerStore((s) => s.setSearchFilter);
  const schemaVersion = useActiveSchemaVersion();
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const apply = useCallback(() => {
    const query = text.trim();
    if (!query) return;

    const reading = readSelector(query, { schemaVersion });
    if (!reading.ok) {
      setFeedback({ tone: 'error', lines: [describeParseError(query, reading.error)] });
      return;
    }

    const { groups: readGroups, unsupported } = reading;

    if (readGroups.length === 0) {
      setFeedback({
        tone: 'error',
        lines: ['Nothing in this selector maps to a filter rule yet:', ...unsupported],
      });
      return;
    }

    setSearchFilter({ groups: readGroups, limit });
    setFeedback(
      unsupported.length > 0
        ? { tone: 'warning', lines: ['Applied without these parts:', ...unsupported] }
        : null,
    );
  }, [limit, schemaVersion, setSearchFilter, text]);

  // Round-trips class-name / GlobalId groups back to selector text — a `+`
  // added via the builder's "Add group" button shows up here without
  // leaving the builder (#4904). `null` when the current filter has no
  // clause this echo can render (property/quantity/etc. rules, or no rules
  // at all); the input keeps whatever the user is typing either way.
  const currentAsText = groupsToSelectorText(groups);

  return (
    <div className="flex flex-col gap-1.5 border-b border-zinc-200 px-4 pb-3 pt-4 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
          placeholder={PLACEHOLDER}
          aria-label="Selector syntax"
          spellCheck={false}
          className="h-7 flex-1 font-mono text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={apply}
          disabled={text.trim().length === 0}
          className="h-7 gap-1 text-[11px]"
          title="Replace the rules below with this selector"
        >
          <Wand2 className="h-3 w-3" /> Apply
        </Button>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          aria-label="Selector syntax reference"
          title="Selector syntax reference"
          className="text-muted-foreground hover:text-foreground"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </a>
      </div>

      {feedback && (
        <ul
          role="alert"
          className={`flex flex-col gap-0.5 text-[11px] ${
            feedback.tone === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'
          }`}
        >
          {feedback.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {currentAsText.length > 0 && (
        <p
          className="truncate font-mono text-[10px] text-muted-foreground"
          title={t('filterGroups.readbackTitle')}
        >
          {currentAsText}
        </p>
      )}
    </div>
  );
}

/** "…at character 7: …" plus the offending tail, so the caret is findable. */
function describeParseError(query: string, error: SelectorParseError): string {
  const tail = query.slice(error.offset, error.offset + 24);
  const at = tail.length > 0 ? ` (at ${JSON.stringify(tail)})` : ' (at the end)';
  return `Character ${error.offset + 1}${at}: ${error.message}`;
}
