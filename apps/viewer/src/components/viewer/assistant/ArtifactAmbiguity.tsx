/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A property or quantity the proposal names that no loaded element carries
 * exactly. The user picks one of the candidates the models really carry, or
 * asks again; nothing runs until every name resolves.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { fieldKey } from '@/lib/assistant/artifacts/field-refs';
import type { FieldCandidate, FieldResolution } from '@/lib/assistant/artifacts/field-candidates';

type Unresolved = Extract<FieldResolution, { status: 'unresolved' }>;

export function ArtifactAmbiguity({ unresolved, onResolve, onAsk }: {
  unresolved: Unresolved[];
  onResolve: (picks: Array<{ resolution: Unresolved; candidate: FieldCandidate }>) => void;
  onAsk: ((prompt: string) => void) | null;
}) {
  const { t } = useTranslation();
  const [picks, setPicks] = useState<Record<number, string>>({});
  const complete = unresolved.every((_, index) => picks[index] !== undefined);
  const named = (set: string, name: string) => `${set}.${name}`;
  return <div role="group" aria-label={t('assistantArtifacts.ambiguityTitle')} className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-2">
    <p className="font-medium">{t('assistantArtifacts.ambiguityTitle')}</p>
    <p>{t('assistantArtifacts.ambiguityHint')}</p>
    {unresolved.map((resolution, index) => <fieldset key={`${resolution.site.where}:${index}`} className="space-y-1">
      <legend className="font-medium break-words">{t(resolution.site.kind === 'quantity' ? 'assistantArtifacts.ambiguityQuantity' : 'assistantArtifacts.ambiguityProperty',
        { field: named(resolution.site.set, resolution.site.name), where: resolution.site.where })}</legend>
      {resolution.candidates.length === 0 ? <p>{t('assistantArtifacts.ambiguityNone')}</p>
        : resolution.candidates.map((candidate) => {
          const key = fieldKey(candidate);
          return <label key={key} className="flex items-start gap-2">
            <input type="radio" name={`artifact-ambiguity-${index}`} checked={picks[index] === key}
              onChange={() => setPicks((current) => ({ ...current, [index]: key }))} />
            <span className="min-w-0 break-words"><span className="font-mono break-all">{named(candidate.set, candidate.name)}</span>
              {' '}<span className="text-muted-foreground">{t('assistantArtifacts.ambiguityPresence', { count: candidate.count, models: candidate.byModel.size })}</span></span>
          </label>;
        })}
    </fieldset>)}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" className="h-7" disabled={!complete} onClick={() => onResolve(unresolved.flatMap((resolution, index) => {
        const candidate = resolution.candidates.find((each) => fieldKey(each) === picks[index]);
        return candidate ? [{ resolution, candidate }] : [];
      }))}>{t('assistantArtifacts.ambiguityUse')}</Button>
      {onAsk && <Button size="sm" variant="outline" className="h-7" onClick={() => onAsk(t('assistantArtifacts.ambiguityAsk', {
        fields: unresolved.map((resolution) => named(resolution.site.set, resolution.site.name)).join(', '),
      }))}>{t('assistantArtifacts.ambiguityAskButton')}</Button>}
    </div>
  </div>;
}
