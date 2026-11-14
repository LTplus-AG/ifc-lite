/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Collects skip counts and one warning line per distinct condition. */
export class Report {
  readonly skipped: Record<string, number> = {};
  private readonly notes = new Map<string, { count: number; text: (count: number) => string }>();

  skip(reason: string, count = 1): void {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + count;
  }

  /** `key` names the condition; `text` renders it from how often it occurred. */
  warn(key: string, text: (count: number) => string): void {
    const note = this.notes.get(key);
    if (note) note.count++;
    else this.notes.set(key, { count: 1, text });
  }

  warnings(): string[] {
    return Array.from(this.notes.values(), note => note.text(note.count));
  }
}

export function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}
