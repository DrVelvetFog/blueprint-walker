# Blueprint Walker

Take a photo of a floor plan, often hand-drawn on grid paper, and walk around it in 3D at real scale.

I built it for one non-technical person who sketches house plans on paper and wanted to see them as spaces. So it runs on a phone, uses plain language and big tap targets, and forgives mistakes.

## How it works

1. **Upload a photo** of the plan.
2. **Claude vision extracts the plan** (`netlify/functions/extract-plan.mjs`). A serverless function sends the image to Claude and gets back one compact JSON contract: walls, doors, windows, furniture, stairs, room labels and the drawing's scale. The prompt tells the model to ignore the graph-paper grid and keep the building shell separate from furniture. It also marks faint or guessed walls with a low confidence score instead of dropping or inventing them.
3. **Correction editor.** The plan opens in a 2D editor so a person can fix what the model got wrong. Low-confidence walls are highlighted. You can snap endpoints, undo, delete and calibrate the scale ("1 square = 1 ft").
4. **Walk it.** The plan is extruded into a first-person Three.js scene with collision, a minimap and twin-stick touch controls.

Plans save locally in the browser. Nothing is stored on a server.

## Design choices

- **The API key never reaches the browser.** Only the serverless function calls Claude. The key lives in a Netlify environment variable.
- **Swappable vision backend.** Set `VISION_BACKEND=ollama` to run extraction against a local vision model instead of Claude, for free and private development.
- **A strict JSON contract between model and renderer.** The function strips stray formatting from the model's reply, and the app drops any malformed entries before drawing. A failed read comes back as a plain-English message, not a crash.
- **Human in the loop.** The model's output is a first draft. The editor exists because extraction from hand drawings is never perfect.

## Stack

React 18 · Vite · Three.js · Tailwind · Netlify Functions · Claude API (vision)

## Run it locally

```bash
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm run dev
```

Built by Antoni (Tony) Jagodka with Claude Code. I planned it, reviewed every change and tested it on real hand-drawn plans.
