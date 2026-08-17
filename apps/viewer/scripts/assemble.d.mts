// Type declarations for assemble.mjs (the data-block contract primitives).
export declare function escapeBlock(json: string): string;
export declare function block(id: string, value: unknown): string;
export declare function injectBlocks(shell: string, blocks: string[]): string;
export declare function safeId(id: string): string;
export declare function summaryBlockId(id: string): string;
export declare function chunkBlockId(id: string, n: number): string;
export interface IndexLike { generatedAt?: string; trajectories: Array<{ id: string }>; links?: unknown[] }
export declare function reducedIndex(index: IndexLike, titleById: (id: string) => string | undefined, safeIdById: (id: string) => string): IndexLike;
