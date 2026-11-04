/** One API call made by Claude Code, reconstructed from one or more `assistant` lines. */
export interface Turn {
  index: number;
  requestId: string;
  /** Epoch ms; NaN when the line had no parseable timestamp. */
  timestamp: number;
  model: string;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  outputTokens: number;
  /** A compact boundary / compact summary appeared between the previous API call and this one. */
  compactionBefore: boolean;
  version?: string;
}

export interface Session {
  id: string;
  file: string;
  cwd?: string;
  /** `agent-*.jsonl` files are subagent sidechains; their first call is a fresh prompt by design. */
  isSubagent: boolean;
  turns: Turn[];
}

export type Cause =
  | 'ttl_expiry'
  | 'model_switch'
  | 'compaction'
  | 'session_fork'
  | 'prefix_change'
  | 'history_edit'
  | 'unknown';

export type Confidence = 'high' | 'medium' | 'low';

export interface Rebuild {
  sessionId: string;
  file: string;
  cwd?: string;
  turn: Turn;
  prev?: Turn;
  /** cacheWrite / (input + cacheRead + cacheWrite) for this turn. */
  share: number;
  /** Tokens that were cached before and had to be written again (conservative, see detect.ts). */
  rewrittenTokens: number;
  gapMs: number;
  cause: Cause;
  confidence: Confidence;
  detail: string;
  estCostUsd: number;
}
