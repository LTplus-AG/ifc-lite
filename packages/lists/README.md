# @ifc-lite/lists

Configurable property tables and schedules from IFC data. Define a list once (entity types, Rules filter groups, columns, grouping) and execute it against model data to get typed rows, group summaries, and CSV output. The viewer evaluates Rules filters before the provider-only Lists engine builds rows.

## Install

```bash
npm install @ifc-lite/lists
```

## Usage

```ts
import { executeList, listResultToCSV, LIST_PRESETS } from '@ifc-lite/lists';
import type { ListDataProvider } from '@ifc-lite/lists';

// Bridge your data source (IfcDataStore, a server API, IndexedDB, ...)
// to the engine by implementing ListDataProvider.
declare const provider: ListDataProvider;

// LIST_PRESETS includes ready-made schedules (for example a Wall Schedule)
const result = executeList(LIST_PRESETS[0], provider);
console.log(result.rows);

const csv = listResultToCSV(result);
```

## Features

- `ListDefinition`: entity types, Rules `FilterGroup[]`, columns, grouping, or an explicit express-ID scope per model
- Column sources: entity attributes, property sets, quantity sets, materials, classifications, spatial containers (storey, building, site, project), and source model
- Viewer filtering uses `@ifc-lite/rules` for `groups`. The provider-only `executeList` projects an already-filtered source set and rejects nonempty Rules filters, so callers cannot silently skip them.
- `migrateLegacyListDefinition` converts v1 JSON to `groups` and explicit `unreadableConditions`; `legacyConditions` is available only when the provider-only engine must evaluate a v1 predicate without a Rules equivalent.
- Grouping with per-group summaries (`summariseListRows`)
- `discoverColumns` finds available columns from the actual model data
- CSV export with formula-injection guarding (`listResultToCSV`)
- `LIST_PRESETS` with common schedules

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
