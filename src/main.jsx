import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// No StrictMode: the 3D walk owns a long-lived WebGL context + animation loop in a
// single effect, and StrictMode's intentional double-mount churns that context twice.
createRoot(document.getElementById("root")).render(<App />);
