export const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
export const duration = (ms?: number | null) => ms == null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
export const eventLabel = (kind: string) => kind.replace("_", " ");
