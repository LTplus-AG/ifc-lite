/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { appearanceSelectClass } from './AppearanceSourceFields.js';
import type { AppearanceDraftSettings } from './types.js';

function NumberField({ name, label, value, positive, onChange, onInvalid }: {
  name: string; label: string; value: number; positive?: boolean;
  onChange(value: number): void; onInvalid(name: string, invalid: boolean): void;
}) {
  const [text, setText] = useState(String(value));
  const invalid = text.trim() === '' || !Number.isFinite(Number(text)) || (positive === true && Number(text) <= 0);
  useEffect(() => { setText(String(value)); onInvalid(name, false); }, [value, name, onInvalid]);
  useEffect(() => () => onInvalid(name, false), [name, onInvalid]);
  return <label className="block space-y-1 text-[11px] text-muted-foreground"><span>{label}</span>
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
  const uv = s.kind === 'existingUv';
  const box = s.kind === 'box';
  const field = (name: keyof AppearanceDraftSettings, label: string, positive = false) => <NumberField
    key={`${s.kind}:${name}`} name={name} label={label} value={Number(s[name])} positive={positive}
    onChange={value => onChange({ [name]: value })} onInvalid={onInvalid} />;
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="mb-2 text-xs font-medium">Mapping</legend>
    {!calibrated && <select aria-label="Texture mapping" className={appearanceSelectClass} value={s.kind} onChange={event => {
      const kind = event.target.value;
      if (kind === 'existingUv' || kind === 'planar' || kind === 'box') onChange({ kind });
    }}>
      <option value="existingUv">Existing UV coordinates</option>
      <option value="planar">Planar projection</option>
      <option value="box">Box projection</option>
    </select>}
    <p className="text-[10px] leading-relaxed text-muted-foreground">{calibrated ? 'Place point A at the model coordinates below. Drawing scale comes from the measured span.' : uv ? 'Keep the surface’s UV layout. Repeat values are multipliers.' : 'Consistent physical tile size across objects, in IFC world coordinates.'}</p>
    {s.kind === 'planar' && <label className="block space-y-1 text-[11px] text-muted-foreground"><span>Projection plane</span>
      <select aria-label="Projection plane" className={appearanceSelectClass} value={s.plane} onChange={event => {
        const plane = event.target.value;
        if (plane === 'xy' || plane === 'xz' || plane === 'yz') onChange({ plane });
      }}><option value="xy">XY · horizontal</option><option value="xz">XZ · vertical</option><option value="yz">YZ · vertical</option></select>
    </label>}
    {!calibrated && <div className="grid grid-cols-2 gap-2">
      {uv ? <>{field('repeatU', 'Repeat U (×)', true)}{field('repeatV', 'Repeat V (×)', true)}</> :
        <>{field('tileWidth', box ? 'Tile X (m)' : 'Tile width (m)', true)}{field('tileHeight', box ? 'Tile Y (m)' : 'Tile height (m)', true)}{box && field('tileDepth', 'Tile Z (m)', true)}</>}
    </div>}
    <details className="rounded-md border px-2.5 py-2">
      <summary className="cursor-pointer text-[11px] font-medium">{calibrated ? 'Alignment' : 'Alignment and tiling'}</summary>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {!box && field('rotationDegrees', 'Rotation (°)')}
        {field('offsetU', calibrated ? 'Point A · X (m)' : uv ? 'Offset U (UV)' : box ? 'Offset X (m)' : 'Offset U (m)')}
        {field('offsetV', calibrated ? 'Point A · Y (m)' : uv ? 'Offset V (UV)' : box ? 'Offset Y (m)' : 'Offset V (m)')}
        {(box || calibrated) && field('offsetW', calibrated ? 'Point A · Z (m)' : 'Offset Z (m)')}
      </div>
      {!calibrated && <div className="mt-3 flex gap-4 text-[11px]">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={s.repeatS} onChange={event => onChange({ repeatS: event.target.checked })} />Tile U</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={s.repeatT} onChange={event => onChange({ repeatT: event.target.checked })} />Tile V</label>
      </div>}
    </details>
  </fieldset>;
}
