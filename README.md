# Blueprint Walker

Take a photo of a floor plan, often hand-drawn on grid paper, and walk around it in 3D at real scale.

I built it for one non-technical person who sketches house plans on paper and wanted to see them as spaces. So it runs on a phone, uses plain language, and forgives mistakes.

## How it works

1. **Add a plan.** Use a photo, a blank grid ("Draw a new plan"), or the sample.
2. **Trace it.** Two options:
   - **Automatically, with your own Anthropic key.** Claude vision reads the photo and returns one compact JSON contract: walls, doors, windows, furniture, stairs, room labels and the drawing's scale. The prompt (`src/vision.js`) tells the model to ignore the graph-paper grid and to keep the building shell separate from furniture. It marks faint or guessed walls with a low confidence score instead of dropping or inventing them.
   - **By hand, for free.** Your photo sits under the grid and you draw the walls over it.
3. **Fix it up.** The plan opens in a 2D editor so you can fix what the model got wrong. Low-confidence walls are highlighted. You can snap endpoints, undo, delete and set the real size ("1 square = 1 ft").
4. **Walk it.** The plan becomes a first-person Three.js scene with collision, a minimap and twin-stick touch controls.

## Your key, your photo, your plans

- **Bring your own key.** Automatic tracing runs on *your* Anthropic account. A trace usually costs a cent or two. Make a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).
- **No server in the path.** The browser calls Anthropic's API directly with your key, using Anthropic's opt-in for browser calls, through the SDK's `dangerouslyAllowBrowser` option. Your photo and key go from your device to Anthropic and nowhere else.
- **The key stays on your device.** It's kept for this visit only. If you tick "Remember on this device", it's saved in this browser until you press "Forget key".
- **Plans stay in your browser.** Saved plans live in this browser's local storage. Nothing is stored on a server, because there isn't one.
- **Locked-down page.** A strict Content-Security-Policy (`netlify.toml`) lets the page load only its own files and connect only to itself and `api.anthropic.com`.

## Design choices

- **A strict JSON contract between model and renderer.** Stray formatting is stripped from the model's reply, and malformed entries are dropped before drawing.
- **Honest errors.** A failed trace says what actually happened: the key was refused, the account is out of credit, Claude is busy, you're offline, or no plan was found in the picture. Problems you can retry get a "Try again" button.
- **Human in the loop.** The model's output is a first draft. The editor exists because reading hand drawings is never perfect.
- **The SDK loads only when needed.** People who only draw never download it.

## Stack

React 18 · Vite · Three.js · Tailwind · Anthropic TypeScript SDK (in the browser) · Netlify (static hosting only)

## Run it locally

```bash
npm install
npm run dev
```

Then paste your own Anthropic API key into the app when you trace a photo. No `.env` is needed.

Built by Antoni (Tony) Jagodka with Claude Code. I planned it, reviewed every change and tested it on real hand-drawn plans.
