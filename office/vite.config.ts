/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 8080,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
