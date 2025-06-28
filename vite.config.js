import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  build: {
    target: 'esnext', // ensures support for top-level await and modern syntax
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext', // same for dependency pre-bundling
    },
    exclude: ['fsevents'], // avoids bundling native macOS-only modules
  },
  plugins: [svelte()] // <-- this is the correct place for the svelte plugin
});