import type { LoadedTrace, TraceChunk, TraceIndex, TraceSummary } from "./types";
import { inTracePage, mode } from "./routes";

// Transport: DOM data blocks instead of fetch() (SPEC.md §5). The export
// assembler embeds one <script type="application/json"> block per document —
//   #index          the trace index (full on index pages, reduced on trace pages)
//   #s-<id>         one summary per trace on the page
//   #c-<id>-NNN     one chunk per trace chunk on the page (NNN zero-padded to 3)
// with every "<" serialized as < so a "</script>" in trace text cannot
// terminate a block; JSON.parse decodes that transparently. The public
// surface is unchanged from the fetch() implementation, and the blocks mirror
// the shard structure — one summary, N chunks — so TrajectoryPage's progressive
// scan over chunkCount is untouched.

function readBlock<T>(id: string): T {
  const block = document.getElementById(id);
  if (!block) throw new Error(`Could not load data block #${id}`);
  try {
    return JSON.parse(block.textContent ?? "") as T;
  } catch (cause) {
    throw new Error(`Could not parse data block #${id}`, { cause });
  }
}

// Chunk blocks are keyed by trace id, but the public surface passes the index's
// `path` around; the two coincide for real session ids (safeId is a no-op on
// UUIDs and ses_… slugs). The map keeps them correct even when they diverge.
const idByPath = new Map<string, string>();
const blockKey = (path: string): string => idByPath.get(path) ?? path;

let loadedIndex: Promise<{ index: TraceIndex; traces: LoadedTrace[] }> | undefined;
// The one schema version this build implements. A document carrying any other
// version is REFUSED, not rendered: silently ignoring the mismatch produces
// blank panels and missing fields that look like data problems, and sends
// whoever debugs it to the wrong place entirely.
export const SUPPORTED_SCHEMA_VERSION = 2;

async function fetchIndex(): Promise<{ index: TraceIndex; traces: LoadedTrace[] }> {
  const index = readBlock<TraceIndex>("index");
  if (index.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `This trace uses schema version ${index.schemaVersion}, but this viewer implements version ${SUPPORTED_SCHEMA_VERSION}. Re-export it with a matching cs-tracer.`,
    );
  }
  // A split-mode trace page embeds a reduced index and only its own summary
  // block, so it surfaces exactly its own trace. Everywhere else every summary
  // block must be present — a missing one is a corrupt export, and skipping it
  // would silently drop a lane from the overview (the fetch() version 404'd).
  const tracePage = mode() === "split" && inTracePage();
  const traces = index.trajectories.flatMap(({ id, path }) => {
    if (!document.getElementById(`s-${id}`)) {
      if (tracePage) return [];
      throw new Error(`Could not load data block #s-${id}`);
    }
    const key = path ?? id; // reduced index entries carry no path
    idByPath.set(key, id);
    return [{ id, path: key, summary: readBlock<TraceSummary>(`s-${id}`) }];
  });
  return { index, traces };
}
export function loadIndex(): Promise<{ index: TraceIndex; traces: LoadedTrace[] }> {
  loadedIndex ??= fetchIndex().catch((error: unknown) => { loadedIndex = undefined; throw error; });
  return loadedIndex;
}

const chunkBlockId = (path: string, n: number): string => `c-${blockKey(path)}-${String(n).padStart(3, "0")}`;
const chunks = new Map<string, Promise<TraceChunk>>();
export function loadChunk(path: string, n: number): Promise<TraceChunk> {
  const key = `${path}/${n}`; let pending = chunks.get(key);
  if (!pending) { pending = Promise.resolve().then(() => readBlock<TraceChunk>(chunkBlockId(path, n))); chunks.set(key, pending); }
  return pending;
}
export async function scanChunkText(path: string, n: number, query: string): Promise<number[]> {
  const chunk = await loadChunk(path, n);
  const needle = query.toLocaleLowerCase();
  return chunk.events.filter((event) => `${event.text ?? ""}\n${event.tool?.name ?? ""}`.toLocaleLowerCase().includes(needle)).map((event) => event.i);
}
