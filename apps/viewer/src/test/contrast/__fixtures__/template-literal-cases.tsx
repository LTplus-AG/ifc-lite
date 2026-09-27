/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Not a real component — fixture source for
 * `extract-classname.test.ts`'s template-literal cases. Kept as its own
 * `.tsx` file (rather than an inline string in the test) so the extractor
 * genuinely parses real TSX source text, the same way it parses a real
 * component.
 */

export function LiteralOnly() {
  return <span className={`text-2xs text-muted-foreground`}>literal-only</span>;
}

export function Interpolated({ primary }: { primary: boolean }) {
  return (
    <span className={`text-2xs ${primary ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>
      interpolated
    </span>
  );
}
