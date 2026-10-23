/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { useTranslation } from '@/i18n';
import type { DocumentBlock, DocumentSpec } from '@/lib/document/types';

interface Props {
  document: DocumentSpec;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelectOnly: (id: string) => void;
  onMove: (ids: ReadonlySet<string>, beforeId: string | null) => boolean;
  children: (block: DocumentBlock, index: number) => ReactNode;
}

/** Only handles drag, leaving text fields and source pickers usable. Keyboard
 * and touch users can choose the same destination from the move selector. */
export function DocumentBlockList({ document, selected, onToggle, onSelectOnly, onMove, children }: Props) {
  const { t } = useTranslation();
  const drag = useRef<ReadonlySet<string> | null>(null);
  const [over, setOver] = useState<string | null | undefined>();
  const [announcement, setAnnouncement] = useState({ text: '', sequence: 0 });
  const label = (block: DocumentBlock, index: number) => t('document.selection.block', {
    number: String(index + 1), name: 'title' in block && block.title ? block.title : block.kind === 'text' ? block.text.slice(0, 45) : '',
  });
  const move = (ids: ReadonlySet<string>, before: string | null) => {
    if (!onMove(ids, before)) return;
    const index = document.blocks.findIndex(block => block.id === before);
    const text = index < 0 ? t('document.selection.movedBottom')
      : t('document.selection.movedBefore', { block: label(document.blocks[index], index) });
    setAnnouncement(prior => ({ text, sequence: prior.sequence + 1 }));
  };
  const cancel = () => { drag.current = null; setOver(undefined); };
  const dragOver = (event: DragEvent, before: string | null) => {
    if (!drag.current || (before !== null && drag.current.has(before))) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setOver(before);
  };
  const drop = (event: DragEvent, before: string | null) => {
    if (!drag.current) return;
    event.preventDefault(); event.stopPropagation();
    move(drag.current, before); cancel();
  };
  return <>
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2" data-block-selection-toolbar>
      <span className="text-muted-foreground">{t('document.selection.count', { count: String(selected.size) })}</span>
      <select className="min-w-0 flex-1 rounded border border-border bg-card p-1" value="" disabled={!selected.size}
        aria-label={t('document.selection.moveBefore')} onChange={event => { if (event.target.value) move(selected, event.target.value); }}>
        <option value="">{t('document.selection.moveBefore')}</option>
        {document.blocks.map((block, index) => !selected.has(block.id) && <option key={block.id} value={block.id}>{label(block, index)}</option>)}
      </select>
      <button type="button" className="rounded border border-border px-2 py-1 disabled:opacity-40" disabled={!selected.size}
        onClick={() => move(selected, null)}>{t('document.selection.moveBottom')}</button>
      <output className="sr-only"><span key={announcement.sequence}>{announcement.text}</span></output>
    </div>
    <p className="text-muted-foreground">{t('document.selection.hint')}</p>
    {document.blocks.map((block, index) => <div key={block.id} data-block-list-item={block.id}
      className={`rounded-md border-t-2 ${over === block.id ? 'border-t-sky-500' : 'border-t-transparent'} ${selected.has(block.id) ? 'ring-1 ring-sky-500' : ''}`}
      onDragOver={event => dragOver(event, block.id)} onDrop={event => drop(event, block.id)}>
      <div className="flex items-center gap-2 px-2 py-1">
        <button type="button" draggable className="cursor-grab rounded p-1 text-muted-foreground hover:bg-muted focus-visible:ring-2"
          aria-label={t('document.selection.drag', { number: String(index + 1) })}
          onDragStart={event => {
            const ids = selected.has(block.id) ? new Set(selected) : new Set([block.id]);
            if (!selected.has(block.id)) onSelectOnly(block.id);
            drag.current = ids;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-ifc-document-blocks', document.id);
          }} onDragEnd={cancel}><GripVertical className="h-3.5 w-3.5" /></button>
        <label className="flex min-w-0 cursor-pointer items-center gap-2">
          <input type="checkbox" checked={selected.has(block.id)} onChange={() => onToggle(block.id)} />
          <span className="truncate">{label(block, index)}</span>
        </label>
      </div>
      {children(block, index)}
    </div>)}
    <div className={`min-h-8 rounded border border-dashed p-2 text-center text-muted-foreground ${over === null ? 'border-sky-500 bg-sky-500/10' : 'border-border'}`}
      data-block-drop-end onDragOver={event => dragOver(event, null)} onDrop={event => drop(event, null)}>
      {t('document.selection.dropEnd')}
    </div>
  </>;
}
