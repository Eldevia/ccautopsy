import type { Session, Turn } from './types.js';

/** A turn is a rebuild when at least this share of its prompt was written to cache. */
export const REBUILD_SHARE = 0.5;
/** Ignore tiny prompts: a 2k-token write is noise, not a quota problem. */
export const MIN_PROMPT_TOKENS = 5_000;

export const promptSize = (t: Turn): number => t.inputTokens + t.cacheRead + t.cacheWrite;
export const rebuildShare = (t: Turn): number => (promptSize(t) ? t.cacheWrite / promptSize(t) : 0);

export interface Candidate {
  session: Session;
  turn: Turn;
  prev: Turn;
  share: number;
  rewrittenTokens: number;
  gapMs: number;
}

/**
 * Walk a session's API calls in order and return the turns that rewrote the cache.
 * The first call of every session is skipped: a cache must be built once, that is not waste.
 * `rewrittenTokens` is capped at the part of the previous prompt that was NOT still read from
 * cache, so genuine prompt growth (new files read, long tool results) is never counted as waste.
 */
function rewritten(turn: Turn, prev: Turn): number {
  return Math.min(turn.cacheWrite, Math.max(0, promptSize(prev) - turn.cacheRead));
}

export function findRebuilds(session: Session): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 1; i < session.turns.length; i++) {
    const turn = session.turns[i]!;
    const prev = session.turns[i - 1]!;
    if (promptSize(turn) < MIN_PROMPT_TOKENS || promptSize(prev) === 0) continue;
    const share = rebuildShare(turn);
    if (share < REBUILD_SHARE) continue;
    out.push({
      session,
      turn,
      prev,
      share,
      rewrittenTokens: rewritten(turn, prev),
      gapMs: turn.timestamp - prev.timestamp,
    });
  }
  return out;
}

/** Minimum first-call cache write for a new session to be suspected of continuing earlier work. */
export const FORK_MIN_WRITE = 20_000;
/** A sibling session in the same directory that was active this recently is "warm". */
export const FORK_WINDOW_MS = 60 * 60 * 1000;

/**
 * A brand-new session file whose very first call writes a large prompt, started while another
 * session in the same working directory was active in the last hour, is probably a resume/fork
 * (`--resume`, `--continue`, or a forked conversation). Claude Code does not link the files, so
 * this is inferred from timing only.
 */
export function findForkCandidates(sessions: Session[]): Candidate[] {
  const out: Candidate[] = [];
  for (const s of sessions) {
    const first = s.turns[0];
    if (s.isSubagent || !first || !s.cwd || first.cacheWrite < FORK_MIN_WRITE) continue;
    if (first.cacheRead > 0 || Number.isNaN(first.timestamp)) continue;
    const warm = sessions.find(
      (o) =>
        o !== s &&
        !o.isSubagent &&
        o.cwd === s.cwd &&
        o.turns.some((t) => first.timestamp - t.timestamp > 0 && first.timestamp - t.timestamp <= FORK_WINDOW_MS),
    );
    if (!warm) continue;
    const prev = [...warm.turns].reverse().find((t) => t.timestamp < first.timestamp)!;
    out.push({
      session: s,
      turn: first,
      prev,
      share: rebuildShare(first),
      rewrittenTokens: rewritten(first, prev),
      gapMs: first.timestamp - prev.timestamp,
    });
  }
  return out;
}
