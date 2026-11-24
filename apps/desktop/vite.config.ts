import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 1420,
    strictPort: Boolean(process.env.TAURI_ENV_PLATFORM),
    fs: {
      allow: [path.resolve(__dirname, "../..")],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("recharts")) return "vendor-recharts";
            if (id.includes("@xyflow/react") || id.includes("xyflow")) return "vendor-xyflow";
            if (id.includes("lucide-react")) return "vendor-lucide";
          }
        },
      },
    },
  },
});
