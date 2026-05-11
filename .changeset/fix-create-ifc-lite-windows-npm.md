---
"create-ifc-lite": patch
---

Fix npm package version resolution when scaffolding projects on Windows.

`create-ifc-lite` resolves published `@ifc-lite/*` package versions by
calling `npm view` before writing the generated template's `package.json`.
On Windows, spawning `npm` directly from Node can fail with
`spawnSync npm ENOENT` because the executable is exposed through the
shell shim (`npm.cmd`) rather than as a directly spawnable binary in all
environments. The CLI then reports this as a registry access failure, even
though `npm view @ifc-lite/geometry version` works from the same terminal.

Run the npm query through `cmd.exe /c npm ...` on Windows so template
creation follows the same command resolution path as the user's shell,
while keeping the direct `npm` spawn path unchanged on other platforms.
