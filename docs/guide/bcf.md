# BCF Collaboration

IFClite supports **BCF (BIM Collaboration Format)**, the buildingSMART standard for issue tracking in BIM projects. The `@ifc-lite/bcf` package implements BCF 2.1 and 3.0 specifications.

## What is BCF?

BCF allows teams to create, share, and manage issues (called **topics**) linked to specific locations and components in a BIM model. Each topic can include:

- **Viewpoints** - Camera positions and component visibility snapshots
- **Comments** - Discussion threads on the issue
- **Component references** - Links to specific IFC entities via GlobalId

## Quick Start

### Reading BCF Files

```typescript
import { readBCF } from '@ifc-lite/bcf';

// Read a .bcf or .bcfzip file
const project = await readBCF(bcfBuffer);

console.log(`Project: ${project.name}`);
console.log(`Topics: ${project.topics.size}`);

for (const [guid, topic] of project.topics) {
  console.log(`  ${topic.title} [${topic.topicStatus}]`);
  console.log(`    Comments: ${topic.comments.length}`);
  console.log(`    Viewpoints: ${topic.viewpoints.length}`);
}
```

### Creating BCF Projects

```typescript
import {
  createBCFProject,
  createBCFTopic,
  createBCFComment,
  addTopicToProject,
  addCommentToTopic,
  writeBCF,
} from '@ifc-lite/bcf';

// Create a new project
const project = createBCFProject({ name: 'My BIM Review', version: '2.1' });

// Create a topic (issue)
const topic = createBCFTopic({
  title: 'Missing fire rating on wall W-042',
  description: 'Wall W-042 in corridor B3 requires 2-hour fire rating',
  author: 'reviewer@example.com',
  topicType: 'Issue',
  topicStatus: 'Open',
  priority: 'High',
  labels: ['fire-safety', 'corridor-B3'],
});

// Add a comment
const comment = createBCFComment({
  author: 'reviewer@example.com',
  comment: 'Please update the fire rating property in the model.',
});
addCommentToTopic(topic, comment);

// Add to project
addTopicToProject(project, topic);

// Export as a .bcfzip archive (returns a Blob)
const bcfBlob = await writeBCF(project);
```

## Viewpoints

Viewpoints capture the camera state and component visibility at the time an issue is created. IFClite provides utilities to convert between viewer camera state and BCF viewpoint format.

### Creating Viewpoints

```typescript
import { createViewpoint } from '@ifc-lite/bcf';

// Create a viewpoint from current viewer state
const viewpoint = createViewpoint({
  camera: currentCameraState,   // { position, target, up, fov, isOrthographic?, orthoScale? }
  selectedGuids: selectedGuids, // IFC GlobalIds of selected entities
  hiddenGuids: hiddenGuids,     // IFC GlobalIds of hidden entities
  visibleGuids: visibleGuids,   // IFC GlobalIds for isolation mode (optional)
  sectionPlane: activePlane,    // Single active clipping plane (optional)
  snapshot: base64Image,        // Screenshot as base64 (optional)
});
```

### Restoring Viewpoints

```typescript
import { extractViewpointState } from '@ifc-lite/bcf';

// Convert BCF viewpoint back to viewer state
const state = extractViewpointState(viewpoint);
// state.camera - { position, target, up, fov, isOrthographic?, orthoScale? }
// state.sectionPlane - clipping plane to apply (singular)
// state.selectedGuids - entities to highlight
// state.hiddenGuids - entities to hide
// state.visibleGuids - entities for isolation mode
// state.coloredGuids - entities with color overrides
```

## GUID Conversion

BCF uses UUID format while IFC uses a compressed 22-character GlobalId (base64). The package re-exports conversion utilities (from `@ifc-lite/encoding`):

```typescript
import { uuidToIfcGuid, ifcGuidToUuid, isValidIfcGuid } from '@ifc-lite/bcf';

const ifcGuid = uuidToIfcGuid('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
const uuid = ifcGuidToUuid('0YvctA6Hn0pgmBdv0cPwH6');

if (isValidIfcGuid(guid)) {
  // Valid 22-character IFC GlobalId
}
```

`generateIfcGuid`, `generateUuid`, and `isValidUuid` are also re-exported.

## IDS Validation Reports as BCF

Failed IDS validation results can be turned into a BCF project, one topic per failure group:

```typescript
import { createBCFFromIDSReport, writeBCF } from '@ifc-lite/bcf';

const project = createBCFFromIDSReport(reportInput, options);
const blob = await writeBCF(project);
```

The viewer's IDS panel uses this to export validation failures as BCF, with optional camera viewpoints and snapshots. See [IDS Validation](ids.md).

## Clash Results as BCF

