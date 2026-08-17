/**
 * assemble.mjs — the export-assembler primitives, shared with the viewer build
 * and mirrored by the Go exporter:
 *
 *   escapeBlock(json)  — every "<" becomes < so a "</script>" in trace text
 *                        cannot terminate a data block (SPEC.md §3.5).
 *   block(id, value)   — one <script type="application/json"> data block.
 *   injectBlocks(shell, blocks) — insert blocks before </body>. The replacer
 *                        MUST be a function: block JSON can contain `$'`, `$$`,
 *                        `$&`, `` $` `` (fixtures/claude/v2.1/hazard-text does),
 *                        which a string replacement would interpret as special
 *                        patterns, silently corrupting the page.
 *   safeId(id)         — the trace-id to filename transform.
 *   reducedIndex / summaryBlockId / chunkBlockId — the block-naming contract:
 *                        #index, #s-<id>, #c-<id>-NNN (NNN zero-padded to 3).
 */
export const escapeBlock = (json) => json.replaceAll("<", "\\u003c");
export const block = (id, value) => `<script type="application/json" id="${id}">${escapeBlock(JSON.stringify(value))}</script>`;
export function injectBlocks(shell, blocks) {
  if (!shell.includes("</body>")) throw new Error("shell has no </body>");
  return shell.replace("</body>", () => `${blocks.join("\n")}\n</body>`);
}
export const safeId = (id) => id.replace(/[^a-zA-Z0-9._-]/g, "-") || "trajectory";
export const summaryBlockId = (id) => `s-${id}`;
export const chunkBlockId = (id, n) => `c-${id}-${String(n).padStart(3, "0")}`;
export const reducedIndex = (index, titleById, safeIdById) => ({
  schemaVersion: 1,
  generatedAt: index.generatedAt,
  trajectories: index.trajectories.map(({ id }) => ({ id, safeId: safeIdById(id), title: titleById(id) })),
  ...(index.links?.length ? { links: index.links } : {}),
});
