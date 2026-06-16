import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import netlify from "@netlify/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";

// Tailwind v4 via its first-party Vite plugin (auto-detects source files,
// including the prototype under reference/ and the working copy under src/).
//
// @netlify/vite-plugin emulates the Netlify platform inside the Vite dev server:
// it runs netlify/functions/* and honors netlify.toml redirects. This is what lets
// the browser POST to /.netlify/functions/extract-plan during local `npm run dev`,
// with the ANTHROPIC_API_KEY staying server-side and never reaching the bundle.
export default defineConfig(({ mode }) => {
  // Load the local .env (gitignored) and inject server-only secrets into process.env
  // so the Netlify function — which reads process.env.ANTHROPIC_API_KEY — sees them
  // during local dev. The "" prefix loads ALL keys, not just VITE_-prefixed ones, and
  // nothing here is exposed to the client bundle. In production there is no .env, so
  // these stay undefined here and the real values come from Netlify's dashboard.
  const env = loadEnv(mode, process.cwd(), "");
  for (const k of ["ANTHROPIC_API_KEY", "VISION_BACKEND", "OLLAMA_HOST", "OLLAMA_MODEL"]) {
    if (env[k]) process.env[k] = env[k];
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      netlify(),
      // Installable PWA: add-to-home-screen with an icon + name. Service worker
      // precaches the app shell (auto-updates); the vision POST always hits the network.
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["apple-touch-icon.png"],
        workbox: { navigateFallbackDenylist: [/^\/\.netlify\//] },
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
  };
});
