/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Change sets panel (#6232 D4): named groups of edits. New edits land in
 * the active set; a set can be renamed, opened to see its edits by element,
 * exported as a file, imported back, or discarded. Every write goes through
 * `change-set-actions`, so the mutation slice owns the data.
 */

import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ChevronDown, ChevronRight, Download, GitBranch, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { confirmDialog, promptDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { formatLocaleDate } from '@/i18n/intlFormat';
import { cn } from '@/lib/utils';
import { downloadFile } from '@/lib/export/download';
import { useViewerStore } from '@/store';
import { changeSetFileName, changeSetSummaries, type ChangeSetSummary } from '@/lib/change-sets/change-set-view';
import {
  activateChangeSet, createChangeSet, discardChangeSet, exportChangeSet, importChangeSet, renameChangeSet,
} from '@/lib/change-sets/change-set-actions';
import { ChangeSetContents } from './ChangeSetContents';

export function ChangeSetPanel({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const changeSets = useViewerStore((s) => s.changeSets);
  const activeId = useViewerStore((s) => s.activeChangeSetId);
  const rows = useMemo(() => changeSetSummaries(changeSets, activeId), [changeSets, activeId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const create = async () => {
    const name = await promptDialog({
      title: t('changeSets.newTitle'),
      description: t('changeSets.newDescription'),
      defaultValue: t('changeSets.defaultName', { number: changeSets.size + 1 }),
      confirmLabel: t('changeSets.new'),
    });
    if (name?.trim()) createChangeSet(name.trim());
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const id = importChangeSet(await file.text());
    if (!id) {
      toast.error(t('changeSets.importFailed', { file: file.name }));
      return;
    }
    setOpenId(id);
    toast.success(t('changeSets.importDone', { name: useViewerStore.getState().changeSets.get(id)?.name ?? file.name }));
  };

  return (
    <div data-change-set-panel className="flex h-full min-h-0 flex-col" aria-label={t('changeSets.panel.title')}>
      <div className="flex items-center gap-2 border-b p-3">
        <GitBranch className="h-4 w-4" aria-hidden="true" />
        <h2 className="flex-1 text-sm font-medium">{t('changeSets.panel.title')}</h2>
        <span className="text-xs text-muted-foreground">{t('changeSets.panel.count', { count: rows.length })}</span>
        {onClose && <IconButton label={t('changeSets.panel.close')} className="h-6 w-6" onClick={onClose}><X className="h-3.5 w-3.5" /></IconButton>}
      </div>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button type="button" size="sm" onClick={() => void create()}>
          <Plus className="h-3 w-3" aria-hidden="true" />{t('changeSets.new')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
          <Upload className="h-3 w-3" aria-hidden="true" />{t('changeSets.import')}
        </Button>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" data-change-set-import onChange={(e) => void importFile(e)} />
      </div>
      <p className="px-3 pt-2 text-2xs text-muted-foreground">
        {rows.length === 0 ? t('changeSets.empty') : activeId === null ? t('changeSets.noActive') : t('changeSets.panel.intro')}
      </p>
      <ol className="min-h-0 flex-1 divide-y overflow-y-auto">
        {rows.map((row) => (
          <ChangeSetRow key={row.id} row={row} open={openId === row.id} onToggle={() => setOpenId(openId === row.id ? null : row.id)} />
        ))}
      </ol>
    </div>
  );
}

function ChangeSetRow({ row, open, onToggle }: { row: ChangeSetSummary; open: boolean; onToggle: () => void }) {
  const { t, locale } = useTranslation();
  const changeSet = useViewerStore((s) => s.changeSets.get(row.id));
  const { id, name } = row;
  const created = formatLocaleDate(locale, row.createdAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const rename = async () => {
    const next = await promptDialog({
      title: t('changeSets.renameTitle'),
      description: t('changeSets.renameDescription', { name }),
      defaultValue: name,
    });
    if (next?.trim() && next.trim() !== name) renameChangeSet(id, next.trim());
  };

  const exportFile = () => {
    const json = exportChangeSet(id);
    if (json) downloadFile(json, changeSetFileName(name), 'application/json');
  };

  const discard = async () => {
    const ok = await confirmDialog({
      title: t('changeSets.discardTitle'),
      description: t('changeSets.discardDescription', { name, count: row.mutationCount }),
      confirmLabel: t('changeSets.discardConfirm'),
      destructive: true,
    });
    if (ok) discardChangeSet(id);
  };

  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li data-change-set-row={id} data-active={row.active || undefined} className={cn(row.active && 'bg-overlay-accent-soft/40')}>
      <div className="flex items-center gap-1.5 px-2 py-2">
        <IconButton
          label={t(open ? 'changeSets.row.hide' : 'changeSets.row.show', { name })}
          aria-expanded={open}
          className="h-6 w-6"
          onClick={onToggle}
        >
          <Chevron className="h-3.5 w-3.5" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium" data-change-set-name>{name}</span>
          <span className="flex flex-wrap gap-x-2 text-2xs text-muted-foreground">
            <span data-change-set-count>{t('changeSets.row.edits', { count: row.mutationCount })}</span>
            <span>{t('changeSets.row.created', { time: created })}</span>
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn('h-6 px-2 text-2xs', row.active && 'border-overlay-accent/50 bg-overlay-accent-soft text-overlay-accent hover:bg-overlay-accent-soft')}
          aria-pressed={row.active}
          aria-label={t(row.active ? 'changeSets.row.deactivate' : 'changeSets.row.activate', { name })}
          onClick={() => activateChangeSet(row.active ? null : id)}
        >
          {t(row.active ? 'changeSets.row.active' : 'changeSets.row.setActive')}
        </Button>
        <IconButton label={t('changeSets.row.rename', { name })} className="h-6 w-6" onClick={() => void rename()}>
          <Pencil className="h-3 w-3" />
        </IconButton>
        <IconButton label={t('changeSets.row.export', { name })} className="h-6 w-6" onClick={exportFile}>
          <Download className="h-3 w-3" />
        </IconButton>
        <IconButton label={t('changeSets.row.discard', { name })} className="h-6 w-6" onClick={() => void discard()}>
          <Trash2 className="h-3 w-3" />
        </IconButton>
      </div>
      {open && changeSet && <ChangeSetContents changeSet={changeSet} />}
    </li>
  );
}
