import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const port = Number(process.argv[3] ?? 5275);
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);

createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  response.setHeader('Cache-Control', 'no-store');
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const decoded = decodeURIComponent(url.pathname);
  const requested = path.resolve(root, `.${decoded}`);
  if (requested !== root && !requested.startsWith(root + path.sep)) {
    response.writeHead(403); response.end(); return;
  }
  let file = requested;
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    // Only extensionless viewer routes fall back to the SPA entry.
    if (path.extname(file)) { response.writeHead(404); response.end(); return; }
    file = path.join(root, 'index.html');
  }
  try {
    const data = await readFile(file);
    response.setHeader('Content-Type', mime.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream');
    response.writeHead(200);
    response.end(data);
  } catch (error) {
    response.writeHead(404);
    response.end(String(error));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Serving ${root} on http://127.0.0.1:${port}`);
});
