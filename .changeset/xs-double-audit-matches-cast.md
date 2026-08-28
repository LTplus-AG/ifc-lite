---
'@ifc-lite/ids': patch
---

The coherence audit and the strict cast now decide `xs:double` identically.

`isValidLexicalForXsType` vetoed any value containing no digit before its regex
ran, so it rejected `NaN`, `+INF` and `-INF` even though the regex one line above
accepts them. The same veto tested the WHOLE lexeme, so `e5` passed on the
strength of the exponent's digit while `literalCastsUnder` rejected it.

Two classes, two directions, one package:

    value          audit before   cast   audit now
    NaN/+INF/-INF  reject         accept accept
    e5/+e5/.e5     accept         reject reject
    ''/'+'/'.'/'-' reject         reject reject
    1.5            accept         accept accept

The digit is now required in the MANTISSA, and the three specials are exempt
rather than swept up by the same rule. The specials list is imported from
`constraints/xsd-cast.ts` rather than restated, so the two sites cannot drift
apart again by editing one of them.

Practical effect: an IDS document whose `xs:double` enumeration carries `NaN`,
`+INF` or `-INF` no longer reports `E_RESTRICTION_VALUE_MISMATCH`. Those are in
the xs:double lexical space and upstream `IDS-Audit-tool` accepts them. One whose
enumeration carries `e5` now does report it, which upstream does not — a
deliberate deviation shared with the cast, on the grounds that an exponent with
no mantissa is not a number.

Completes #3336; the cast half shipped in #3339.
