/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { automationInput, automationButton } from './automation/editor-styles';
import type { FlowDocument, FlowFileSlot } from '@ifc-lite/flow';
import { useTranslation } from '@/i18n';

export function FlowFileSlotsEditor({ doc, nodeId, onChange, defaultAccept = '.json,.ids,.ifc' }: { doc: FlowDocument; nodeId: string; onChange: (doc: FlowDocument) => void; defaultAccept?: string }) {
  const { t } = useTranslation();
  const input = doc.inputs.find((value) => value.nodeId === nodeId && value.param === 'files' && value.kind === 'files');
  if (!input) return null;
  const slots = input.fileSlots ?? [];
  const change = (fileSlots: readonly FlowFileSlot[]) => onChange({ ...doc, inputs: doc.inputs.map((value) => value === input ? { ...value, fileSlots } : value) });
  const patch = (index: number, value: Partial<FlowFileSlot>) => change(slots.map((slot, i) => i === index ? { ...slot, ...value } : slot));
  return <div className="space-y-2">
    {slots.map((slot, index) => <fieldset key={index} className="rounded border border-border p-1">
      <legend>{t('automationEditor.fileSlot', { index: index + 1 })}</legend>
      <input className={automationInput} aria-label={t('automationEditor.slotId')} value={slot.id} onChange={(event) => patch(index, { id: event.target.value })} />
      <input className={automationInput} aria-label={t('automationEditor.slotLabel')} value={slot.label} onChange={(event) => patch(index, { label: event.target.value })} />
      <input className={automationInput} aria-label={t('automationEditor.slotAccept')} value={slot.accept} onChange={(event) => patch(index, { accept: event.target.value })} />
      <label><input type="checkbox" checked={slot.multiple} onChange={(event) => patch(index, { multiple: event.target.checked })} />{t('automationEditor.slotMultiple')}</label>
      <label><input type="checkbox" checked={slot.required} onChange={(event) => patch(index, { required: event.target.checked })} />{t('automationEditor.slotRequired')}</label>
      <button className={automationButton} type="button" onClick={() => change(slots.filter((_, i) => i !== index))}>{t('automationEditor.remove')}</button>
    </fieldset>)}
    <button className={automationButton} type="button" onClick={() => change([...slots, { id: `slot-${slots.length + 1}`, label: `Files ${slots.length + 1}`, accept: defaultAccept, multiple: false, required: true }])}>{t('automationEditor.addSlot')}</button>
  </div>;
}
