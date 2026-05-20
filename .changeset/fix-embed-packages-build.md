---
"@ifc-lite/embed-protocol": patch
"@ifc-lite/embed-sdk": patch
---

Ship compiled JavaScript instead of raw TypeScript source.

Both packages previously published with `main`/`types`/`exports` pointing at
`./src/index.ts` and no build step, so the tarball contained only
`src/index.ts`. A plain `npm install` + `import` failed with
`Unknown file extension ".ts"` in Node, and the packages were fragile under
`tsc`, Jest, ts-node, and non-esbuild bundlers — despite `@ifc-lite/embed-sdk`
being intended for external embedding (Power BI, Superset, Grafana).

They now build with `tsc` to `dist/` and export `./dist/index.js` +
`./dist/index.d.ts`, matching every other publishable package in the repo.
