# @ifc-lite/rules

The filter-rule vocabulary, the Path-B rule evaluator, and the `.rules.json` information-validation engine for IFC-Lite. This is the shared core behind the viewer's Advanced Filter / Data Validation panel and the `ifc-lite check` CLI command (#5138) — one evaluator, one `.rules.json` format, run identically in the browser and on the command line.

## Install

```bash
npm install @ifc-lite/rules
```

## Usage

```ts
import { Rule, evaluateFilterRules, parseRuleSetFile, runRuleSet } from '@ifc-lite/rules';
import type { IfcDataStore } from '@ifc-lite/parser';

declare const store: IfcDataStore;
declare const ruleSetJson: string; // the text of a saved `<name>.rules.json`

// Evaluate an ad-hoc filter against one model.
const matches = evaluateFilterRules('model-1', store, [Rule.ifcType(['IfcWall'])], 'AND');

// Parse and run a saved `.rules.json` rule set against every loaded model.
const parsed = parseRuleSetFile(JSON.parse(ruleSetJson));
if (parsed.ok) {
  const report = await runRuleSet({
    ruleSet: parsed.file,
    models: [{ id: 'model-1', store }],
  });
}
```

## Features

- `FilterRule` / `FilterGroup` vocabulary (`ifcType`, `name`, `property`, `quantity`, `material`, `classification`, `storey`, `model`, `modelTag`, `parent`, `group`, `elevation`, `type`, `predefinedType`, `attribute`, `globalId`) plus the `Rule` builder helpers.
- `evaluateFilterRules` / `evaluateFilterRulesFederated` (sync + async chunked, cancellable, multi-model) — the same Path-B evaluator the viewer's Advanced Filter and Data Validation panel use, with index prefiltering and cheap-first rule ordering for large models.
- `parseRuleSetFile` / `serializeRuleSet` — validate and round-trip a `<name>.rules.json` file (never throws; failures come back as `{ ok: false, error }`).
- `ruleSetToIds` — export the IDS-expressible rules of a rule set as IDS 1.0 XML. Each rule that has no exact IDS equivalent is refused with its reasons (see the [IDS guide](https://ifclite.dev/docs/guide/ids/#exporting-a-rule-set-as-ids)).
- `runRuleSet` / `resolveTargetModels` — the information-validation engine: resolve applicability, check cardinality, dispatch `element` / `unique` / `aggregate` / `compare` / `unit` requirements, and fold the result into a `@ifc-lite/ids`-shaped `ValidationReport`.

No React, no store, no DOM — every export takes plain data (`IfcDataStore`, `EvaluatorModel[]`) in and returns plain data out, so it runs the same in a browser tab and a Node CLI process.

## License

MPL-2.0
