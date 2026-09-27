/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read what a mounted `<Toaster/>` shows by recency, not DOM position.
 *
 * Toasts live in a module-level store, so an earlier test's toast can still be
 * on screen. And since #5603 the stack is not append-only: errors sit in their
 * own `alert` region, an identical message is merged into the toast already
 * shown, and the oldest is evicted past three. Each row's `data-toast-seq`
 * rises every time it is shown, so the highest is the newest.
 */

function toastRows(root: ParentNode): { seq: number; text: string }[] {
  return [...root.querySelectorAll<HTMLElement>('[data-toast-seq]')]
    .map((row) => ({ seq: Number(row.dataset.toastSeq), text: row.textContent ?? '' }))
    .sort((a, b) => a.seq - b.seq);
}

/** The most recently shown toast's text, or '' when none is on screen. */
export function latestToast(root: ParentNode = document.body): string {
  return toastRows(root).at(-1)?.text ?? '';
}

/** Text of every toast `action` showed (or merged into), oldest first. */
export function toastsFrom(root: ParentNode, action: () => void): string {
  const before = Math.max(-1, ...toastRows(root).map((row) => row.seq));
  action();
  return toastRows(root)
    .filter((row) => row.seq > before)
    .map((row) => row.text)
    .join('');
}
