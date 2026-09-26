/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare panel's "Key on" control (issue #4989): key the comparison on
 * an authored `Tag` or `Pset.Property` instead of GlobalId, for a from-scratch
 * re-export that re-GUIDs everything but keeps the project's own identifiers.
 * Extracted from `CompareRunControls` for the module-size house rule.
 *
 * Local text state, not a direct mirror of the store value: the input must
 * stay usable while the user is mid-edit (an incomplete `Pset_Asset.` reads
 * as invalid on every keystroke), and an invalid spec must never overwrite
 * the last-applied store value. Only a spec `parseAuthoredKeySpec` accepts —
 * or an empty string, meaning GlobalId — is ever written back.
 *
 * COMMIT TIMING (review, #4989): `onKeyProperty` reaches the store, and
 * `keyProperty` is part of `useCompare`'s fingerprint-cache key — the NEXT
 * "Run comparison" click re-extracts both models under the new scheme
 * (`useCompare.ts` does not depend on it, so a store change alone does not
 * re-run anything). Committing on every valid keystroke still cost a wasted
 * store write and cache invalidation on each one: typing `Pset_Asset.AssetId`
 * (valid from `Pset_Asset.A` on) committed ~8 times for one entry. So this
 * commits only on blur, Enter, or the text becoming empty (clearing is its
 * own decision, not something to wait on) — never merely because the
 * in-progress text happens to parse. The inline validity note stays live on
 * every keystroke; only the store write is deferred.
 */

import { useEffect, useRef, useState } from 'react';
import { parseAuthoredKeySpec } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n/useTranslation';
import type { DuplicateAuthoredKeyInfo } from '@/lib/compare/authoredKeys';

interface CompareKeyPropertyProps {
  /** The applied store value (`undefined` = GlobalId). */
  keyProperty: string | undefined;
  onKeyProperty: (keyProperty: string | undefined) => void;
  /** First few authored values more than one element carried this run, or
   *  `null`. Translated into text here, not upstream — see
   *  `duplicateAuthoredKeyInfo`'s doc comment. */
  duplicateInfo: DuplicateAuthoredKeyInfo | null;
  /** A run snapshots this scheme for extraction; do not let it change until
   * that run has either published or retired. */
  disabled?: boolean;
}

export function CompareKeyProperty({ keyProperty, onKeyProperty, duplicateInfo, disabled = false }: CompareKeyPropertyProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(keyProperty ?? '');
  // What WE last committed to the store, so an external change (session
  // reset, clearing decisions) is told apart from our own valid commit and
  // resyncs the input; our own commit must not re-trigger this effect and
  // stomp a keystroke the user has since made.
  const appliedRef = useRef(keyProperty);
  useEffect(() => {
    if (keyProperty !== appliedRef.current) {
      appliedRef.current = keyProperty;
      setText(keyProperty ?? '');
    }
  }, [keyProperty]);

  const trimmed = text.trim();
  const invalid = trimmed !== '' && !parseAuthoredKeySpec(trimmed);

  /** Apply `raw` to the store if — and only if — it is a valid spec or
   *  empty (GlobalId). An invalid spec commits nothing; the note below says
   *  why, against whatever scheme is still actually applied. */
  const commit = (raw: string) => {
    const value = raw.trim();
    if (value === '') {
      if (appliedRef.current === undefined) return;
      appliedRef.current = undefined;
      onKeyProperty(undefined);
      return;
    }
    const canonicalValue = value.toLowerCase() === 'tag' ? 'Tag' : value;
    if (canonicalValue === appliedRef.current) return; // no-op: already applied
    if (parseAuthoredKeySpec(canonicalValue)) {
      appliedRef.current = canonicalValue;
      onKeyProperty(canonicalValue);
    }
  };

  const handleChange = (raw: string) => {
    setText(raw);
    // Clearing the field is its own decision, not a partial edit — commit
    // it immediately rather than leaving the last scheme applied until
    // blur. Every OTHER keystroke only updates the live validity note.
    if (raw.trim() === '') commit(raw);
  };

  return (
    <div className="space-y-1">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-text select-none">
        <span className="shrink-0">{t('compareKeyProperty.label')}</span>
        <input
          type="text"
          disabled={disabled}
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
          }}
          placeholder={t('compareKeyProperty.placeholder')}
          className="flex-1 rounded border border-border bg-transparent px-2 py-1 text-foreground min-w-0"
        />
      </label>
      {invalid && (
        <p className="text-2xs text-[#e0af68]">
          {t('compareKeyProperty.invalidNote', { scheme: keyProperty ?? t('compareKeyProperty.globalId') })}
        </p>
      )}
      {!invalid && duplicateInfo && (
        <p className="text-2xs text-[#e0af68]">
          {t('compareKeyProperty.duplicateNote', {
            count: duplicateInfo.count,
            values: duplicateInfo.shown.join(', ') + (duplicateInfo.truncated ? ', …' : ''),
          })}
        </p>
      )}
    </div>
  );
}
