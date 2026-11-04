import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { classify, ttlBefore, TTL_1H_MS, TTL_5M_MS } from '../src/classify.js';
import { findForkCandidates, findRebuilds } from '../src/detect.js';
import { loadSessions, parseSessionFile } from '../src/parse.js';
import { priceFor, rebuildCostUsd } from '../src/pricing.js';
import { renderSummary, renderTimeline, summarize, toJson } from '../src/report.js';
import { parseSince } from '../src/cli.js';
import type { Rebuild, Session } from '../src/types.js';

const fx = (name: string): string => join(__dirname, 'fixtures', name);

function analyze(dir: string): { sessions: Session[]; rebuilds: Rebuild[] } {
  const sessions = loadSessions(fx(dir));
  const rebuilds = sessions.flatMap((s) => findRebuilds(s).map((c) => classify(c)));
  rebuilds.push(...findForkCandidates(sessions).map((c) => classify(c, true)));
  return { sessions, rebuilds };
}

describe('parse', () => {
  it('dedupes assistant lines by requestId, skips synthetic and garbage lines', () => {
    const s = parseSessionFile(fx('dedupe/fx-dedupe.jsonl'))!;
    expect(s.turns.map((t) => t.requestId)).toEqual(['r1', 'r2']);
    expect(s.cwd).toBe('/work/demo');
    expect(s.isSubagent).toBe(false);
  });
  it('reads the 5m/1h cache write split', () => {
    const s = parseSessionFile(fx('ttl-expiry/fx-ttl1h.jsonl'))!;
    expect(s.turns[0]!.cacheWrite1h).toBe(40000);
    expect(ttlBefore(s, 2)).toBe(TTL_1H_MS);
    expect(ttlBefore(parseSessionFile(fx('ttl-expiry/fx-ttl.jsonl'))!, 2)).toBe(TTL_5M_MS);
  });
});

describe('detect', () => {
  it('never flags the first call of a session and caps rewritten tokens at the previous prompt', () => {
    const s = parseSessionFile(fx('ttl-expiry/fx-ttl.jsonl'))!;
    const c = findRebuilds(s);
    expect(c).toHaveLength(1);
    expect(c[0]!.turn.index).toBe(2);
    expect(c[0]!.rewrittenTokens).toBe(41500); // min(cacheWrite 41500, prev prompt 41505)
  });
});

describe('classify', () => {
  it.each([
    ['ttl-expiry', 'fx-ttl', 'ttl_expiry', 'high'],
    ['ttl-expiry', 'fx-ttl1h', 'ttl_expiry', 'high'],
    ['model-switch', 'fx-model', 'model_switch', 'high'],
    ['compaction', 'fx-compact', 'compaction', 'high'],
    ['compaction', 'fx-drop', 'compaction', 'medium'],
    ['prefix-change', 'fx-prefix', 'prefix_change', 'low'],
    ['prefix-change', 'fx-version', 'prefix_change', 'medium'],
    ['history-edit', 'fx-history', 'history_edit', 'medium'],
    ['unknown', 'fx-unknown', 'unknown', 'low'],
  ])('%s/%s -> %s (%s)', (dir, id, cause, confidence) => {
    const r = analyze(dir).rebuilds.filter((x) => x.sessionId === id);
    expect(r).toHaveLength(1);
    expect<string>(r[0]!.cause).toBe(cause);
    expect<string>(r[0]!.confidence).toBe(confidence);
  });
  it('flags a new session started while a sibling in the same cwd was warm as a fork', () => {
    const { rebuilds } = analyze('session-fork');
    expect(rebuilds.map((r) => [r.sessionId, r.cause])).toEqual([['fx-child', 'session_fork']]);
    expect(rebuilds[0]!.rewrittenTokens).toBe(62000);
  });
  it('compaction with a marker beats a model switch would-be (marker is explicit evidence)', () => {
    const s = parseSessionFile(fx('compaction/fx-compact.jsonl'))!;
    expect(s.turns[2]!.compactionBefore).toBe(true);
    expect(s.turns[1]!.compactionBefore).toBe(false);
  });
});

describe('pricing', () => {
  it('maps model families and prices 1h writes higher than 5m writes', () => {
    expect(priceFor('claude-opus-5-5').input).toBe(4);
    expect(priceFor('claude-sonnet-4-5-20250929').input).toBe(3);
    expect(priceFor('something-else').input).toBe(3);
    const base = { index: 0, requestId: 'x', timestamp: 0, model: 'claude-opus-5-5', inputTokens: 0, cacheRead: 0, cacheWrite: 1e6, outputTokens: 0, compactionBefore: false };
    const c5 = rebuildCostUsd({ ...base, cacheWrite5m: 1e6, cacheWrite1h: 0 }, 1e6);
    const c1 = rebuildCostUsd({ ...base, cacheWrite5m: 0, cacheWrite1h: 1e6 }, 1e6);
    expect(c5).toBeCloseTo(4 * 1.25 - 0.2);
    expect(c1).toBeCloseTo(4 * 2 - 0.2);
  });
});

describe('report', () => {
  it('ranks causes by tokens and renders without throwing', () => {
    const all = ['ttl-expiry', 'model-switch', 'compaction', 'prefix-change', 'history-edit', 'session-fork', 'unknown'].map(analyze);
    const sessions = all.flatMap((a) => a.sessions);
    const rebuilds = all.flatMap((a) => a.rebuilds);
    const s = summarize(sessions, rebuilds);
    expect(s.rebuilds).toBe(rebuilds.length);
    expect(s.byCause[0]!.cause).toBe('ttl_expiry'); // two TTL fixtures outweigh the two compaction ones
    expect(s.byCause.map((c) => c.rewrittenTokens)).toEqual([...s.byCause.map((c) => c.rewrittenTokens)].sort((a, b) => b - a));
    expect(s.worstSessions.length).toBeLessThanOrEqual(5);
    expect(renderSummary(s)).toContain('TTL expiry');
    const json = JSON.parse(toJson(s, rebuilds));
    expect(json.rebuilds[0]).toHaveProperty('cause');
    expect(renderTimeline(sessions[0]!, rebuilds)).toContain('session ');
  });
  it('reports nothing to fix on a clean session', () => {
    const s = parseSessionFile(fx('dedupe/fx-dedupe.jsonl'))!;
    expect(renderSummary(summarize([s], []))).toContain('No cache rebuilds');
  });
});

describe('cli helpers', () => {
  it('never counts tokens still read from cache as rewritten', () => {
    const s = parseSessionFile(fx('history-edit/fx-history.jsonl'))!;
    for (const c of findRebuilds(s)) {
      expect(c.rewrittenTokens).toBeLessThanOrEqual(Math.max(0, c.prev.inputTokens + c.prev.cacheRead + c.prev.cacheWrite - c.turn.cacheRead));
    }
  });
  it('parses --since durations', () => {
    expect(parseSince('30m')).toBe(1_800_000);
    expect(parseSince('24h')).toBe(86_400_000);
    expect(parseSince('7d')).toBe(604_800_000);
    expect(() => parseSince('soon')).toThrow();
  });
});