The clash package (`@ifc-lite/clash/bcf`) exports clash detection results as a BCF 2.1 project, one topic per clash group:

```typescript
import { createBCFFromClashResult, mapBcfToClashes } from '@ifc-lite/clash/bcf';
import { clashReviewKey } from '@ifc-lite/clash';

const project = await createBCFFromClashResult(clashResult, groups, {
  author: 'clash@ifc-lite',
  projectName: 'Clash report',
  // Optional: map each clash to its review status ('open' | 'resolved' | 'accepted')
  reviewStatusOf: (clash) => myReviews.get(clashReviewKey(clash))?.status ?? 'open',
});
```

`clashReviewKey` (from `@ifc-lite/clash`) builds a durable, model-independent key from the rule id and the two element GUIDs, so a review re-attaches to the same clash after a re-run or model revision.

Clash review status (`open` / `resolved` / `accepted`, tracked with an optional comment in the viewer's clash panel) flows into the export: each topic's status is the least-resolved status among its member clashes, mapped to a BCF `TopicStatus` for maximum interoperability (`open` -> `Open`, `resolved` and `accepted` -> `Closed`). The finer open/resolved/accepted breakdown is preserved in the topic description. Topic GUIDs are deterministic per clash group, so topic identity is stable across re-exports, and `mapBcfToClashes` reads a BCF project back into a clash-id -> topic/status map for round-tripping.

## 3D Overlay Markers

For rendering BCF topics as markers in a 3D view, the package provides viewer-agnostic marker positioning plus a DOM renderer:

```typescript
import { computeMarkerPositions, BCFOverlayRenderer } from '@ifc-lite/bcf';
```

## BCF Servers (BCF API)

Beyond `.bcfzip` files, the `@ifc-lite/bcf-api` package connects to [buildingSMART BCF API](https://github.com/buildingSMART/BCF-API) (OpenCDE) servers and pulls their topics into the same `BCFProject` model:

```typescript
import {
  BcfApiClient,
  normalizeBcfBaseUrl,
  requestPasswordToken,
  fetchProjectAsBCF,
} from '@ifc-lite/bcf-api';

const baseUrl = normalizeBcfBaseUrl('https://example.com/bcf');

// Discover the token endpoint, then sign in with the OAuth2 password grant
const auth = await new BcfApiClient({ baseUrl }).getAuthInfo();
const token = await requestPasswordToken({
  tokenUrl: auth.oauth2_token_url!,
  username: 'you@example.com',
  password: 'secret',
});

const client = new BcfApiClient({ baseUrl, getAccessToken: () => token.access_token });
const projects = await client.getProjects();

// Topics, comments, viewpoints (cameras, selection, coloring, visibility)
// and snapshots, assembled into an @ifc-lite/bcf BCFProject
const { project, warnings } = await fetchProjectAsBCF(client, projects[0].project_id);
console.log(`Pulled ${project.topics.size} topics (${warnings.length} warnings)`);
```

The client implements the BCF API 2.1 routes (projects, extensions, topics with OData paging, comments, viewpoints, component subresources, snapshots). Non-authentication per-item failures — a missing snapshot, an unreadable components resource — degrade to `warnings` entries; authentication failures (401) and an unreachable topics collection reject the whole pull.

## Viewer Integration

In the IFClite viewer, BCF is integrated through the BCF panel:

1. **Load BCF** - Drag and drop a `.bcf` or `.bcfzip` file or use the BCF panel to import
2. **Connect to a BCF server** - The cloud button in the panel header connects to a BCF API server — pick a known server (Aconex regions, BIMcollab, BIMData.io, BIM Track/Newforma Konekt, Catenda Hub, Dalux Field, OpenProject, StreamBIM) or enter a custom URL, sign in via the browser OAuth popup (authorization code + PKCE, with dynamic client registration where the server offers it), email & password, a pasted access token, or OAuth client credentials — then list its projects and load topics, viewpoints, and snapshots straight into the panel
3. **Browse Topics** - View all issues with status, priority, and labels
4. **Navigate Viewpoints** - Click a viewpoint to restore camera and visibility
5. **Add Comments** - Discuss issues directly in the viewer
6. **Create Topics** - Select entities, position camera, and create new issues
7. **Export BCF** - Save the project as a `.bcfzip` file for sharing

## Key Types

| Type | Description |
|------|-------------|
| `BCFProject` | Top-level container with topics map and version |
| `BCFTopic` | An issue with title, status, comments, and viewpoints |
| `BCFComment` | A comment on a topic with author and timestamp |
| `BCFViewpoint` | Camera state, component visibility, and clipping planes |
| `BCFComponents` | Selected, visible, and colored component references |
| `BCFClippingPlane` | Section plane definition (location + direction) |
