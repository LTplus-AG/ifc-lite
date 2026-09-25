/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-app replacements for `window.confirm` and `window.prompt` (#5813).
 *
 * The native dialogs block the event loop (and with it rendering and the
 * WebGPU frame loop), ignore the theme and the locale's button labels, are
 * suppressed outright in some embeds, and cannot be driven in a test. These
 * keep the call-site shape (`if (!(await confirmDialog(...))) return;`) but
 * render a themed, focus-trapped Radix dialog: `alertdialog` for a
 * confirmation, a labelled text field for a prompt.
 *
 * Same shape as `toast`: a module-level queue that any code can push to, and
 * one `<DialogHost />` (mounted once per app root in `App.tsx`) that shows the
 * head of the queue. Requests made while one is open wait their turn.
 */

import * as React from 'react';
import { Button } from './button';
import { Input } from './input';
import { Label } from './label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { useTranslation } from '@/i18n';

export interface ConfirmDialogOptions {
  /** The question, e.g. "Clear all measurements?". */
  title: string;
  /** Optional consequence spelled out below the question. */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (delete, clear, uninstall). */
  destructive?: boolean;
}

export interface PromptDialogOptions {
  title: string;
  /** Accessible label of the text field; defaults to the title. */
  label?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

type Request =
  | { id: number; kind: 'confirm'; options: ConfirmDialogOptions; resolve: (value: boolean) => void }
  | { id: number; kind: 'prompt'; options: PromptDialogOptions; resolve: (value: string | null) => void };

let nextId = 0;
let queue: Request[] = [];
let mountedHosts = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function enqueue(request: Request) {
  queue = [...queue, request];
  notify();
}

function settle(id: number, value: boolean | string | null) {
  const request = queue.find((r) => r.id === id);
  if (!request) return;
  queue = queue.filter((r) => r.id !== id);
  if (request.kind === 'confirm') request.resolve(value === true);
  else request.resolve(typeof value === 'string' ? value : null);
  notify();
}

/** Ask a yes/no question. Resolves `true` only on an explicit confirm; Esc,
 *  the close button or clicking outside resolve `false`. */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (mountedHosts === 0) {
    // A dialog nobody can see would hang its caller forever; refuse loudly.
    console.error('[confirmDialog] no <DialogHost /> is mounted; treating as cancelled:', options.title);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => enqueue({ id: nextId++, kind: 'confirm', options, resolve }));
}

/** Ask for a line of text. Resolves the entered text (untrimmed), or `null`
 *  when cancelled. */
export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  if (mountedHosts === 0) {
    console.error('[promptDialog] no <DialogHost /> is mounted; treating as cancelled:', options.title);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => enqueue({ id: nextId++, kind: 'prompt', options, resolve }));
}

function useHeadRequest(): Request | null {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    mountedHosts += 1;
    const listener = () => setTick((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      mountedHosts -= 1;
    };
  }, []);
  return queue[0] ?? null;
}

function PromptForm({ request, cancelLabel, onCancel }: {
  request: Extract<Request, { kind: 'prompt' }>;
  cancelLabel: string;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = React.useState(request.options.defaultValue ?? '');
  const fieldId = React.useId();
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        settle(request.id, value);
      }}
    >
      <DialogHeader>
        <DialogTitle>{request.options.title}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor={fieldId} className="sr-only">{request.options.label ?? request.options.title}</Label>
        {/* No autoFocus: Radix moves focus to this first field on open. */}
        <Input id={fieldId} value={value} onChange={(event) => setValue(event.target.value)} />
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
        <Button type="submit">{request.options.confirmLabel ?? t('dialogs.ok')}</Button>
      </DialogFooter>
    </form>
  );
}

/** Renders the pending confirm/prompt dialogs. Mount exactly once per root. */
export function DialogHost() {
  const { t } = useTranslation();
  const request = useHeadRequest();
  if (!request) return null;
  const cancel = () => settle(request.id, request.kind === 'confirm' ? false : null);
  const cancelLabel = request.options.cancelLabel ?? t('dialogs.cancel');

  return (
    <Dialog key={request.id} open onOpenChange={(open) => { if (!open) cancel(); }}>
      {request.kind === 'confirm' ? (
        <DialogContent role="alertdialog" className="max-w-md" hideCloseButton data-dialog-host="">
          <DialogHeader>
            <DialogTitle>{request.options.title}</DialogTitle>
            {request.options.description && <DialogDescription>{request.options.description}</DialogDescription>}
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={cancel}>{cancelLabel}</Button>
            <Button
              variant={request.options.destructive ? 'destructive' : 'default'}
              onClick={() => settle(request.id, true)}
            >
              {request.options.confirmLabel ?? t('dialogs.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : (
        <DialogContent className="max-w-md" hideCloseButton aria-describedby={undefined} data-dialog-host="">
          <PromptForm request={request} cancelLabel={cancelLabel} onCancel={cancel} />
        </DialogContent>
      )}
    </Dialog>
  );
}
