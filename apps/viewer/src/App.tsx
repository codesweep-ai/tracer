import { useEffect, useState } from "react";
import { AppShell, Footer, Header, ThemeToggle } from "@codesweep-ai/ui";
import { loadIndex, SUPPORTED_SCHEMA_VERSION } from "./data";
import { IndexPage } from "./IndexPage";
import { TrajectoryPage } from "./TrajectoryPage";
import type { LinkHint, LoadedTrace } from "./types";
import { currentTraceId, indexLink } from "./routes";
import logoSrc from "./logo.png";

export default function App() {
  const [state, setState] = useState<{ traces: LoadedTrace[]; links: LinkHint[] }>(); const [error, setError] = useState<string>();
  useEffect(() => { void loadIndex().then(({ index, traces }) => setState({ traces, links: index.links ?? [] })).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }, []);
  const traceId = currentTraceId(state?.traces ?? []); const trace = state?.traces.find((item) => item.id === traceId);
  return <AppShell><Header logoSrc={logoSrc} title="Tracer" navItems={[{ label: "Trajectories", href: indexLink(), active: !traceId }]} actions={<ThemeToggle />} /><main className="flex-1 min-h-0 overflow-y-auto px-[var(--space-4)] py-[var(--space-4)]">{error ? <p role="alert" className="[color:var(--color-error)]">{error}</p> : !state ? <p role="status">Loading trajectory summaries…</p> : traceId && !trace ? <p role="alert">Trajectory “{traceId}” was not found.</p> : trace ? <TrajectoryPage trace={trace} /> : <IndexPage traces={state.traces} links={state.links} />}</main><Footer>Local, static, and private · schema v{SUPPORTED_SCHEMA_VERSION}</Footer></AppShell>;
}
