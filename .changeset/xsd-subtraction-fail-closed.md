---
"@ifc-lite/ids": minor
---

`xs:pattern` facets now evaluate XSD character-class subtraction (`[a-z-[aeiou]]`) exactly (#5183). The matcher used to approximate the construct as its positive class, so `[a-z-[aeiou]]` became `[a-z]` and a consonants-only pattern accepted `"aeiou"`, which is exactly the value it was written to exclude. Subtraction is now translated to a negative lookahead, `(?:(?![aeiou])[a-z])`. That form matches the same single characters, nests (`[a-z-[b-y-[c]]]`), and translates XSD escapes on either side. A subtraction that cannot be delimited, such as an unterminated one, is refused, so its specification fails with an error that names the construct. The document auditor no longer warns `W_REGEX_UNVERIFIED` for a well-formed subtraction, because the runtime now evaluates it faithfully.

This changes validation outcomes for IDS files that use subtraction patterns: values the pattern excludes now fail where they used to pass. Patterns without subtraction are unaffected.
