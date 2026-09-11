# @ifc-lite/regex-guard

Dependency-free validation for regular-expression patterns supplied by users or
model files. Shared by IFC pattern-validation and editing tools.

## Usage

```typescript
import { compileGuardedRegex } from '@ifc-lite/regex-guard';

const pattern = compileGuardedRegex('^Wall-[0-9]+$', 'i');
console.log(pattern.test('Wall-42')); // true
```

`compileGuardedRegex(pattern, flags?, { maxLength? }?)` validates the pattern
before constructing a JavaScript `RegExp`. Rejected patterns throw
`UnsafeRegexPatternError`, which exposes `pattern` and `reason`. A malformed
pattern that passes the guard can still throw the native `SyntaxError`.

Other exports:

- `assertGuardedRegexPattern(pattern, { maxLength? }?)`: validate without compiling.
- `hasCatastrophicBacktrackingShape(pattern)`: detect the nested-quantifier shapes
  covered by the heuristic.
- `MAX_GUARDED_REGEX_PATTERN_LENGTH`: the default limit of 256 characters.

## Limits

This is a heuristic, not a guarantee of bounded execution time. It rejects
known nested-quantifier patterns such as `(a+)+` and caps pattern length, but
it does not analyze every possible backtracking shape. It does not move matches
to a worker, enforce a match timeout, or replace JavaScript's regex engine.

## License

MPL-2.0.
