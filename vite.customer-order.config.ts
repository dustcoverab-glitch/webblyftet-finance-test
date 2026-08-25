import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    assetsDir: "customer-order-assets",
    rollupOptions: {
      input: {
        "customer-order": "customer-order.html"
      },
      output: {
        entryFileNames: "customer-order-assets/[name]-[hash].js",
        chunkFileNames: "customer-order-assets/[name]-[hash].js",
        assetFileNames: "customer-order-assets/[name]-[hash][extname]"
      }
    }
  }
});
