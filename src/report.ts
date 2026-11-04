import pc from 'picocolors';
import { promptSize, rebuildShare } from './detect.js';
import type { Cause, Rebuild, Session } from './types.js';

export const CAUSE_LABEL: Record<Cause, string> = {
  ttl_expiry: 'TTL expiry',
  model_switch: 'Model switch',
  compaction: 'Compaction / context reset',
  session_fork: 'Session resume or fork',
  prefix_change: 'Prefix change (likely)',
  history_edit: 'History edit (likely)',
  unknown: 'Unknown',
};

export const CAUSE_TIP: Record<Cause, string> = {
  ttl_expiry: 'Breaks longer than the cache TTL rebuild the whole prompt. Finish a thought before stepping away, or keep sessions short and start fresh after a break.',
  model_switch: 'Each model keeps its own cache. Pick a model at the start of a session; switching mid-session rewrites the entire context.',
  compaction: 'Compaction rewrites the prompt from scratch. Start new sessions for new tasks instead of letting one grow to the limit.',
  session_fork: 'Resuming or forking replays the old context into a new cache. Prefer continuing in the same session while it is warm.',
  prefix_change: 'Anything before the conversation (system prompt, tool list, CLAUDE.md, MCP servers, CLI version) invalidates the cache when it changes. Avoid editing CLAUDE.md or toggling MCP servers mid-session.',
  history_edit: 'An earlier message was rewritten (old tool results cleared, attachments refreshed), so everything after it was re-cached. Keep tool outputs small (head, grep, --json) so there is less to clear and re-cache.',
  unknown: 'No heuristic matched. If this bucket is large, open an issue with the --json output (it contains no prompt text).',
};

const fmtTokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : `${n}`);
const fmtUsd = (n: number): string => `~$${n.toFixed(2)}`;
const fmtGap = (ms: number): string =>
  Number.isNaN(ms) ? '?' : ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

export interface Summary {
  sessions: number;
  apiCalls: number;
  totalCacheWrite: number;
  totalPrompt: number;
  rebuilds: number;
  rewrittenTokens: number;
  estCostUsd: number;
  byCause: Array<{ cause: Cause; label: string; rebuilds: number; rewrittenTokens: number; estCostUsd: number; tip: string }>;
  worstSessions: Array<{ sessionId: string; cwd?: string; rebuilds: number; rewrittenTokens: number; topCause: Cause }>;
}

export function summarize(sessions: Session[], rebuilds: Rebuild[]): Summary {
  const byCause = new Map<Cause, Summary['byCause'][number]>();
  const bySession = new Map<string, Summary['worstSessions'][number] & { causes: Map<Cause, number> }>();
  for (const r of rebuilds) {
    const c = byCause.get(r.cause) ?? { cause: r.cause, label: CAUSE_LABEL[r.cause], rebuilds: 0, rewrittenTokens: 0, estCostUsd: 0, tip: CAUSE_TIP[r.cause] };
    c.rebuilds++;
    c.rewrittenTokens += r.rewrittenTokens;
    c.estCostUsd += r.estCostUsd;
    byCause.set(r.cause, c);
    const s = bySession.get(r.sessionId) ?? { sessionId: r.sessionId, cwd: r.cwd, rebuilds: 0, rewrittenTokens: 0, topCause: r.cause, causes: new Map() };
    s.rebuilds++;
    s.rewrittenTokens += r.rewrittenTokens;
    s.causes.set(r.cause, (s.causes.get(r.cause) ?? 0) + r.rewrittenTokens);
    bySession.set(r.sessionId, s);
  }
  const worst = [...bySession.values()]
    .sort((a, b) => b.rewrittenTokens - a.rewrittenTokens)
    .slice(0, 5)
    .map(({ causes, ...s }) => ({ ...s, topCause: [...causes.entries()].sort((a, b) => b[1] - a[1])[0]![0] }));
  const turns = sessions.flatMap((s) => s.turns);
  return {
    sessions: sessions.length,
    apiCalls: turns.length,
    totalCacheWrite: turns.reduce((a, t) => a + t.cacheWrite, 0),
    totalPrompt: turns.reduce((a, t) => a + promptSize(t), 0),
    rebuilds: rebuilds.length,
    rewrittenTokens: rebuilds.reduce((a, r) => a + r.rewrittenTokens, 0),
    estCostUsd: rebuilds.reduce((a, r) => a + r.estCostUsd, 0),
    byCause: [...byCause.values()].sort((a, b) => b.rewrittenTokens - a.rewrittenTokens),
    worstSessions: worst,
  };
}

