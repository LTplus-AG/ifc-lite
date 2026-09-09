/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useState } from 'react';
import { Check, Eye, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppearancePdfFields, AppearancePdfPassword } from './AppearancePdfFields.js';
import { AppearanceSourceFields } from './AppearanceSourceFields.js';
import { AppearanceScopeFields } from './AppearanceScopeFields.js';
import { AppearanceCalibrationFields } from './AppearanceCalibrationFields.js';
import { AppearanceMappingFields } from './AppearanceMappingFields.js';
import type { AppearancePanelViewProps } from './types.js';

/** Controlled dock content. Preview, selection, asset lifetimes and commands live in the controller. */
export function AppearancePanelView(props: AppearancePanelViewProps) {
  const [inputReset, setInputReset] = useState(0);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const onInvalid = useCallback((name: string, invalid: boolean) => {
    setInvalidFields(previous => {
      if (previous.has(name) === invalid) return previous;
      const next = new Set(previous);
      if (invalid) next.add(name); else next.delete(name);
      return next;
    });
  }, []);
  const applying = props.status === 'applying';
  const busy = applying || props.status === 'preparing' || props.sourceBusy || props.pdf?.busy || props.pdfPassword?.busy;
  const blocked = !!props.pdfPassword || !!props.pdf?.error || !!props.unavailableReason || !props.modelId || !props.sourceId;
  const applyDisabled = !props.canApply || !props.hasPreview || blocked || busy || invalidFields.size > 0 || props.affectedCount === 0 || props.status !== 'ready';
  const message = invalidFields.size ? 'Enter valid numbers in the highlighted fields before applying.' :
    props.unavailableReason ?? props.statusMessage ?? ({
      idle: 'Choose an image and scope to preview appearance.',
      preparing: 'Preparing preview… You can keep adjusting the controls.',
      ready: props.showingOriginal ? 'Showing original appearance.' : 'Preview ready. Apply to save this appearance to the model.',
      applying: 'Applying appearance…',
      stale: 'The model changed. Refresh the preview before applying.',
      error: 'Could not prepare appearance. Adjust the settings and try again.',
    }[props.status]);
  return <div className="flex h-full min-h-0 flex-col bg-background" aria-label="Appearance workspace" aria-busy={!!busy}>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
      <div><h2 className="text-sm font-semibold">Appearance</h2><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{props.allowPdf ? 'Images and PDF pages across the surfaces you choose.' : 'One image, across the surfaces you choose.'}</p></div>
      <AppearanceSourceFields {...props} disabled={applying} />
      {props.pdfPassword && <AppearancePdfPassword key={props.pdfPassword.documentName} prompt={props.pdfPassword} disabled={applying} />}
      {props.pdf && <AppearancePdfFields key={`${props.pdf.documentId}:${props.pdf.pageNumber}:${props.pdf.rotation}:${inputReset}`} pdf={props.pdf} disabled={applying} onInvalid={onInvalid} />}
      <AppearanceScopeFields {...props} disabled={applying} />
      {props.calibration && <AppearanceCalibrationFields key={`${props.sourceId}:${props.calibration.sourceKey}:${inputReset}`}
        {...props.calibration} disabled={applying || blocked || !!props.sourceBusy} onInvalid={onInvalid} />}
      <AppearanceMappingFields calibrated={!!props.calibration} key={`${props.modelId}:${props.sourceId}:${inputReset}`} settings={props.settings} onChange={props.onSettingsChange} disabled={applying || blocked} onInvalid={onInvalid} />
    </div>
    <footer className="shrink-0 space-y-2 border-t bg-background p-3">
      <div role={props.status === 'error' || invalidFields.size ? 'alert' : 'status'} aria-live="polite"
        className={`flex max-h-24 items-start gap-2 overflow-y-auto text-[11px] leading-relaxed ${props.status === 'error' || invalidFields.size ? 'text-destructive' : 'text-muted-foreground'}`}>
        {busy && <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />}
        <span>{message}</span>
      </div>
      <Button type="button" variant="ghost" size="sm" className="w-full" aria-pressed={props.showingOriginal}
        disabled={!props.hasPreview || applying} onClick={() => props.onCompareChange(!props.showingOriginal)}>
        <Eye aria-hidden="true" />{props.showingOriginal ? 'Show preview' : 'Compare original'}
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!props.canDiscard} onClick={() => { setInputReset(value => value + 1); setInvalidFields(new Set()); props.onDiscard(); }}>Discard</Button>
        <Button type="button" size="sm" disabled={!!applyDisabled} onClick={props.onApply}><Check aria-hidden="true" />Apply</Button>
      </div>
    </footer>
  </div>;
}
