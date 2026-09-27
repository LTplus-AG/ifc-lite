/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The editor for a `code` parameter — the Script node's source.
 *
 * A `string` param renders as a one-line `<input>`, which is the one thing
 * a script cannot be typed into: no newlines, no indentation, no way to
 * read what is already there. So a `code` param gets two surfaces that
 * edit the same value:
 *
 *  - an inline monospace textarea in the 256px inspector, for a one-liner
 *    or a quick tweak without leaving the node;
 *  - a full CodeMirror editor in a dialog (the same component and the same
 *    `bim.*` completions as the script console), for real work.
 *
 * Both write straight through to the param, so there is no draft state to
 * lose and nothing to sync when the dialog closes.
 */

import { lazy, Suspense, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import type { ParamDef } from '@ifc-lite/flow';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n/useTranslation';

// CodeMirror and its language/autocomplete extensions are ~200 kB that a
// graph without a Script node never needs.
const CodeEditor = lazy(() => import('../CodeEditor').then((m) => ({ default: m.CodeEditor })));

export interface FlowCodeParamProps {
  readonly def: ParamDef;
  readonly value: unknown;
  readonly nodeTitle: string;
  /** Port names the code reads as `inputs.<name>`, shown as a reminder. */
  readonly inputNames: readonly string[];
  readonly outputName: string;
  readonly onChange: (v: string) => void;
}

export function FlowCodeParam({ def, value, nodeTitle, inputNames, outputName, onChange }: FlowCodeParamProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const code = typeof value === 'string' ? value : typeof def.default === 'string' ? def.default : '';
  const hint = t('flowPanel.inspector.codeHint', { inputs: inputNames.map((n) => `inputs.${n}`).join(', '), output: outputName });

  return (
    <div>
      <div className="relative">
        <textarea
          className="w-full min-w-0 resize-y rounded border border-border bg-transparent px-1.5 py-1 pr-6 font-mono text-2xs leading-snug"
          rows={5}
          spellCheck={false}
          value={code}
          aria-label={t('flowPanel.inspector.codeAriaLabel', { param: def.name })}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t('flowPanel.inspector.codeExpand')}
          aria-label={t('flowPanel.inspector.codeExpand')}
          onClick={() => setOpen(true)}
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>
      <div className="mt-0.5 text-2xs text-muted-foreground">{hint}</div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[80vh] max-w-4xl flex-col gap-2">
          <DialogHeader>
            <DialogTitle>{t('flowPanel.inspector.codeDialogTitle', { node: nodeTitle })}</DialogTitle>
          </DialogHeader>
          <div className="text-xs text-muted-foreground">{hint}</div>
          <div className="min-h-0 flex-1 overflow-hidden rounded border border-border">
            <Suspense fallback={<div className="p-2 text-xs text-muted-foreground">{t('flowPanel.inspector.codeLoading')}</div>}>
              <CodeEditor value={code} onChange={onChange} className="h-full" />
            </Suspense>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
