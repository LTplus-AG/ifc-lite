/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The document's "…" menu (#4594): rename, duplicate, delete, and the
 * `.ifclite-document.json` file — the template you re-open on the next
 * revision of the model. Same shape as the dashboard menu.
 */
import { useRef } from 'react';
import { Copy, Download, MoreHorizontal, Pencil, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { DOCUMENT_FILE_SUFFIX, exportDocument, freshBlockId, freshDocumentId, importDocument } from '@/lib/document/persistence';
import type { DocumentSpec } from '@/lib/document/types';

export interface DocumentMenuProps {
  document: DocumentSpec | null;
  onUpsert: (document: DocumentSpec) => void;
  onDelete: (id: string) => void;
  onActivate: (id: string) => void;
}

export function DocumentMenu({ document, onUpsert, onDelete, onActivate }: DocumentMenuProps) {
  const fileInput = useRef<HTMLInputElement | null>(null);

  const rename = (): void => {
    if (!document) return;
    const name = window.prompt('Document name', document.name)?.trim();
    if (name && name !== document.name) onUpsert({ ...document, name });
  };
  const duplicate = (): void => {
    if (!document) return;
    const copy: DocumentSpec = { ...document, id: freshDocumentId(), name: `${document.name} (copy)`, blocks: document.blocks.map((b) => ({ ...b, id: freshBlockId() })) };
    onUpsert(copy);
    onActivate(copy.id);
  };
  const onImportFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const imported = await importDocument(file);
      onUpsert(imported);
      onActivate(imported.id);
      toast.success(`Imported document "${imported.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to import the document');
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" aria-label="Document actions" title="Rename, duplicate, delete, export or import a document">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48 text-xs">
          <DropdownMenuItem disabled={!document} onSelect={rename}><Pencil className="h-3.5 w-3.5 mr-2" />Rename</DropdownMenuItem>
          <DropdownMenuItem disabled={!document} onSelect={duplicate}><Copy className="h-3.5 w-3.5 mr-2" />Duplicate</DropdownMenuItem>
          <DropdownMenuItem disabled={!document} onSelect={() => document && onDelete(document.id)}><Trash2 className="h-3.5 w-3.5 mr-2" />Delete</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!document} onSelect={() => document && exportDocument(document)}><Download className="h-3.5 w-3.5 mr-2" />Export template…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => fileInput.current?.click()}><Upload className="h-3.5 w-3.5 mr-2" />Import template…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInput}
        type="file"
        accept={`${DOCUMENT_FILE_SUFFIX},.json`}
        className="hidden"
        data-document-import
        onChange={(e) => {
          void onImportFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </>
  );
}
