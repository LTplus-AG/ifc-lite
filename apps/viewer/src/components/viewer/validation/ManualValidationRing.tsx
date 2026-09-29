/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The manual-validation ring (#6401): one per group plus an overall one,
 * plain SVG with no chart library. The geometry and colours come from
 * `lib/validation/manual/ring.ts` so the print path draws the same ring.
 * The accessible name spells out every bucket, and the visible legend next
 * to the overall ring carries labels, so state is never colour alone.
 */

import { Check, CircleDashed, TriangleAlert, X } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { ManualCounts } from '@/lib/validation/manual/checklist-summary';
import { passPercent, RING_BUCKETS, RING_COLORS, ringSegments, type RingBucket } from '@/lib/validation/manual/ring';

interface ManualValidationRingProps {
  counts: ManualCounts;
  /** Whose ring this is ("Overall", a group name), for the accessible name. */
  name: string;
  size?: number;
}

export function ManualValidationRing({ counts, name, size = 40 }: ManualValidationRingProps) {
  const { t } = useTranslation();
  const stroke = size >= 64 ? 8 : 5;
  const radius = (size - stroke) / 2;
  const center = size / 2;
  const segments = ringSegments(counts, radius);
  const label = counts.total === 0
    ? t('manualValidation.ring.empty', { name })
    : t('manualValidation.ring.label', {
      name, pass: counts.pass, warning: counts.warning, fail: counts.fail, unanswered: counts.unanswered,
    });
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      // An inline SVG chart needs the image role; an HTML img cannot hold live vector segments.
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="img"
      aria-label={label}
      className="shrink-0"
    >
      <circle cx={center} cy={center} r={radius} fill="none" stroke={RING_COLORS.unanswered} strokeOpacity={0.25} strokeWidth={stroke} />
      <g transform={`rotate(-90 ${center} ${center})`}>
        {segments.map((seg) => (
          <circle
            key={seg.bucket}
            data-bucket={seg.bucket}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={RING_COLORS[seg.bucket]}
            strokeWidth={stroke}
            strokeDasharray={`${seg.length} ${circumference - seg.length}`}
            strokeDashoffset={-seg.offset}
          />
        ))}
      </g>
      {size >= 40 && (
        <text
          x={center}
          y={center}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-foreground"
          fontSize={size >= 64 ? 14 : 10}
          fontWeight={600}
          aria-hidden="true"
        >
          {`${passPercent(counts)}%`}
        </text>
      )}
    </svg>
  );
}

const BUCKET_LABEL: Record<RingBucket, TranslationKey> = {
  pass: 'manualValidation.verdict.pass',
  warning: 'manualValidation.verdict.warning',
  fail: 'manualValidation.verdict.fail',
  unanswered: 'manualValidation.verdict.unanswered',
};

export function VerdictIcon({ bucket, className }: { bucket: RingBucket; className?: string }) {
  const style = { color: RING_COLORS[bucket] };
  const Icon = bucket === 'pass' ? Check : bucket === 'fail' ? X : bucket === 'warning' ? TriangleAlert : CircleDashed;
  return <Icon className={className ?? 'h-3.5 w-3.5'} style={style} aria-hidden="true" />;
}

/** Icon + label + count per bucket, in the ring's segment order. */
export function ManualValidationLegend({ counts }: { counts: ManualCounts }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {RING_BUCKETS.map((bucket) => (
        <li key={bucket} className="flex items-center gap-1.5" data-bucket={bucket}>
          <VerdictIcon bucket={bucket} />
          <span className="text-muted-foreground">{t(BUCKET_LABEL[bucket])}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums">{counts[bucket]}</span>
        </li>
      ))}
    </ul>
  );
}
