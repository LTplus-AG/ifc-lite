---
"@ifc-lite/export": patch
---

Split `step-serialization.ts` (678 lines, past the ~400-line module guideline) into three modules along the seams the file already had. No behaviour change: every moved function is byte-identical to what it was, and no import path outside `packages/export/src` changes — none of the moved symbols is re-exported from the package entry point, so `@ifc-lite/export`'s published surface is unchanged.

- `step-argument-parser.ts` (221) takes the STEP argument parser and rewriter: `splitTopLevelArgs`, `replaceStepArgument`, `splitTopLevelStepArguments`. These are the one text layer in the export path that runs the other way — they read a record's slots back OUT of a line and write one back by index, where everything left behind turns a value INTO a token. They share one set of rules (quote state, doubled-quote escapes, paren depth, what counts as a slot), and those rules are what someone has to be able to find when a rewritten line comes out wrong. Both hardened functions from the malformed-input work now sit next to each other rather than 100 lines apart with an unrelated splitter and the file assembler in between.
- `step-file-assembly.ts` (111) takes `assembleStepBytes` / `assembleStepBlob`, which do not serialize anything: they join a finished header and finished entity lines into the delivered artifact, and their contract is that the two stay byte-identical to each other.
- `step-serialization.ts` (389) keeps exactly what its own docblock claims — pure value-to-token serialization.

The test file split the same way (`step-argument-parser.test.ts`, `step-file-assembly.test.ts`), each block moving with the code it pins. Test count is unchanged at 648 passing / 30 skipped; five guard mutations from the moved code (the negative-depth rejection, the unterminated-string rejection, the `replaceStepArgument` slot validation, the `splitTopLevelArgs` comma trim, and the `assembleStepBytes` newline accounting) each kill exactly the same set of tests before and after the move.
