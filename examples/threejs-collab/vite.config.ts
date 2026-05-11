import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  server: {
    port: 5175,
    host: '0.0.0.0',
  },
  resolve: {
    preserveSymlinks: true,
    alias: {
      'y-webrtc': new URL('./stubs/y-webrtc.js', import.meta.url).pathname,
    },
  },
  optimizeDeps: {
    exclude: ['y-webrtc', '@automerge/automerge'],
  },
});
