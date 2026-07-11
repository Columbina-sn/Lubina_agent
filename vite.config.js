import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  root: "src",
  publicDir: "static",
  resolve: {
    alias: {
      "/node_modules": path.resolve(__dirname, "node_modules"),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    fs: { allow: ["..", "../node_modules"] },
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
