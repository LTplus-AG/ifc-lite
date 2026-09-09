/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const order = new WeakMap<object, number>();
let sequence = 0;

/** Stamped at the shared store boundary, once per committed operation. Undo
 * and redo retain the command object and therefore its original position. */
export function recordOperation(command: object): void {
  if (!order.has(command)) order.set(command, ++sequence);
}

export function compareOperations(a: { timestamp: number }, b: { timestamp: number }): number {
  const first = order.get(a), second = order.get(b);
  return first !== undefined && second !== undefined ? first - second : a.timestamp - b.timestamp;
}
