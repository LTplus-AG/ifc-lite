/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { automationInput } from './editor-styles';
import type { ModelSelector } from '@ifc-lite/flow-nodes';
import { useTranslation } from '@/i18n';

export function ModelSelectorEditor({ value, onChange, slots, label }: {
  value: ModelSelector; onChange: (value: ModelSelector) => void; slots: readonly string[]; label: string;
}) {
  const { t } = useTranslation();
  const text = value.kind === 'slot' ? value.slotId : value.kind === 'filename' ? value.filename : value.tagName;
  const update = (kind: ModelSelector['kind'], next: string): void => onChange(kind === 'slot'
    ? { kind, slotId: next } : kind === 'filename' ? { kind, filename: next } : { kind, tagName: next });
  return <div className="flex gap-1">
    <select className={automationInput} aria-label={`${label} ${t('automationEditor.selectorKind')}`} value={value.kind}
      onChange={(event) => update(event.target.value as ModelSelector['kind'], event.target.value === 'slot' ? slots[0] ?? '' : '')}>
      <option value="slot">{t('automationEditor.slot')}</option>
      <option value="filename">{t('automationEditor.filename')}</option>
      <option value="tagName">{t('automationEditor.tagName')}</option>
    </select>
    {value.kind === 'slot' ? <select className={automationInput} aria-label={label} value={text} onChange={(event) => update(value.kind, event.target.value)}>
      <option value="">{t('automationEditor.chooseSlot')}</option>
      {slots.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
    </select> : <input className={automationInput} aria-label={label} value={text} onChange={(event) => update(value.kind, event.target.value)} />}
  </div>;
}
