/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * No document open: start a new IDS, or open the IDS that Data validation has
 * loaded. Creating or opening a document replaces the Studio document
 * wholesale; it is not an edit, so it is not an op.
 */

import { useId, useRef, useState } from 'react';
import { ClipboardPen, FilePlus2, FolderOpen } from 'lucide-react';
import { createStudioDocument, fromIdsDocument } from '@ifc-lite/ids-authoring';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { importStudioFile } from '@/lib/ids-studio/import';

export function StudioEmptyState() {
  const { t } = useTranslation();
  const id = useId();
  const open = useViewerStore((s) => s.idsStudioOpen);
  const loaded = useViewerStore((s) => s.idsDocument);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const openFile = async (file: File) => {
    const result = await importStudioFile(file);
    if (result.ok) { setError(null); open(result.doc); } else setError(result.error);
  };
  return <div className="space-y-4 p-3">
    <div className="flex items-start gap-2">
      <ClipboardPen className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{t('idsStudio.empty.heading')}</h2>
        <p className="text-xs text-muted-foreground">{t('idsStudio.empty.body')}</p>
      </div>
    </div>
    <form className="space-y-2 rounded border border-border p-2" onSubmit={(event) => {
      event.preventDefault();
      open(createStudioDocument({ title: title.trim() || t('idsStudio.empty.defaultTitle') }));
    }}>
      <label htmlFor={id} className="block text-2xs text-muted-foreground">{t('idsStudio.info.title')}</label>
      <input id={id} className="h-7 w-full rounded border border-input bg-background px-2 text-xs" value={title}
        placeholder={t('idsStudio.empty.titlePlaceholder')} onChange={(event) => setTitle(event.target.value)} />
      <Button type="submit" size="sm" className="h-7"><FilePlus2 className="mr-1 h-3.5 w-3.5" aria-hidden />{t('idsStudio.empty.create')}</Button>
    </form>
    <div className="space-y-1 rounded border border-border p-2">
      <input ref={fileInput} type="file" accept=".ids,.xml,.idsz" className="hidden" aria-label={t('idsStudio.empty.openFile')}
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void openFile(file); }} />
      <Button size="sm" variant="outline" className="h-7" onClick={() => fileInput.current?.click()}>
        <FolderOpen className="mr-1 h-3.5 w-3.5" aria-hidden />{t('idsStudio.empty.openFile')}
      </Button>
      <p className="text-2xs text-muted-foreground">{t('idsStudio.empty.openFileHint')}</p>
      {error && <p role="alert" className="text-2xs text-destructive break-words">{t('idsStudio.empty.openFailed', { reason: error })}</p>}
    </div>
    {loaded && <div className="space-y-1 rounded border border-border p-2">
      <p className="text-xs">{t('idsStudio.empty.loaded', { title: loaded.info.title || t('idsStudio.outline.untitled') })}</p>
      <Button size="sm" variant="outline" className="h-7" onClick={() => open(fromIdsDocument(loaded))}>
        <FolderOpen className="mr-1 h-3.5 w-3.5" aria-hidden />{t('idsStudio.empty.editLoaded')}
      </Button>
    </div>}
  </div>;
}
