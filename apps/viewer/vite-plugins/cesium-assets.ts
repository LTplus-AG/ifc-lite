import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

// CesiumJS loads its prebuilt Workers / Assets / Widgets / ThirdParty at runtime
// from CESIUM_BASE_URL (= '/cesium', set in vite.config's `define`), so they must
// sit at  <outDir>/cesium/<Subdir>/…  and be served at  /cesium/<Subdir>/…  in dev.
//
// We copy them ourselves rather than via vite-plugin-static-copy: in its v4 line
// the plugin rebuilds each destination from the file's path *relative to the Vite
// root*, so an absolute node_modules source lands every file under
//   <outDir>/cesium/node_modules/.pnpm/cesium@<v>/node_modules/cesium/Build/Cesium/…
// instead of <outDir>/cesium/…  → every /cesium/Assets|Workers/… request 404'd in
// production and the Cesium globe never rendered (#1139). Its stripBase escape
// hatch is static and would flatten Cesium's nested Assets/Textures tree. A plain
// recursive copy is deterministic and package-manager-agnostic.
const CESIUM_SUBDIRS = ['Workers', 'ThirdParty', 'Assets', 'Widgets'] as const;

const CESIUM_DEV_MIME: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.xml': 'application/xml',
};

export function cesiumStaticAssets(): Plugin {
  const cesiumBuild = path.join(
    path.dirname(require.resolve('cesium/package.json')),
    'Build',
    'Cesium',
  );
  // Fail loud at config time if the prebuilt assets aren't where we expect —
  // a silent miss here is exactly how #1139 shipped a broken map.
  for (const sub of CESIUM_SUBDIRS) {
    if (!fs.existsSync(path.join(cesiumBuild, sub))) {
      throw new Error(`[cesium-assets] missing ${sub} under ${cesiumBuild}`);
    }
  }

  let resolvedOutDir = 'dist';
  return {
    name: 'ifc-lite:cesium-static-assets',
    configResolved(config) {
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    // Build: recursive-copy the subdirs flat under <outDir>/cesium.
    async closeBundle() {
      const dest = path.join(resolvedOutDir, 'cesium');
      await Promise.all(
        CESIUM_SUBDIRS.map((sub) =>
          fs.promises.cp(path.join(cesiumBuild, sub), path.join(dest, sub), {
            recursive: true,
          }),
        ),
      );
    },
    // Dev: serve /cesium/* straight from the Cesium package (connect strips the
    // '/cesium' mount prefix, so req.url is already the in-package path).
    configureServer(server) {
      server.middlewares.use('/cesium', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const filePath = path.normalize(path.join(cesiumBuild, rel));
        // Contain to the build dir — compare on a path-separator boundary so a
        // sibling like `…/Cesium-backup` can't satisfy a bare prefix match.
        const insideBuild =
          filePath === cesiumBuild || filePath.startsWith(cesiumBuild + path.sep);
        if (!insideBuild || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          return next();
        }
        res.setHeader(
          'Content-Type',
          CESIUM_DEV_MIME[path.extname(filePath).toLowerCase()] ??
            'application/octet-stream',
        );
        if (req.method === 'HEAD') return res.end();
        // Guard the TOCTOU window between existsSync and the stream open: an
        // unhandled 'error' would otherwise crash the dev server.
        fs.createReadStream(filePath)
          .on('error', () => {
            if (!res.headersSent) res.writeHead(500);
            res.end();
          })
          .pipe(res);
      });
    },
  };
}
