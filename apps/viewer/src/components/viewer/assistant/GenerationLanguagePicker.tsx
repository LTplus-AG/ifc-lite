/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The conversation's answer language, independent of the UI locale (#6926).
 * Language names are shown in the UI locale; the choice is stored with the
 * conversation and becomes the default for new ones.
 */

import { useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { useAssistant, setConversationGenerationLanguage } from '@/lib/assistant/conversation';
import { GENERATION_LANGUAGES, languageName } from '@/lib/assistant/language';

export function GenerationLanguagePicker({ disabled }: { disabled: boolean }) {
  const { t, locale } = useTranslation();
  const generation = useAssistant((s) => s.language.generation);
  const options = useMemo(() => {
    const tags: string[] = [...GENERATION_LANGUAGES];
    if (!tags.includes(generation)) tags.unshift(generation);
    return tags.map((tag) => ({ tag, name: languageName(tag, locale) }));
  }, [generation, locale]);
  return <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
    <label htmlFor="assistant-generation-language" className="shrink-0">{t('assistantLanguage.label')}</label>
    <select id="assistant-generation-language" aria-describedby="assistant-generation-language-hint" value={generation} disabled={disabled}
      className="h-7 min-w-0 rounded border border-input bg-background px-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onChange={(event) => setConversationGenerationLanguage(event.target.value)}>
      {options.map(({ tag, name }) => <option key={tag} value={tag} lang={tag}>{name}</option>)}
    </select>
    <span id="assistant-generation-language-hint" className="sr-only">{t('assistantLanguage.hint')}</span>
  </div>;
}
