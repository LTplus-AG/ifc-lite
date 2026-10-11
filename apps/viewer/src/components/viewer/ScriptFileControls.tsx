/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';
import { decodePortableScript, encodePortableScript, SCRIPT_FILE_LIMIT } from '@/lib/scripts/portable-script';
import { captureScriptImportOwner, commitImportedScript } from '@/lib/scripts/import-script';
import type { SavedScript } from '@/lib/scripts/persistence';
export function ScriptFileControls() {
  const { t } = useTranslation();
  const scripts = useViewerStore(s => s.savedScripts);
  const activeId = useViewerStore(s => s.activeScriptId);
  const script = scripts.find(row => row.id === activeId);
  const input = useRef<HTMLInputElement>(null);
  const owner = useRef({ alive: true, sequence: 0 });
  const [pending, setPending] = useState<SavedScript | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { const current = { alive: true, sequence: 0 }; owner.current = current; return () => { current.alive = false; }; }, []);
  function retry() {
    if (!pending) return;
    try { commitImportedScript(pending, captureScriptImportOwner()); setPending(null); setMessage(t('scriptPanel.files.imported')); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }
  async function importFile(file: File) {
    const lease = owner.current; const sequence = ++lease.sequence;
    setMessage(''); setPending(null); setBusy(true);
    try {
      const snapshot = captureScriptImportOwner();
      if (file.size > SCRIPT_FILE_LIMIT) throw new Error(t('scriptPanel.files.tooLarge'));
      const text = await file.text();
      if (!lease.alive || owner.current !== lease || lease.sequence !== sequence) return;
      const decoded = decodePortableScript(text); setPending(decoded);
      commitImportedScript(decoded, snapshot);
      setPending(null); setMessage(t('scriptPanel.files.imported'));
    } catch (error) {
      if (lease.alive && owner.current === lease && lease.sequence === sequence) setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (lease.alive && owner.current === lease && lease.sequence === sequence) setBusy(false);
    }
  }
  return <div className="border-b px-2 py-1.5 text-xs">
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={!script} aria-label={t('scriptPanel.files.export')} onClick={() => {
        if (!script) return;
        try { downloadFile(encodePortableScript(script), `${sanitizeFilename(script.name)}.ifc-script.json`, 'application/json'); setMessage(t('scriptPanel.files.savedOnly')); }
        catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
      }}>{t('scriptPanel.files.export')}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>{t('scriptPanel.files.import')}</Button>
      <input ref={input} type="file" className="hidden" accept=".json,.ifc-script.json" aria-label={t('scriptPanel.files.import')} onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importFile(file);
      }} />
      {pending && !busy && <Button size="sm" variant="outline" onClick={retry}>{t('scriptPanel.files.retry')}</Button>}
    </div>
    {message && <output className="block mt-1 whitespace-normal">{message}</output>}
  </div>;
}
