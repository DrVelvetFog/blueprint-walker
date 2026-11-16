import React from "react";
import FloorPlanWalker from "./FloorPlanWalker.jsx";

// If anything in the app throws while drawing, show a way out instead of a blank page.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.error("Blueprint Walker crashed:", err); }
  clearSaved = () => {
    if (!window.confirm("Delete every plan saved in this browser and start fresh? This can't be undone.")) return;
    try { localStorage.removeItem("bw_plans"); } catch {}
    window.location.reload();
  };
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-slate-100" style={{ background: "#0c0a1f", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
        <div role="alert" className="max-w-sm text-center">
          <h1 className="text-lg font-semibold mb-2">Something went wrong.</h1>
          <p className="text-sm text-slate-300 mb-5">Reloading usually fixes it. Your saved plans are still in this browser.</p>
          <div className="flex flex-col gap-2">
            <button onClick={() => window.location.reload()} className="min-h-11 px-4 rounded-lg text-sm font-semibold text-white" style={{ background: "#6d5ae6" }}>Reload</button>
            <button onClick={this.clearSaved} className="min-h-11 px-4 rounded-lg text-sm text-slate-300" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>Still stuck? Clear saved plans</button>
          </div>
        </div>
      </div>
    );
  }
}

export default function App() {
  return <ErrorBoundary><FloorPlanWalker /></ErrorBoundary>;
}
