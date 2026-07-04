---
"@ifc-lite/lists": minor
---

Add federation-identity list columns: a `model` source (source file / model name) and a leveled `spatial` source whose `propertyName` selects `Storey` (default), `Building`, `Site`, or `Project`. Lets a list over several federated models be grouped, sorted, filtered, and exported by which project/site/building/file each row comes from (issue #1591). `ListDataProvider` gains optional `getModelName` / `getProjectName` / `getSiteName` / `getBuildingName` accessors; existing storey-only `spatial` columns keep resolving the storey name.
