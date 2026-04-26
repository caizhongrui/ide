import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import pkg from "./package.json" with { type: "json" }

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // 不预打包 workspace SDK，确保 pnpm build 后能立即生效
  optimizeDeps: {
    exclude: ["@maxian/sdk"],
  },
  // 注入 build 时的 desktop 版本号，避免 App.tsx 里 hardcode 字面量
  // 唯一真相源 = apps/desktop/package.json#version
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
