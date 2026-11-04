import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Session, Turn } from './types.js';

/** Recursively list `*.jsonl` files under a directory, or return the path itself if it is a file. */
export function findTranscriptFiles(root: string): string[] {
  const st = statSync(root);
  if (st.isFile()) return [root];
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions): skip it rather than abort the whole scan
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

type Json = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

/** Parse one transcript file into a Session. Returns null when it holds no API calls. */
export function parseSessionFile(file: string): Session | null {
  const name = basename(file, '.jsonl');
  const session: Session = { id: name, file, isSubagent: name.startsWith('agent-'), turns: [] };
  const byRequest = new Map<string, Turn>();
  let pendingCompaction = false;

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null; // unreadable file (permissions): skip it rather than abort the whole scan
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: Json;
    try {
      rec = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (!session.cwd && typeof rec.cwd === 'string') session.cwd = rec.cwd;

    // Claude Code writes a `compact_boundary` system line and a user line flagged
    // `isCompactSummary` when it compacts; either one marks the next call as post-compaction.
    if ((rec.type === 'system' && rec.subtype === 'compact_boundary') || rec.isCompactSummary === true) {
      pendingCompaction = true;
      continue;
    }
    if (rec.type !== 'assistant') continue;

    const message = obj(rec.message);
    const usage = obj(message.usage);
    if (!Object.keys(usage).length) continue;
    const model = typeof message.model === 'string' ? message.model : 'unknown';
    if (model === '<synthetic>') continue; // local placeholder messages, not API calls

    const requestId = String(rec.requestId ?? message.id ?? `line-${byRequest.size}`);
    const split = obj(usage.cache_creation);
    const fresh: Turn = {
      index: byRequest.size,
      requestId,
      timestamp: typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN,
      model,
      inputTokens: num(usage.input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      cacheWrite5m: num(split.ephemeral_5m_input_tokens),
      cacheWrite1h: num(split.ephemeral_1h_input_tokens),
      outputTokens: num(usage.output_tokens),
      compactionBefore: pendingCompaction,
      version: typeof rec.version === 'string' ? rec.version : undefined,
    };

    // One API call is logged as several assistant lines (one per content block) that
    // repeat the same usage; keep one Turn per requestId and take the largest counters.
    const existing = byRequest.get(requestId);
    if (existing) {
      for (const k of ['inputTokens', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'outputTokens'] as const) {
        existing[k] = Math.max(existing[k], fresh[k]);
      }
      continue;
    }
    byRequest.set(requestId, fresh);
    session.turns.push(fresh);
    pendingCompaction = false;
  }
  return session.turns.length ? session : null;
}

export function loadSessions(root: string): Session[] {
  const sessions: Session[] = [];
  for (const file of findTranscriptFiles(root)) {
    const s = parseSessionFile(file);
    if (s) sessions.push(s);
  }
  return sessions;
}
