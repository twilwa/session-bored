// ABOUTME: Builds the React application into assets served by the Cloudflare Worker.
// ABOUTME: Keeps browser code on the same origin as API and authentication routes.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
