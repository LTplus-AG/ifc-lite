/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinate display components for entity position information.
 */

import { Copy, Check } from 'lucide-react';

/** Inline coordinate value with dim axis label */
export function CoordVal({ axis, value }: { axis: string; value: number }) {
  return (
    <span className="whitespace-nowrap"><span className="opacity-50">{axis}</span>{'\u2009'}{value.toFixed(3)}</span>
  );
}

/** Copyable coordinate row: label + values with copy button hugging the values */
export function CoordRow({ label, values, primary, copyLabel, coordCopied, onCopy }: {
  label: string;
  values: { axis: string; value: number }[];
  primary?: boolean;
  copyLabel: string;
  coordCopied: string | null;
  onCopy: (label: string, text: string) => void;
}) {
  const isCopied = coordCopied === copyLabel;
  const copyText = values.map(v => v.value.toFixed(3)).join(', ');
  return (
    <div className="flex items-start gap-1.5 group min-w-0">
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
      <button
        className={`shrink-0 p-0.5 rounded mt-px transition-colors ${isCopied ? 'text-emerald-500' : 'text-muted-foreground/30 opacity-0 group-hover:opacity-100 hover:text-muted-foreground'}`}
        onClick={(e) => { e.stopPropagation(); onCopy(copyLabel, copyText); }}
      >
        {isCopied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
      </button>
    </div>
  );
}
