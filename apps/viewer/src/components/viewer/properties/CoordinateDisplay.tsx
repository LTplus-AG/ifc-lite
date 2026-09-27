/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinate display components for entity position information.
 */

import { CopyValueButton } from './CopyValueButton';

/** Inline coordinate value with dim axis label */
export function CoordVal({ axis, value }: { axis: string; value: number }) {
  return (
    <span className="whitespace-nowrap"><span className="opacity-50">{axis}</span>{'\u2009'}{value.toFixed(3)}</span>
  );
}

/** Copyable coordinate row: label + values with copy button hugging the values */
export function CoordRow({ label, values, primary, copyName }: {
  label: string;
  values: { axis: string; value: number }[];
  primary?: boolean;
  /** Names the copy button when the row has no visible label. */
  copyName?: string;
}) {
  const copyText = values.map(v => v.value.toFixed(3)).join(', ');
  return (
    <div className="flex items-start gap-1.5 group/copyrow min-w-0">
      {label && (
        <span className="text-2xs font-medium uppercase tracking-wider w-[34px] shrink-0 pt-px text-muted-foreground">
          {label}
        </span>
      )}
      <span className={`font-mono text-2xs min-w-0 tabular-nums leading-relaxed ${primary ? 'text-foreground' : 'text-muted-foreground'}`}>
        {values.map((v, i) => (
          <span key={v.axis}>{i > 0 && <>{' '}</>}<CoordVal axis={v.axis} value={v.value} /></span>
        ))}
      </span>
      <CopyValueButton name={copyName ?? label} value={copyText} />
    </div>
  );
}
