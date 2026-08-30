import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, "../../dist/console-web"),
  },
  root: import.meta.dirname,
});
