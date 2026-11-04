import type { Candidate } from './detect.js';
import { promptSize } from './detect.js';
import { rebuildCostUsd } from './pricing.js';
import type { Cause, Confidence, Rebuild, Session } from './types.js';

export const TTL_5M_MS = 5 * 60 * 1000;
export const TTL_1H_MS = 60 * 60 * 1000;
/** Prompt shrinking below this fraction of the previous prompt is treated as a context reset. */
export const COMPACTION_DROP = 0.6;
/** Only sizeable prompts can "drop"; small ones fluctuate for ordinary reasons. */
export const COMPACTION_MIN_PREV = 50_000;
/** If at least this much of the prompt was still read from cache, the system prompt and tools survived. */
export const TOP_SURVIVED_TOKENS = 5_000;

/**
 * The cache TTL that applied before `turn` is the TTL of the most recent cache write.
 * Claude Code may write with a 1-hour TTL; a turn that only read inherits the earlier TTL.
 */
export function ttlBefore(session: Session, turnIndex: number): number {
  for (let i = turnIndex - 1; i >= 0; i--) {
    const t = session.turns[i]!;
    if (t.cacheWrite1h > 0) return TTL_1H_MS;
    if (t.cacheWrite5m > 0 || t.cacheWrite > 0) return TTL_5M_MS;
  }
  return TTL_5M_MS;
}

const fmtGap = (ms: number): string =>
  ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;

interface Verdict {
  cause: Cause;
  confidence: Confidence;
  detail: string;
}

/** Order matters: explicit evidence (compact marker, model change) wins over timing inference. */
function decide(c: Candidate, isFork: boolean): Verdict {
  const { turn, prev, session, gapMs } = c;
  if (isFork) {
    return { cause: 'session_fork', confidence: 'medium', detail: `new session started ${fmtGap(gapMs)} after another session in the same directory` };
  }
  if (turn.compactionBefore) {
    return { cause: 'compaction', confidence: 'high', detail: 'compact marker found in transcript' };
  }
  const drop = promptSize(turn) / promptSize(prev);
  if (promptSize(prev) >= COMPACTION_MIN_PREV && drop < COMPACTION_DROP) {
    return { cause: 'compaction', confidence: 'medium', detail: `prompt shrank ${Math.round((1 - drop) * 100)}% with no compact marker` };
  }
  if (turn.model !== prev.model) {
    return { cause: 'model_switch', confidence: 'high', detail: `${prev.model} -> ${turn.model}` };
  }
  if (Number.isNaN(gapMs)) {
    return { cause: 'unknown', confidence: 'low', detail: 'missing timestamps' };
  }
  const ttl = ttlBefore(session, turn.index);
  if (gapMs > ttl) {
    return { cause: 'ttl_expiry', confidence: 'high', detail: `${fmtGap(gapMs)} idle, cache TTL was ${ttl === TTL_1H_MS ? '1 h' : '5 min'}` };
  }
  if (gapMs > TTL_5M_MS) {
    // Inside the 1-hour TTL but past 5 minutes: the cache should have survived. Could be an
    // early eviction server-side or a prefix change; there is no evidence either way.
    return { cause: 'unknown', confidence: 'low', detail: `${fmtGap(gapMs)} idle but 1 h cache should still have been alive` };
  }
  if (turn.version && prev.version && turn.version !== prev.version) {
    return { cause: 'prefix_change', confidence: 'medium', detail: `Claude Code updated ${prev.version} -> ${turn.version}, system prompt likely changed` };
  }
  if (turn.cacheRead >= TOP_SURVIVED_TOKENS) {
    // The cache hit stopped part-way through the conversation: the system prompt and tools were
    // intact, so an earlier message changed. Claude Code does this when it clears old tool
    // results (microcompact) or rewrites attachments; the prompt usually shrinks a little.
    const shrink = Math.round((1 - drop) * 100);
    return { cause: 'history_edit', confidence: 'medium', detail: `first ${Math.round(turn.cacheRead / 1000)}k tokens still cached, rest rewritten${shrink > 0 ? `; prompt shrank ${shrink}%` : ''}` };
  }
  return { cause: 'prefix_change', confidence: 'low', detail: `${fmtGap(gapMs)} after a cached turn, same model; system prompt, tools, CLAUDE.md or MCP servers likely changed` };
}

export function classify(c: Candidate, isFork = false): Rebuild {
  const v = decide(c, isFork);
  return {
    sessionId: c.session.id,
    file: c.session.file,
    cwd: c.session.cwd,
    turn: c.turn,
    prev: c.prev,
    share: c.share,
    rewrittenTokens: c.rewrittenTokens,
    gapMs: c.gapMs,
    ...v,
    estCostUsd: rebuildCostUsd(c.turn, c.rewrittenTokens),
  };
}
