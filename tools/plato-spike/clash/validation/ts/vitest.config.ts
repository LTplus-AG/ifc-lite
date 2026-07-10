import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['real-test/**/*.test.ts'],
    environment: 'node',
  },
});
