/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RefCallback } from 'react';

interface GeoreferenceValueDisplayProps {
  label: string;
  value: string;
  suffix?: string;
  className: string;
  onEdit?: () => void;
  focusRef: RefCallback<HTMLElement>;
}

/** A separate native button keeps an inline action outside the editor trigger. */
export function GeoreferenceValueDisplay({ label, value, suffix, className, onEdit, focusRef }: GeoreferenceValueDisplayProps) {
  const content = <>{value}{suffix && <span className="text-zinc-400 dark:text-zinc-500 ml-0.5">{suffix}</span>}</>;
  if (onEdit) return (
    <button type="button" ref={focusRef} onClick={onEdit} aria-label={`${label}: ${value}`} title={value} className={className}>
      {content}
    </button>
  );
  return <span className={className} title={value}>{content}</span>;
}
