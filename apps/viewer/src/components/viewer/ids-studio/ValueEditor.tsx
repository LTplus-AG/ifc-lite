/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The value editor (IDS-035): every `ConstraintDraft` kind, committed as ONE
 * `facet.setField` op through the gate. Enumeration chips on a stored
 * enumeration commit per chip (`value.addEnumValue` / `removeEnumValue`).
 * A "test a value" box checks a sample against the STORED constraint with the
 * validator's own matcher.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import { formatConstraint, type IDSConstraint } from '@ifc-lite/ids';
import type { ValueInput } from '@ifc-lite/ids-authoring';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formFromConstraint, inputFromForm, sampleMatches, VALUE_KINDS, emptyForm, type ValueForm, type ValueKind } from '@/lib/ids-studio/value-model';
import { DigitsForm, LengthForm, OneOfForm, PatternForm, RangeForm } from './ValueForms';

const KIND_LABEL: Record<ValueKind, TranslationKey> = {
  any: 'idsStudio.value.kind.any', equals: 'idsStudio.value.kind.equals', oneOf: 'idsStudio.value.kind.oneOf',
  pattern: 'idsStudio.value.kind.pattern', range: 'idsStudio.value.kind.range', length: 'idsStudio.value.kind.length',
  digits: 'idsStudio.value.kind.digits', raw: 'idsStudio.value.kind.raw',
};

const PROBLEM: Record<'number' | 'empty' | 'unit', TranslationKey> = {
  number: 'idsStudio.value.problem.number', empty: 'idsStudio.value.problem.empty', unit: 'idsStudio.value.problem.unit',
};

export interface ValueEditorProps {
  label: string;
  constraint: IDSConstraint | undefined;
  /** Required fields (names) cannot be "any value". */
  required?: boolean;
  /** XSD base implied by the property's data type. */
  base?: string;
  /** SI unit of a measure data type, shown as the unit placeholder. */
  siUnit?: string;
  onCommit: (input: ValueInput | null) => void;
  onAddEnum?: (value: string) => void;
  onRemoveEnum?: (value: string) => void;
}

function sameForm(a: ValueForm, b: ValueForm): boolean {
  return JSON.stringify({ ...a, raw: undefined }) === JSON.stringify({ ...b, raw: undefined }) && a.raw === b.raw;
}

export function ValueEditor({ label, constraint, required, base, siUnit, onCommit, onAddEnum, onRemoveEnum }: ValueEditorProps) {
  const { t } = useTranslation();
  const id = useId();
  const stored = useMemo(() => formFromConstraint(constraint), [constraint]);
  const [form, setForm] = useState(stored);
  const [problem, setProblem] = useState<keyof typeof PROBLEM | null>(null);
  const [sample, setSample] = useState('');
  useEffect(() => { setForm(stored); setProblem(null); }, [stored]);
  const dirty = !sameForm(form, stored);
  const kinds = VALUE_KINDS.filter((kind) => !(required && kind === 'any'));
  const apply = () => {
    const result = inputFromForm(form, base);
    if ('problem' in result) { setProblem(result.problem); return; }
    setProblem(null);
    onCommit(result.input);
  };
  const chipsCommitDirectly = stored.kind === 'oneOf' && form.kind === 'oneOf' && !dirty;
  const setKind = (kind: ValueKind) => {
    const next = { ...emptyForm(kind), ...(kind === stored.kind ? stored : {}) };
    // Carry a literal over to the list or pattern, so switching kinds does not lose it.
    if (kind === 'oneOf' && form.kind === 'equals' && form.text) next.values = [form.text];
    if (kind === 'pattern' && form.kind === 'equals' && form.text) next.pattern = form.text;
    setForm({ ...next, kind });
    if (kind === 'any' && stored.kind !== 'any') onCommit(null);
  };
  const sampleResult = constraint && sample !== '' ? sampleMatches(constraint, sample, base) : null;
  return <fieldset className="space-y-1.5 rounded border border-border p-2">
    <legend className="px-1 text-2xs text-muted-foreground">{label}</legend>
    <div className="flex items-center gap-1.5">
      <label htmlFor={`${id}-kind`} className="text-2xs text-muted-foreground">{t('idsStudio.value.kindLabel')}</label>
      <select id={`${id}-kind`} className="h-7 rounded border border-input bg-background px-1 text-xs" value={form.kind}
        onChange={(event) => setKind(event.target.value as ValueKind)}>
        {kinds.map((kind) => <option key={kind} value={kind}>{t(KIND_LABEL[kind])}</option>)}
        {form.kind === 'raw' && <option value="raw">{t(KIND_LABEL.raw)}</option>}
      </select>
    </div>
    {form.kind === 'equals' && <div className="space-y-0.5">
      <label htmlFor={`${id}-equals`} className="block text-2xs text-muted-foreground">{t('idsStudio.value.exactValue')}</label>
      <input id={`${id}-equals`} className="h-7 w-full rounded border border-input bg-background px-2 text-xs font-mono" value={form.text}
        onChange={(event) => setForm({ ...form, text: event.target.value })}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); apply(); } }} />
    </div>}
    {form.kind === 'oneOf' && <OneOfForm form={form} onChange={setForm}
      onAdd={chipsCommitDirectly ? onAddEnum : undefined} onRemove={chipsCommitDirectly && form.values.length > 1 ? onRemoveEnum : undefined} />}
    {form.kind === 'pattern' && <PatternForm form={form} onChange={setForm} />}
    {form.kind === 'range' && <RangeForm form={form} onChange={setForm} siUnit={siUnit} />}
    {form.kind === 'length' && <LengthForm form={form} onChange={setForm} />}
    {form.kind === 'digits' && <DigitsForm form={form} onChange={setForm} />}
    {form.kind === 'raw' && form.raw && <p className="rounded bg-muted/50 px-2 py-1 text-xs font-mono break-words">{formatConstraint(form.raw)}</p>}
    {problem && <p role="alert" className="text-2xs text-destructive">{t(PROBLEM[problem])}</p>}
    {dirty && form.kind !== 'any' && <div className="flex gap-1">
      <Button size="sm" className="h-7" onClick={apply}>{t('idsStudio.value.apply')}</Button>
      <Button size="sm" variant="ghost" className="h-7" onClick={() => { setForm(stored); setProblem(null); }}>{t('idsStudio.value.revert')}</Button>
    </div>}
    {constraint && <div className="flex items-center gap-1.5">
      <label htmlFor={`${id}-sample`} className="shrink-0 text-2xs text-muted-foreground">{t('idsStudio.value.test')}</label>
      <input id={`${id}-sample`} className="h-6 min-w-0 flex-1 rounded border border-input bg-background px-1.5 text-xs font-mono" value={sample}
        placeholder={t('idsStudio.value.testPlaceholder')} onChange={(event) => setSample(event.target.value)} />
      {sampleResult !== null && <output className={sampleResult ? 'inline-flex items-center gap-0.5 text-2xs text-emerald-600' : 'inline-flex items-center gap-0.5 text-2xs text-destructive'}>
        {sampleResult ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
        {t(sampleResult ? 'idsStudio.value.matches' : 'idsStudio.value.noMatch')}
      </output>}
    </div>}
  </fieldset>;
}
