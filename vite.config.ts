import { execSync } from 'node:child_process';

import { defineConfig } from 'vite';

/** The short commit hash the bundle was built from, kept with every take. */
function buildVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(buildVersion()) },
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
