# @ifc-lite/lists

Configurable property tables and schedules from IFC data. Define a list once (entity types, columns, filter conditions, grouping) and execute it against any model through a `ListDataProvider` interface to get typed rows, group summaries, and CSV output. This is the engine behind entity tables and schedules in the ifc-lite viewer.

## Install

```bash
npm install @ifc-lite/lists
```

## Usage

```ts
import { executeList, listResultToCSV, LIST_PRESETS } from '@ifc-lite/lists';
import type { ListDataProvider } from '@ifc-lite/lists';

const provider: ListDataProvider = createMyProvider(myData);

// LIST_PRESETS includes ready-made schedules (for example a Wall Schedule)
const result = executeList(LIST_PRESETS[0], provider);
console.log(result.rows);

const csv = listResultToCSV(result);
```

## Features

- `ListDefinition`: entity types, columns, property conditions, grouping, or an explicit express-ID scope per model
- Column sources: entity attributes, property sets, quantity sets, materials, classifications, spatial containers (storey, building, site, project), and source model
- Filtering with typed `PropertyCondition` operators, including Bonsai-style `/regex/` name patterns (`compileNameMatcher`, `isNamePattern`)
- Grouping with per-group summaries (`summariseListRows`)
- `discoverColumns` finds available columns from the actual model data
- CSV export with formula-injection guarding (`listResultToCSV`)
- `LIST_PRESETS` with common schedules

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
