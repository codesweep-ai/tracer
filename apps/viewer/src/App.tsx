import { useEffect, useState } from "react";
import { AppShell, Footer, Header, ThemeToggle } from "@codesweep-ai/ui";
import { loadIndex, SUPPORTED_SCHEMA_VERSION } from "./data";
import { IndexPage } from "./IndexPage";
import { TrajectoryPage } from "./TrajectoryPage";
import type { LinkHint, LoadedTrace } from "./types";
import { currentTraceId, indexLink } from "./routes";

export default function App() {
  const [state, setState] = useState<{ traces: LoadedTrace[]; links: LinkHint[] }>(); const [error, setError] = useState<string>();
  useEffect(() => { void loadIndex().then(({ index, traces }) => setState({ traces, links: index.links ?? [] })).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }, []);
  const traceId = currentTraceId(state?.traces ?? []); const trace = state?.traces.find((item) => item.id === traceId);
  return <AppShell><Header title="cs-tracer" titleHref={indexLink()} navItems={[{ label: "Trajectories", href: indexLink(), active: !traceId }]} actions={<ThemeToggle />} /><main className="app-main">{error ? <p role="alert" className="alert-error">{error}</p> : !state ? <p role="status">Loading trajectory summaries…</p> : traceId && !trace ? <p role="alert">Trajectory “{traceId}” was not found.</p> : trace ? <TrajectoryPage trace={trace} /> : <IndexPage traces={state.traces} links={state.links} />}</main><Footer>cs-tracer · schema v{SUPPORTED_SCHEMA_VERSION} · @codesweep-ai/ui v{__UI_VERSION__}</Footer></AppShell>;
}
