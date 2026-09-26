/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { appearanceSelectClass } from './AppearanceSourceFields.js';
import type { AppearanceDraftSettings } from './types.js';
import { useTranslation } from '@/i18n';

function NumberField({ name, label, value, positive, onChange, onInvalid }: {
  name: string; label: string; value: number; positive?: boolean;
  onChange(value: number): void; onInvalid(name: string, invalid: boolean): void;
}) {
  const [text, setText] = useState(String(value));
  const invalid = text.trim() === '' || !Number.isFinite(Number(text)) || (positive === true && Number(text) <= 0);
  useEffect(() => { setText(String(value)); onInvalid(name, false); }, [value, name, onInvalid]);
  useEffect(() => () => onInvalid(name, false), [name, onInvalid]);
  return <label className="block space-y-1 text-2xs text-muted-foreground"><span>{label}</span>
    <Input type="number" step="any" min={positive ? 0.000001 : undefined} value={text} aria-label={label} aria-invalid={invalid}
      className="h-8 text-xs aria-[invalid=true]:border-destructive" onChange={event => {
        const next = event.currentTarget.value;
        const number = Number(next);
        const bad = next.trim() === '' || !Number.isFinite(number) || (positive === true && number <= 0);
        setText(next); onInvalid(name, bad);
        if (!bad) onChange(number);
      }} />
  </label>;
}
export function AppearanceMappingFields({ settings: s, onChange, disabled, onInvalid, calibrated = false }: {
  settings: AppearanceDraftSettings; onChange(patch: Partial<AppearanceDraftSettings>): void;
  calibrated?: boolean; disabled: boolean; onInvalid(name: string, invalid: boolean): void;
}) {
  const { t } = useTranslation();
  const uv = !calibrated && s.kind === 'existingUv';
  const box = !calibrated && s.kind === 'box';
  const field = (name: keyof AppearanceDraftSettings, label: string, positive = false) => <NumberField
    key={`${s.kind}:${name}`} name={name} label={label} value={Number(s[name])} positive={positive}
    onChange={value => onChange({ [name]: value })} onInvalid={onInvalid} />;
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="mb-2 text-xs font-medium">{t('appearance.mapping.legend')}</legend>
    {!calibrated && <select aria-label={t('appearance.mapping.kindAriaLabel')} className={appearanceSelectClass} value={s.kind} onChange={event => {
      const kind = event.target.value;
      if (kind === 'existingUv' || kind === 'planar' || kind === 'box') onChange({ kind });
    }}>
      <option value="existingUv">{t('appearance.mapping.kindExistingUv')}</option>
      <option value="planar">{t('appearance.mapping.kindPlanar')}</option>
      <option value="box">{t('appearance.mapping.kindBox')}</option>
    </select>}
    <p className="text-2xs leading-relaxed text-muted-foreground">{calibrated ? t('appearance.mapping.hintCalibrated') : uv ? t('appearance.mapping.hintUv') : t('appearance.mapping.hintTile')}</p>
    {(calibrated || s.kind === 'planar') && <label className="block space-y-1 text-2xs text-muted-foreground"><span>{t('appearance.mapping.projectionPlaneLabel')}</span>
      <select aria-label={t('appearance.mapping.projectionPlaneLabel')} className={appearanceSelectClass} value={s.plane} onChange={event => {
        const plane = event.target.value;
        if (plane === 'xy' || plane === 'xz' || plane === 'yz') onChange({ plane });
      }}><option value="xy">{t('appearance.mapping.planeXy')}</option><option value="xz">{t('appearance.mapping.planeXz')}</option><option value="yz">{t('appearance.mapping.planeYz')}</option></select>
    </label>}
    {!calibrated && <div className="grid grid-cols-2 gap-2">
      {uv ? <>{field('repeatU', t('appearance.mapping.repeatU'), true)}{field('repeatV', t('appearance.mapping.repeatV'), true)}</> :
        <>{field('tileWidth', box ? t('appearance.mapping.tileXm') : t('appearance.mapping.tileWidthM'), true)}{field('tileHeight', box ? t('appearance.mapping.tileYm') : t('appearance.mapping.tileHeightM'), true)}{box && field('tileDepth', t('appearance.mapping.tileZm'), true)}</>}
    </div>}
    <details className="rounded-md border px-2.5 py-2">
      <summary className="cursor-pointer text-2xs font-medium">{calibrated ? t('appearance.mapping.alignment') : t('appearance.mapping.alignmentAndTiling')}</summary>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {!box && field('rotationDegrees', t('appearance.mapping.rotationDegrees'))}
        {field('offsetU', calibrated ? t('appearance.mapping.pointAX') : uv ? t('appearance.mapping.offsetUUv') : box ? t('appearance.mapping.offsetXm') : t('appearance.mapping.offsetUm'))}
        {field('offsetV', calibrated ? t('appearance.mapping.pointAY') : uv ? t('appearance.mapping.offsetVUv') : box ? t('appearance.mapping.offsetYm') : t('appearance.mapping.offsetVm'))}
        {(box || calibrated) && field('offsetW', calibrated ? t('appearance.mapping.pointAZ') : t('appearance.mapping.offsetZm'))}
      </div>
      {!calibrated && <div className="mt-3 flex gap-4 text-2xs">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={s.repeatS} onChange={event => onChange({ repeatS: event.target.checked })} />{t('appearance.mapping.tileU')}</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={s.repeatT} onChange={event => onChange({ repeatT: event.target.checked })} />{t('appearance.mapping.tileV')}</label>
      </div>}
    </details>
  </fieldset>;
}
