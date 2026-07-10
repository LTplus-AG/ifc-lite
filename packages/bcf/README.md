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

console.log(`${project.topics.size} topics, version ${project.version}`);

for (const topic of project.topics.values()) {
  console.log(`[${topic.priority}] ${topic.title}`);
  console.log(`  by ${topic.creationAuthor}, status: ${topic.topicStatus}`);
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
  topicStatus: 'Open',
  topicType: 'Issue',
  description: 'Walls on grid F1-F6 have no Pset_WallCommon.FireRating set.',
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
    fov: Math.PI / 3, // field of view in radians (60 degrees)
  },
  // Highlight specific entities by their IFC GlobalId
  selectedGuids: ['1abc2def3GhI4jKlM5nOpQ', '2bcd3efg4HiJ5kLmN6oPqR'],
  // Isolate: show only these entities (isolation mode, defaultVisibility=false)
  visibleGuids: ['1abc2def3GhI4jKlM5nOpQ'],
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

## Also included

- `createBCFFromIDSReport` - turn an IDS validation report into a BCF file, one topic per failing spec
- `computeMarkerPositions` + `BCFOverlayRenderer` - viewer-agnostic 3D topic markers for any renderer
- Camera round-trip helpers (`cameraToPerspective`, `orthogonalToCamera`, ...) and section-plane conversion

## API

See the [BCF Guide](https://ifclite.dev/docs/guide/bcf/) and [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-litebcf).

## License

[MPL-2.0](../../LICENSE)
