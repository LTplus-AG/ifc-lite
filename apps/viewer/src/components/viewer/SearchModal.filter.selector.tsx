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
import { useShallow } from 'zustand/react/shallow';
import { parseSelector } from '@ifc-lite/query';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { selectorToFilterRules } from '@/lib/search/selector-to-rules';

const DOCS_URL = 'https://ifclite.dev/docs/guide/selector-syntax/';
const PLACEHOLDER = 'IfcWall, Pset_WallCommon.FireRating=/REI.*/';

interface Feedback {
  tone: 'error' | 'warning';
  lines: string[];
}

export function SearchModalFilterSelector() {
  const { limit, models, activeModelId, setSearchFilter } = useViewerStore(
    useShallow((s) => ({
      limit: s.searchFilter.limit,
      models: s.models,
      activeModelId: s.activeModelId,
      setSearchFilter: s.setSearchFilter,
    })),
  );
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const apply = useCallback(() => {
    const query = text.trim();
    if (!query) return;

    const parsed = parseSelector(query);
    if (!parsed.ok) {
      setFeedback({ tone: 'error', lines: [describeParseError(query, parsed.error)] });
      return;
    }

    const schemaVersion = (activeModelId ? models.get(activeModelId) : undefined)?.schemaVersion;
    const { combinator, rules, unsupported } = selectorToFilterRules(parsed.query, { schemaVersion });

    if (rules.length === 0) {
      setFeedback({
        tone: 'error',
        lines: ['Nothing in this selector maps to a filter rule yet:', ...unsupported],
      });
      return;
    }

    setSearchFilter({ rules, combinator, limit });
    setFeedback(
      unsupported.length > 0
        ? { tone: 'warning', lines: ['Applied without these parts:', ...unsupported] }
        : null,
    );
  }, [activeModelId, limit, models, setSearchFilter, text]);

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
    </div>
  );
}

/** "…at character 7: …" plus the offending tail, so the caret is findable. */
function describeParseError(query: string, error: { message: string; offset: number }): string {
  const tail = query.slice(error.offset, error.offset + 24);
  const at = tail.length > 0 ? ` (at ${JSON.stringify(tail)})` : ' (at the end)';
  return `Character ${error.offset + 1}${at}: ${error.message}`;
}
