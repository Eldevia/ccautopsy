import mri from 'mri';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pc from 'picocolors';
import { classify } from './classify.js';
import { findForkCandidates, findRebuilds } from './detect.js';
import { loadSessions } from './parse.js';
import { renderSummary, renderTimeline, summarize, toJson } from './report.js';
import type { Rebuild, Session } from './types.js';

const HELP = `ccautopsy - why did my Claude Code quota disappear?

Usage: ccautopsy [path] [options]

  path              transcript directory or .jsonl file (default: ~/.claude/projects)
  --since <dur>     only API calls in the last <dur>, e.g. 30m, 24h, 7d
  --session <id>    turn-by-turn timeline for one session (prefix match)
  --json            machine-readable output
  -h, --help        show this help

Reads local transcripts only. No network, no telemetry, no writes.`;

export function parseSince(v: string): number {
  const m = /^(\d+)([mhd])$/.exec(v.trim());
  if (!m) throw new Error(`invalid --since "${v}", use e.g. 30m, 24h, 7d`);
  const n = Number(m[1]);
  return n * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}

export function analyze(sessions: Session[]): Rebuild[] {
  const rebuilds = sessions.flatMap((s) => findRebuilds(s).map((c) => classify(c)));
  rebuilds.push(...findForkCandidates(sessions).map((c) => classify(c, true)));
  return rebuilds.sort((a, b) => a.turn.timestamp - b.turn.timestamp);
}

function main(argv: string[]): number {
  const args = mri(argv, { boolean: ['json', 'help'], string: ['since', 'session'], alias: { h: 'help' } });
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const root = String(args._[0] ?? join(homedir(), '.claude', 'projects'));
  if (!existsSync(root)) {
    console.error(pc.red(`not found: ${root}`));
    return 1;
  }
  // Detection always runs on the full session so every turn keeps its real predecessor;
  // --since only filters what is reported afterwards.
  const full = loadSessions(root);
  let sessions = full;
  let rebuilds = analyze(full);
  if (args.since) {
    let cutoff: number;
    try {
      cutoff = Date.now() - parseSince(String(args.since));
    } catch (e) {
      console.error(pc.red((e as Error).message));
      return 1;
    }
    sessions = full
      .map((s) => ({ ...s, turns: s.turns.filter((t) => t.timestamp >= cutoff) }))
      .filter((s) => s.turns.length);
    rebuilds = rebuilds.filter((r) => r.turn.timestamp >= cutoff);
  }

  if (args.session) {
    const id = String(args.session);
    const matches = sessions.filter((s) => s.id.startsWith(id));
    const session = matches[0];
    if (!session) {
      console.error(pc.red(`no session starting with "${id}"`));
      return 1;
    }
    if (matches.length > 1) console.error(pc.yellow(`${matches.length} sessions match "${id}", showing ${session.id}`));
    const own = rebuilds.filter((r) => r.sessionId === session.id);
    console.log(args.json ? toJson(summarize([session], own), own) : renderTimeline(session, own));
    return 0;
  }
  const summary = summarize(sessions, rebuilds);
  console.log(args.json ? toJson(summary, rebuilds) : renderSummary(summary));
  return 0;
}

// Only run when executed as a script, so the helpers above can be imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
