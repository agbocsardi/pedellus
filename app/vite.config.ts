import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// The gateway serves the built dist/ from a configured absolute directory on
// the same origin as /v1, so all requests here are same-origin and relative.
const proxy = {
  "/v1": { target: "http://127.0.0.1:8791", ws: true },
};

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      manifest: {
        name: "Durable",
        short_name: "Durable",
        description: "Chat channel of the Durable agent gateway",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f7f6f3",
        theme_color: "#0e7a6a",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
    }),
  ],
  // The protocol module lives outside app/ (repository root); allow the dev
  // server to serve from there.
  server: { fs: { allow: [".."] }, proxy },
  preview: { proxy },
});
