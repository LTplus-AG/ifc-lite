# @ifc-lite/bcf

BCF (BIM Collaboration Format) support for IFClite. Reads and writes BCF 2.1 and 3.0 files — the issue-tracking format every BIM tool speaks (Revit, Archicad, Solibri, BIMcollab, etc.).

## Installation

```bash
npm install @ifc-lite/bcf
```

## Read a BCF file

```typescript
import { readBCF } from '@ifc-lite/bcf';

const buffer = await fetch('coordination.bcf').then(r => r.arrayBuffer());
const project = await readBCF(buffer);

console.log(`${project.topics.length} topics, version ${project.version}`);

for (const topic of project.topics) {
  console.log(`[${topic.priority}] ${topic.title}`);
  console.log(`  by ${topic.author}, status: ${topic.status}`);
  console.log(`  ${topic.comments.length} comments, ${topic.viewpoints.length} viewpoints`);
}
```

## Create a BCF file

```typescript
import { createBCFProject, createBCFTopic, addTopicToProject, writeBCF } from '@ifc-lite/bcf';

const project = createBCFProject({
  name: 'Coordination Pass — Round 3',
  version: '3.0',
});

const topic = createBCFTopic({
  title: 'Missing fire rating on east-facade walls',
  author: 'reviewer@example.com',
  priority: 'High',
  status: 'Open',
  topicType: 'Issue',
  description: 'Walls on grid F1–F6 have no Pset_WallCommon.FireRating set.',
});

addTopicToProject(project, topic);

const blob = await writeBCF(project);
const url = URL.createObjectURL(blob);
// download the .bcf file
```

## Add a viewpoint with selection

```typescript
import { createViewpoint, addViewpointToTopic } from '@ifc-lite/bcf';

const viewpoint = createViewpoint({
  camera: {
    position: { x: 50, y: 30, z: 12 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    fov: 60,
  },
  // Highlight specific entities by their IFC GlobalId
  selection: ['1abc2def3GhI4jKlM5nOpQ', '2bcd3efg4HiJ5kLmN6oPqR'],
  // Hide unrelated context
  visibility: { defaultVisibility: false, exceptions: ['1abc2def3GhI4jKlM5nOpQ'] },
});

addViewpointToTopic(topic, viewpoint);
```

## GlobalId ↔ UUID conversion

BCF identifies elements by IFC GlobalId (22-char base64). The package ships utilities for round-tripping with binary UUIDs:

```typescript
import { ifcGuidToUuid, uuidToIfcGuid } from '@ifc-lite/bcf';

const uuid = ifcGuidToUuid('1abc2def3GhI4jKlM5nOpQ');
// → 'bd6f5b13-4c9d-4...'

const back = uuidToIfcGuid(uuid);
// → '1abc2def3GhI4jKlM5nOpQ'
```

## API

See the [BCF Guide](https://louistrue.github.io/ifc-lite/guide/bcf/) and [API Reference](https://louistrue.github.io/ifc-lite/api/typescript/#ifc-litebcf).

## License

[MPL-2.0](../../LICENSE)
