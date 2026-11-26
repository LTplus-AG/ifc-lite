/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "Two-point align" section of the Reposition Local tab (#11505). It only
 * reads and drives the session `RepositionRuntimeHost` publishes as
 * `runtime.align`; the picking, the maths and the commit live elsewhere.
 */
import { useState } from 'react';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import { useRepositionRuntime } from '@/lib/model-placement/reposition-runtime';
import { buildAlignReadout } from '@/lib/model-placement/two-point-align-readout';
import { ALIGN_REFUSAL_KEYS, ALIGN_STEPS, type AlignStep } from '@/lib/model-placement/two-point-align-session';

const PROMPT_KEYS: Record<AlignStep, TranslationKey> = {
  a: 'repositionPanel.twoPoint.promptA',
  aPrime: 'repositionPanel.twoPoint.promptAPrime',
  b: 'repositionPanel.twoPoint.promptB',
  bPrime: 'repositionPanel.twoPoint.promptBPrime',
};
const STEP_LABELS: Record<AlignStep, string> = { a: 'A', aPrime: 'A′', b: 'B', bPrime: 'B′' };

export function TwoPointAlignPanel() {
  const { t } = useTranslation();
  const runtime = useRepositionRuntime();
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const align = runtime?.align;
  if (!runtime || !align) return null;

  if (!align.active) {
    return <fieldset className="space-y-1 border-t pt-2">
      <legend className="font-medium">{t('repositionPanel.twoPoint.legend')}</legend>
      <p className="text-muted-foreground">{t('repositionPanel.twoPoint.intro')}</p>
      {!runtime.reference && <p className="text-muted-foreground">{t('repositionPanel.twoPoint.needReference')}</p>}
      <Button size="sm" variant="outline" disabled={!runtime.reference || runtime.selected.length === 0}
        onClick={align.start}>{t('repositionPanel.twoPoint.startButton')}</Button>
    </fieldset>;
  }

  const solved = align.result;
  const readout = solved?.ok ? buildAlignReadout(solved.alignment, t) : null;
  const copy = async () => {
    if (!readout) return;
    try { await navigator.clipboard.writeText(readout.lines.join('\n')); setCopied('ok'); }
    catch { setCopied('failed'); }
  };
  return <fieldset className="space-y-1 border-t pt-2">
    <legend className="font-medium">{t('repositionPanel.twoPoint.legend')}</legend>
    <output className="block">
      {align.step ? t(PROMPT_KEYS[align.step]) : t('repositionPanel.twoPoint.promptReady')}
    </output>
    {align.cleared && <output className="block text-muted-foreground">{t('repositionPanel.twoPoint.picksClearedNote')}</output>}
    {ALIGN_STEPS.filter((step) => align.points[step]).map((step) => {
      const point = align.points[step]!;
      return <p key={step} className="font-mono truncate">{t('repositionPanel.twoPoint.pickedRow', {
        label: STEP_LABELS[step], x: point[0].toFixed(3), y: point[1].toFixed(3), z: point[2].toFixed(3) })}</p>;
    })}
    {solved && !solved.ok && <p role="alert" className="text-destructive">{t(ALIGN_REFUSAL_KEYS[solved.reason])}</p>}
    {readout && <fieldset aria-label={t('repositionPanel.twoPoint.readoutAriaLabel')}
      className={`font-mono space-y-0.5 ${readout.warn ? 'text-amber-700 dark:text-amber-300' : ''}`}>
      {readout.lines.map((line, index) => <p key={index}>{line}</p>)}
    </fieldset>}
    <p className="text-muted-foreground">{t('repositionPanel.twoPoint.previewNote')}</p>
    <div className="flex flex-wrap gap-1">
      <Button size="sm" disabled={!readout} onClick={align.apply}>{t('repositionPanel.twoPoint.applyButton')}</Button>
      <Button size="sm" variant="outline" disabled={!readout} onClick={copy}>{t('repositionPanel.twoPoint.copyButton')}</Button>
      <Button size="sm" variant="outline" disabled={!align.points.a} onClick={align.repick}>{t('repositionPanel.twoPoint.repickButton')}</Button>
      <Button size="sm" variant="outline" onClick={align.cancel}>{t('repositionPanel.twoPoint.cancelButton')}</Button>
    </div>
    {copied && <output className="block text-muted-foreground">
      {t(copied === 'ok' ? 'repositionPanel.twoPoint.copiedStatus' : 'repositionPanel.twoPoint.copyFailed')}</output>}
  </fieldset>;
}
