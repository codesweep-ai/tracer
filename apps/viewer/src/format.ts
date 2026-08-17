export const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
export const duration = (ms?: number | null) => ms == null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
export const money = (cost?: number | null, estimated?: boolean) => cost == null ? "" : `${estimated ? "~" : ""}$${cost.toFixed(4)}${estimated ? " est." : ""}`;
export const eventLabel = (kind: string) => kind.replace("_", " ");
