import React from "react";
import FloorPlanWalker from "./FloorPlanWalker.jsx";

// Phase 0: render the prototype unchanged. Later phases split FloorPlanWalker
// into src/lib + src/components and grow App into the real step state machine.
export default function App() {
  return <FloorPlanWalker />;
}
