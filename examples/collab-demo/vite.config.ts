import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5174,
    host: '0.0.0.0',
  },
  resolve: {
    preserveSymlinks: true,
  },
});
