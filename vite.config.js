import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Tailwind v4 via its first-party Vite plugin (auto-detects source files,
// including the prototype under reference/ and the working copy under src/).
//
// No server code: tracing calls Anthropic straight from the browser with the
// user's own key (src/vision.js), so there are no secrets to load here.
// Share cards need an absolute image URL. Netlify sets URL during its build; locally it's
// empty and the image path stays relative. Keeps the live address out of the repo.
const siteUrl = (process.env.URL || "").replace(/\/$/, "");
const siteUrlInHtml = { name: "site-url-in-html", transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", siteUrl) };

export default defineConfig({
  plugins: [
    siteUrlInHtml,
    react(),
    tailwindcss(),
    // Installable PWA: add-to-home-screen with an icon + name. Service worker
    // precaches the app shell (auto-updates); calls to Anthropic always hit the network.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "Blueprint Walker",
        short_name: "Blueprint Walker",
        description: "Turn a floor plan into a space you can walk through.",
        theme_color: "#0c0a1f",
        background_color: "#0c0a1f",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
});
