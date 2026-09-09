/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Retains occurrence records while a replacement owns their visible geometry. */
export interface InstanceLease {
  readonly expressId: number;
  readonly modelIndex: number;
  readonly valid: boolean;
  setSuppressed(value: boolean): void;
  release(): void;
}
interface Entry { suppressed: boolean; modelIndex: number }
export class InstanceSuppression {
  private entries = new Map<number, Entry>();
  constructor(private readonly changed: (id: number) => void) {}
  *suppressedIds(): IterableIterator<number> {
    for (const [id, entry] of this.entries) if (entry.suppressed) yield id;
  }
  get retained(): boolean { return this.entries.size > 0; }
  has(id: number): boolean { return this.entries.get(id)?.suppressed === true; }
  acquire(expressId: number, modelIndex: number): InstanceLease {
    if (this.entries.has(expressId)) throw new Error('An appearance operation already retains this occurrence');
    const entry: Entry = { suppressed: false, modelIndex };
    this.entries.set(expressId, entry);
    const valid = () => this.entries.get(expressId) === entry;
    return Object.freeze({
      expressId, modelIndex,
      get valid() { return valid(); },
      setSuppressed: (value: boolean) => {
        if (!valid()) throw new Error('The retained occurrence is stale');
        if (entry.suppressed === value) return;
        entry.suppressed = value;
        try { this.changed(expressId); }
        catch (error) { entry.suppressed = !value; this.changed(expressId); throw error; }
      },
      release: () => {
        if (!valid()) return;
        if (entry.suppressed) {
          entry.suppressed = false;
          try { this.changed(expressId); }
          catch (error) { entry.suppressed = true; this.changed(expressId); throw error; }
        }
        this.entries.delete(expressId);
      },
    });
  }
  restore(): void {
    const hidden = [...this.entries].filter(([, entry]) => entry.suppressed).map(([id]) => id);
    this.entries.clear();
    for (const id of hidden) this.changed(id);
  }
  forget(id?: number): void {
    if (id === undefined) this.entries.clear();
    else this.entries.delete(id);
  }
  forgetModel(modelIndex: number): void {
    for (const [id, entry] of this.entries) if (entry.modelIndex === modelIndex) this.entries.delete(id);
  }
}
