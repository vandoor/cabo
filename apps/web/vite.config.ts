import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const backend = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: { "/socket.io": { target: backend, ws: true }, "/health": backend },
  },
  build: { target: ["es2020", "safari14"], outDir: "dist" },
});
