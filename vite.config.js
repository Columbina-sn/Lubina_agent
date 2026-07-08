import { defineConfig } from "vite";

// https://vitejs.dev/config/
// Vite 仅用于开发服务器；生产环境下 Tauri 直接读取 src/ 目录
export default defineConfig({
  root: "src",
  publicDir: "static",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
