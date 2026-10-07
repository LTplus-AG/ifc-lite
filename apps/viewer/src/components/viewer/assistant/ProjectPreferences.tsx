/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { getModelById } from '@/lib/llm/models';
import { ASSISTANT_OUTPUT_TOKENS } from '@/lib/assistant/request';
import { ASSISTANT_ROOT_BUDGET } from '@/lib/llm/root-budget';
import { ANSWER_LANGUAGES, PREFERENCE_LIMITS, assistantPreferencesLibrary, savePreferences,
  useAssistantPreferences, type PreferenceRefusal } from '@/lib/assistant/reuse/preferences';
import { useProjectPreferences } from '@/lib/assistant/reuse/preference-hooks';
import { ContentStorageNotice } from '../ContentStorageNotice';

const REFUSAL: Record<PreferenceRefusal, TranslationKey> = {
  'no-scope': 'assistantReuse.prefsNoScope', credential: 'assistantReuse.prefsRefusedCredential', invalid: 'assistantReuse.prefsRefusedInvalid',
};

const number = (value: string): number | undefined => value.trim() === '' ? undefined : Number(value);

export function ProjectPreferences() {
  const { t, locale } = useTranslation();
  const { scope, preferences } = useProjectPreferences();
  const status = useAssistantPreferences(s => s.status);
  const currentModel = useViewerStore(s => s.chatActiveModel);
  const [model, setModel] = useState(preferences?.model ?? '');
  const [language, setLanguage] = useState(preferences?.language ?? '');
  const [outputTokens, setOutputTokens] = useState(preferences?.outputTokens?.toString() ?? '');
  const [maxRequests, setMaxRequests] = useState(preferences?.maxRequests?.toString() ?? '');
  const [houseRules, setHouseRules] = useState(preferences?.houseRules ?? '');
  const [message, setMessage] = useState<{ alert: boolean; key: TranslationKey } | null>(null);
  // Show the stored values whenever the project (or its saved entry) changes.
  useEffect(() => {
    setModel(preferences?.model ?? ''); setLanguage(preferences?.language ?? '');
    setOutputTokens(preferences?.outputTokens?.toString() ?? ''); setMaxRequests(preferences?.maxRequests?.toString() ?? '');
    setHouseRules(preferences?.houseRules ?? '');
  }, [preferences]);
  const names = useMemo(() => {
    try { return new Intl.DisplayNames([locale], { type: 'language' }); }
    catch (error) { console.debug('[Assistant] Language names unavailable', error); return null; }
  }, [locale]);
  const save = async () => {
    const result = await savePreferences(scope, { model: model || undefined, language: language || undefined,
      outputTokens: number(outputTokens), maxRequests: number(maxRequests), houseRules });
    setMessage(!result.ok ? { alert: true, key: REFUSAL[result.reason] }
      : { alert: !result.saved, key: result.saved ? 'assistantReuse.prefsSaved' : 'assistantReuse.prefsUnsaved' });
  };
  const field = 'w-full h-7 border border-input rounded bg-background px-2';
  return <section aria-label={t('assistantReuse.prefsTitle')} className="border-b border-border bg-muted/20 text-xs shrink-0">
    <div className="p-3 space-y-2">
      <h3 className="font-semibold">{t('assistantReuse.prefsTitle')}</h3>
      <p className="text-muted-foreground">{scope ? t('assistantReuse.prefsScope', { count: scope.fingerprints.length }) : t('assistantReuse.prefsNoScope')}</p>
      {scope && <>
        <div className="space-y-1">
          <span className="block font-medium">{t('assistantReuse.prefsModel')}</span>
          <p className="text-muted-foreground">{model ? getModelById(model)?.name ?? model : t('assistantReuse.prefsModelNone')}</p>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" className="h-7" onClick={() => setModel(currentModel)}>{t('assistantReuse.prefsUseCurrent')}</Button>
            {model && <Button size="sm" variant="ghost" className="h-7" onClick={() => setModel('')}>{t('assistantReuse.prefsClearModel')}</Button>}
          </div>
        </div>
        <label className="block space-y-1"><span className="block font-medium">{t('assistantReuse.prefsLanguage')}</span>
          <select className={field} value={language} onChange={event => setLanguage(event.target.value)}>
            <option value="">{t('assistantReuse.prefsLanguageAuto')}</option>
            {ANSWER_LANGUAGES.map(code => <option key={code} value={code}>{names?.of(code) ?? code}</option>)}
          </select>
        </label>
        <label className="block space-y-1"><span className="block font-medium">{t('assistantReuse.prefsOutputTokens', { max: ASSISTANT_OUTPUT_TOKENS })}</span>
          <input type="number" className={field} min={PREFERENCE_LIMITS.minOutputTokens} max={PREFERENCE_LIMITS.maxOutputTokens} value={outputTokens}
            onChange={event => setOutputTokens(event.target.value)} />
        </label>
        <label className="block space-y-1"><span className="block font-medium">{t('assistantReuse.prefsMaxRequests', { max: ASSISTANT_ROOT_BUDGET.maxRequests })}</span>
          <input type="number" className={field} min={1} max={ASSISTANT_ROOT_BUDGET.maxRequests} value={maxRequests}
            onChange={event => setMaxRequests(event.target.value)} />
        </label>
        <label className="block space-y-1"><span className="block font-medium">{t('assistantReuse.prefsHouseRules')}</span>
          <textarea rows={3} maxLength={PREFERENCE_LIMITS.houseRules} className="w-full resize-y rounded border border-input bg-background p-2"
            value={houseRules} onChange={event => setHouseRules(event.target.value)} />
        </label>
        <p className="text-muted-foreground">{t('assistantReuse.prefsPrivacy')}</p>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" className="h-7" onClick={() => void save()}>{t('assistantReuse.prefsSave')}</Button>
          {preferences && <Button size="sm" variant="outline" className="h-7" onClick={() => void assistantPreferencesLibrary.put(preferences.id, null)}>
            {t('assistantReuse.prefsReset')}</Button>}
        </div>
      </>}
      {message && <p role={message.alert ? 'alert' : 'status'}>{t(message.key)}</p>}
    </div>
    <ContentStorageNotice status={status} retry={assistantPreferencesLibrary.retry} restore={assistantPreferencesLibrary.restore} />
  </section>;
}
