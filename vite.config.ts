import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true },
  // The service's CORS allows only :5173; a silent hop to :5174 would show up
  // as blocked requests with no hint why, so refuse to start instead.
  server: { port: 5173, strictPort: true },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Vitest swaps every .css module for an empty string unless it matches
    // here. The skin tests read the CSS files as raw text (?raw) to check the
    // token contract, so let exactly those imports through.
    css: { include: [/\.css\?raw/] },
  },
});