export function renderSummary(s: Summary): string {
  const lines: string[] = [];
  const pct = s.totalCacheWrite ? Math.round((s.rewrittenTokens / s.totalCacheWrite) * 100) : 0;
  lines.push(pc.bold(`ccautopsy: ${s.sessions} sessions, ${s.apiCalls} API calls`));
  lines.push('');
  lines.push(`${pc.bold(fmtTokens(s.rewrittenTokens))} tokens were rewritten into the prompt cache in ${pc.bold(String(s.rebuilds))} rebuilds`);
  lines.push(pc.dim(`  that is ~${pct}% of all cache writes (${fmtTokens(s.totalCacheWrite)}), estimated extra cost ${fmtUsd(s.estCostUsd)} at API prices`));
  lines.push('');
  if (!s.byCause.length) {
    lines.push(pc.green('No cache rebuilds found. Nothing to fix.'));
    return lines.join('\n');
  }
  lines.push(pc.bold('Causes, ranked by tokens rewritten'));
  for (const c of s.byCause) {
    lines.push(`  ${pc.yellow(c.label.padEnd(28))} ${fmtTokens(c.rewrittenTokens).padStart(7)} tokens  ${String(c.rebuilds).padStart(4)} rebuilds  ${fmtUsd(c.estCostUsd).padStart(9)}`);
    lines.push(pc.dim(`    tip: ${c.tip}`));
  }
  lines.push('');
  lines.push(pc.bold('Worst sessions'));
  for (const w of s.worstSessions) {
    const where = w.cwd ? pc.dim(` ${w.cwd}`) : '';
    lines.push(`  ${w.sessionId.slice(0, 8)}  ${fmtTokens(w.rewrittenTokens).padStart(7)} tokens  ${String(w.rebuilds).padStart(3)} rebuilds  mostly ${CAUSE_LABEL[w.topCause]}${where}`);
  }
  lines.push('');
  lines.push(pc.dim('Costs are estimates at pay-as-you-go API prices; subscription quotas are not published per token.'));
  lines.push(pc.dim('Run with --session <id> for a turn-by-turn timeline, --json for machine-readable output.'));
  return lines.join('\n');
}

export function renderTimeline(session: Session, rebuilds: Rebuild[]): string {
  const flagged = new Map(rebuilds.map((r) => [r.turn.requestId, r]));
  const lines = [pc.bold(`session ${session.id}${session.cwd ? pc.dim(`  ${session.cwd}`) : ''}`), ''];
  lines.push(pc.dim('  #    time      gap    model               prompt   write    read   share'));
  let prevTs = NaN;
  for (const t of session.turns) {
    const r = flagged.get(t.requestId);
    const time = Number.isNaN(t.timestamp) ? '??:??:??' : new Date(t.timestamp).toISOString().slice(11, 19);
    const row = `  ${String(t.index).padStart(3)}  ${time}  ${fmtGap(t.timestamp - prevTs).padStart(5)}  ${t.model.padEnd(18).slice(0, 18)}  ${fmtTokens(promptSize(t)).padStart(6)}  ${fmtTokens(t.cacheWrite).padStart(6)}  ${fmtTokens(t.cacheRead).padStart(6)}  ${Math.round(rebuildShare(t) * 100).toString().padStart(3)}%`;
    lines.push(r ? pc.red(row) : row);
    if (r) lines.push(pc.red(`       ^ ${CAUSE_LABEL[r.cause]} (${r.confidence}): ${r.detail}; ${fmtTokens(r.rewrittenTokens)} tokens rewritten`));
    prevTs = t.timestamp;
  }
  return lines.join('\n');
}

export function toJson(summary: Summary, rebuilds: Rebuild[]): string {
  return JSON.stringify(
    {
      note: 'All figures are estimates. rewrittenTokens is capped at the previous prompt size; costs use approximate API prices.',
      summary,
      rebuilds: rebuilds.map((r) => ({
        sessionId: r.sessionId,
        file: r.file,
        turnIndex: r.turn.index,
        timestamp: Number.isNaN(r.turn.timestamp) ? null : new Date(r.turn.timestamp).toISOString(),
        model: r.turn.model,
        gapMs: Number.isNaN(r.gapMs) ? null : r.gapMs,
        promptTokens: promptSize(r.turn),
        cacheWrite: r.turn.cacheWrite,
        cacheRead: r.turn.cacheRead,
        share: Number(r.share.toFixed(3)),
        rewrittenTokens: r.rewrittenTokens,
        cause: r.cause,
        confidence: r.confidence,
        detail: r.detail,
        estCostUsd: Number(r.estCostUsd.toFixed(4)),
      })),
    },
    null,
    2,
  );
}
