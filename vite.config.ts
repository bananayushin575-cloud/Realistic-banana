import {defineConfig} from 'vite';

// Relative base path so the static bundle works on any GitHub Pages subpath
// (e.g. https://<username>.github.io/<repo-name>/) as well as root domains.
export default defineConfig({
  base: './',
});
