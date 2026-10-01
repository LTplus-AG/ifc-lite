/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PlayerField } from '@/lib/flow/player-fields';
import { selectedFiles, type SelectedFiles } from '@/lib/flow/file-values';
import { useTranslation } from '@/i18n';

export function FlowFilesField({ field, value, onChange }: { field: PlayerField; value: unknown; onChange: (value: SelectedFiles) => void }) {
  const { t } = useTranslation();
  let selected: SelectedFiles = {};
  try { if (value !== undefined) selected = selectedFiles(value); }
  catch (error) { console.warn('[flow] invalid local file selection ignored', error); }
  return <div className="space-y-2">
    {field.input.fileSlots?.map((slot) => <div key={slot.id}>
      <label className="block"><span>{slot.label}{slot.required ? ' *' : ''}</span>
        <input key={`${slot.id}:${(selected[slot.id] ?? []).map((file) => `${file.name}:${file.size}`).join("|")}`} type="file" aria-label={slot.label} accept={slot.accept} multiple={slot.multiple} onChange={(event) => {
          onChange({ ...selected, [slot.id]: Array.from(event.target.files ?? []) });
        }} />
      </label>
      {(selected[slot.id]?.length ?? 0) > 0 && <div>
        <span>{selected[slot.id].map((file) => file.name).join(', ')}</span>
        <button type="button" onClick={() => onChange({ ...selected, [slot.id]: [] })}>{t('automationEditor.clearFiles')}</button>
      </div>}
    </div>)}
  </div>;
}
