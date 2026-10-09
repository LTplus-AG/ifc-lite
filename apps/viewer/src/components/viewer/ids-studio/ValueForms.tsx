/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Per-kind form fields of the value editor (IDS-035). State only; the editor commits. */

import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { explainXsdPattern } from '@ifc-lite/ids-authoring';
import { useTranslation } from '@/i18n';
import { splitPastedValues, type ValueForm } from '@/lib/ids-studio/value-model';
import { splitQuantity, UNIT_SUGGESTIONS } from '@/lib/ids-studio/units';

const box = 'h-7 w-full rounded border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function NumberField({ label, value, onChange, onBlur }: { label: string; value: string; onChange: (value: string) => void; onBlur?: (value: string) => void }) {
  const id = useId();
  return <div className="min-w-0 flex-1 space-y-0.5">
    <label htmlFor={id} className="block text-2xs text-muted-foreground">{label}</label>
    <input id={id} inputMode="decimal" className={box} value={value} onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur ? (event) => onBlur(event.target.value) : undefined} />
  </div>;
}

function Inclusive({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex items-center gap-1 text-2xs text-muted-foreground">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}
  </label>;
}

/** Enumeration chips: add one, remove one, or paste a column of values. */
export function OneOfForm({ form, onChange, onAdd, onRemove }: {
  form: ValueForm;
  onChange: (form: ValueForm) => void;
  /** When set, a chip change is committed at once (an enumeration already stored). */
  onAdd?: (value: string) => void;
  onRemove?: (value: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [entry, setEntry] = useState('');
  const [paste, setPaste] = useState(false);
  const add = (values: string[]) => {
    const fresh = values.filter((v) => !form.values.includes(v));
    if (!fresh.length) return;
    if (onAdd && fresh.length === 1) onAdd(fresh[0]);
    else onChange({ ...form, values: [...form.values, ...fresh] });
  };
  return <div className="space-y-1">
    <ul aria-label={t('idsStudio.value.chips')} className="flex flex-wrap gap-1">
      {form.values.map((value) => <li key={value} className="inline-flex items-center gap-0.5 rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-mono">
        {value}
        <button type="button" aria-label={t('idsStudio.value.removeChip', { value })} className="rounded hover:bg-background"
          onClick={() => (onRemove ? onRemove(value) : onChange({ ...form, values: form.values.filter((v) => v !== value) }))}>
          <X className="h-3 w-3" aria-hidden />
        </button>
      </li>)}
    </ul>
    <div className="flex gap-1">
      <label htmlFor={id} className="sr-only">{t('idsStudio.value.addChip')}</label>
      <input id={id} className={box} value={entry} placeholder={t('idsStudio.value.addChipPlaceholder')}
        onChange={(event) => setEntry(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && entry.trim()) { event.preventDefault(); add([entry.trim()]); setEntry(''); } }} />
      <button type="button" className="h-7 shrink-0 rounded border border-border px-2 text-2xs hover:bg-muted" aria-expanded={paste} onClick={() => setPaste((v) => !v)}>
        {t('idsStudio.value.bulkPaste')}
      </button>
    </div>
    {paste && <textarea aria-label={t('idsStudio.value.bulkPasteLabel')} rows={3} className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono"
      placeholder={t('idsStudio.value.bulkPasteHint')}
      onPaste={(event) => { event.preventDefault(); add(splitPastedValues(event.clipboardData.getData('text'))); setPaste(false); }} />}
  </div>;
}

export function PatternForm({ form, onChange }: { form: ValueForm; onChange: (form: ValueForm) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const explanation = form.pattern ? explainXsdPattern(form.pattern) : null;
  return <div className="space-y-1">
    <label htmlFor={id} className="block text-2xs text-muted-foreground">{t('idsStudio.value.pattern')}</label>
    <input id={id} className={`${box} font-mono`} value={form.pattern} spellCheck={false} onChange={(event) => onChange({ ...form, pattern: event.target.value })} />
    {explanation && <div className="rounded bg-muted/50 px-2 py-1 text-2xs">
      <p className="text-muted-foreground">{t('idsStudio.value.patternAnchored')}</p>
      <ul>{explanation.parts.map((part, i) => <li key={i}><code className="font-mono">{part.text}</code> — {part.meaning}</li>)}</ul>
      {explanation.unsupported.length > 0 && <p className="text-destructive">{t('idsStudio.value.patternUnsupported', { parts: explanation.unsupported.join(' ') })}</p>}
    </div>}
  </div>;
}

export function RangeForm({ form, onChange, siUnit }: { form: ValueForm; onChange: (form: ValueForm) => void; siUnit?: string }) {
  const { t } = useTranslation();
  const unitId = useId();
  // "2400 mm" typed into a bound moves the unit into the unit field on blur (IDS-045).
  const split = (key: 'min' | 'max', text: string) => {
    const { number, unit } = splitQuantity(text);
    onChange({ ...form, [key]: number, ...(unit ? { unit } : {}) });
  };
  return <div className="space-y-1">
    <div className="flex items-end gap-1.5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <NumberField label={t('idsStudio.value.min')} value={form.min} onChange={(min) => onChange({ ...form, min })} onBlur={(min) => split('min', min)} />
        <Inclusive label={t('idsStudio.value.inclusive')} checked={form.minInclusive} onChange={(minInclusive) => onChange({ ...form, minInclusive })} />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <NumberField label={t('idsStudio.value.max')} value={form.max} onChange={(max) => onChange({ ...form, max })} onBlur={(max) => split('max', max)} />
        <Inclusive label={t('idsStudio.value.inclusive')} checked={form.maxInclusive} onChange={(maxInclusive) => onChange({ ...form, maxInclusive })} />
      </div>
      <div className="w-20 space-y-0.5 self-start">
        <label htmlFor={unitId} className="block text-2xs text-muted-foreground">{t('idsStudio.value.unit')}</label>
        <input id={unitId} list={`${unitId}-units`} className={box} value={form.unit} placeholder={siUnit ?? t('idsStudio.value.unitSi')}
          onChange={(event) => onChange({ ...form, unit: event.target.value })} />
        <datalist id={`${unitId}-units`}>{UNIT_SUGGESTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</datalist>
      </div>
    </div>
    <p className="text-2xs text-muted-foreground">{t('idsStudio.value.unitHint')}</p>
  </div>;
}

export function LengthForm({ form, onChange }: { form: ValueForm; onChange: (form: ValueForm) => void }) {
  const { t } = useTranslation();
  return <div className="flex gap-1.5">
    <NumberField label={t('idsStudio.value.exactLength')} value={form.exact} onChange={(exact) => onChange({ ...form, exact })} />
    <NumberField label={t('idsStudio.value.minLength')} value={form.min} onChange={(min) => onChange({ ...form, min })} />
    <NumberField label={t('idsStudio.value.maxLength')} value={form.max} onChange={(max) => onChange({ ...form, max })} />
  </div>;
}

export function DigitsForm({ form, onChange }: { form: ValueForm; onChange: (form: ValueForm) => void }) {
  const { t } = useTranslation();
  return <div className="flex gap-1.5">
    <NumberField label={t('idsStudio.value.totalDigits')} value={form.total} onChange={(total) => onChange({ ...form, total })} />
    <NumberField label={t('idsStudio.value.fractionDigits')} value={form.fraction} onChange={(fraction) => onChange({ ...form, fraction })} />
  </div>;
}
