// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  // Fully client-side app: no server, no adapter. Deploys as static files.
  output: 'static',
  build: {
    // VexFlow 5 ships the Bravura music font inline as base64, which is large.
    inlineStylesheets: 'never',
  },
  vite: {
    worker: {
      format: 'es',
    },
  },
});
