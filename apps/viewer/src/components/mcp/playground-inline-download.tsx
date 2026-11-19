/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactNode } from 'react';
import { Check, Download } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { playgroundFiles, formatBytes as formatFileBytes } from './playground-files';
import type { ToolDispatchResult } from './playground-dispatcher';

/**
 * InlineDownload — chartreuse "Get .bcf" / "Save IFC" pill that surfaces
 * directly under the tool-call header whenever a tool produced a file. The
 * file is already in the playgroundFiles store (so the sidebar Downloads
 * panel mirrors it); this is the discoverable, in-context offer right next
 * to the action that produced it.
 *
 * UX rules baked in:
 *   • The artifact NEVER auto-downloads. The user has to click.
 *   • After a click, the button shows "Saved" for ~2s so the user has
 *     visible feedback without losing the affordance to re-download.
 *   • Re-clicking re-runs the download — useful if the user closed the
 *     prompt by accident.
 */
export function InlineDownload({
  download,
}: {
  download: NonNullable<ToolDispatchResult['download']>;
}): ReactNode {
  const { t } = useTranslation();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const justSaved = savedAt != null && Date.now() - savedAt < 2000;
  useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  return (
    <div className="border-t border-white/5 px-3 py-2">
      <button aria-label={justSaved ? t('mcp.playgroundChat.savedLabel') : download.label}
        onClick={() => {
          playgroundFiles.download(download.fileId);
          setSavedAt(Date.now());
        }}
        className={cn(
          'group flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left transition-colors',
          justSaved ? 'bg-white/10' : 'bg-[#d6ff3f] hover:bg-[#e6ff66]',
        )}
        style={justSaved ? { color: '#d6ff3f' } : { color: '#0a0a0c' }}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded',
              justSaved ? 'bg-white/10' : 'bg-black/10',
            )}
          >
            {justSaved ? <Check size={14} strokeWidth={2.6} /> : <Download size={14} strokeWidth={2.4} />}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span
              className="truncate text-sm font-semibold"
              style={{ fontFamily: '"Bricolage Grotesque", system-ui, sans-serif' }}
            >
              {justSaved ? t('mcp.playgroundChat.savedLabel') : download.label}
            </span>
            <span
              className={cn('truncate text-2xs', justSaved ? 'text-white/50' : 'text-black/55')}
              style={{ fontFamily: '"JetBrains Mono", monospace' }}
            >
              {download.filename} · {formatFileBytes(download.size)}
            </span>
          </span>
        </span>
      </button>
    </div>
  );
}

