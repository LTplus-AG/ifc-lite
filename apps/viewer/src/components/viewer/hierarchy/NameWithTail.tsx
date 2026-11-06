/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils';

/** Names longer than this keep their ending visible: siblings like
 *  "house - outer wall - house left/right" differ only at the end (#8802). */
const MIDDLE_ELLIPSIS_MIN_CHARS = 24;
const TAIL_WINDOW_CHARS = 14;
const TAIL_SEPARATORS = [' - ', ':', ' ', '_', '-'];

/** Split a long name into a head that truncates and a tail that stays. The
 *  two parts concatenate back to the exact name. */
export function splitNameForMiddleEllipsis(name: string): [string, string] {
  if (name.length < MIDDLE_ELLIPSIS_MIN_CHARS) return [name, ''];
  const windowStart = name.length - TAIL_WINDOW_CHARS;
  for (const separator of TAIL_SEPARATORS) {
    const at = name.lastIndexOf(separator);
    if (at >= windowStart && at + separator.length < name.length - 1) {
      const head = name.slice(0, at + separator.length).trimEnd();
      return [head, name.slice(head.length)];
    }
  }
  const head = name.slice(0, name.length - 8);
  return [head, name.slice(head.length)];
}

export function NameWithTail({ name, className }: { name: string; className?: string }) {
  const [head, tail] = splitNameForMiddleEllipsis(name);
  if (!tail) return <span className={cn('min-w-0 truncate', className)}>{name}</span>;
  return (
    <span className={cn('flex min-w-0', className)}>
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0 whitespace-pre">{tail}</span>
    </span>
  );
}
