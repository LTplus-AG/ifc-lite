/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { Input } from './input';
import { Label } from './label';
import { useTranslation } from '@/i18n';

interface BaseRequest {
  title?: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
}

export interface ConfirmOptions extends BaseRequest {}
export interface PromptOptions extends BaseRequest {
  defaultValue?: string;
}

type DialogRequest =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void; opener: HTMLElement | null }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void; opener: HTMLElement | null };

let enqueue: ((request: DialogRequest) => void) | null = null;

/** Ask for consent without blocking the browser's event loop. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!enqueue) { resolve(false); return; }
    enqueue({ kind: 'confirm', options, resolve, opener: document.activeElement as HTMLElement | null });
  });
}

/** Ask for one string. Cancelling or pressing Esc resolves to null. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!enqueue) { resolve(null); return; }
    enqueue({ kind: 'prompt', options, resolve, opener: document.activeElement as HTMLElement | null });
  });
}

/** The single mounted host serializes requests from every viewer surface. */
export function ConfirmDialogHost() {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<DialogRequest[]>([]);
  const [value, setValue] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<DialogRequest[]>([]);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const current = requests[0];

  useEffect(() => {
    enqueue = (request) => {
      pendingRef.current.push(request);
      setRequests([...pendingRef.current]);
    };
    return () => {
      enqueue = null;
      for (const request of pendingRef.current) {
        if (request.kind === 'confirm') request.resolve(false);
        else request.resolve(null);
      }
      pendingRef.current = [];
    };
  }, []);

  useEffect(() => {
    setValue(current?.kind === 'prompt' ? current.options.defaultValue ?? '' : '');
    if (current?.kind === 'prompt') inputRef.current?.focus();
    else if (current) cancelRef.current?.focus();
  }, [current]);

  const finish = (answer: boolean | string | null) => {
    if (!current) return;
    restoreFocusRef.current = current.opener;
    pendingRef.current = pendingRef.current.filter((request) => request !== current);
    setRequests([...pendingRef.current]);
    if (current.kind === 'confirm') current.resolve(answer === true);
    else current.resolve(typeof answer === 'string' ? answer : null);
  };

  const title = current?.options.title ?? t(current?.kind === 'prompt' ? 'viewerShell.dialog.promptTitle' : 'viewerShell.dialog.confirmTitle');
  const description = current?.options.description ?? '';
  return (
    <Dialog open={!!current} onOpenChange={(open) => { if (!open) finish(null); }}>
      <DialogContent
        role="alertdialog"
        hideCloseButton
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (current?.kind === 'prompt') inputRef.current?.focus();
          else cancelRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocusRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {current?.kind === 'prompt' && (
          <form id="viewer-prompt-form" onSubmit={(event: FormEvent) => { event.preventDefault(); finish(value); }}>
            <Label htmlFor="viewer-prompt-value">{t('viewerShell.dialog.promptValue')}</Label>
            <Input id="viewer-prompt-value" ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)} />
          </form>
        )}
        <DialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={() => finish(null)}>{t('viewerShell.dialog.cancel')}</Button>
          <Button
            variant={current?.options.destructive ? 'destructive' : 'default'}
            type={current?.kind === 'prompt' ? 'submit' : 'button'}
            form={current?.kind === 'prompt' ? 'viewer-prompt-form' : undefined}
            onClick={current?.kind === 'confirm' ? () => finish(true) : undefined}
          >
            {current?.options.confirmLabel ?? t('viewerShell.dialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
