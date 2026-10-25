/**
 * Locate DSH session logs on this machine and turn them into event arrays.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionFile } from './zstd.mjs';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

/** Project directory name DSH derives from a working directory. */
export function projectSlug(cwd) {
  return '--' + String(cwd).replace(/[\\/:]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '--';
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl.zstd') || e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** Every session log, newest first. `current` prefers the given cwd's project dir. */
export function listSessions({ cwd } = {}) {
  const files = walk(sessionsRoot()).map((file) => {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      st = { mtimeMs: 0, size: 0 };
    }
    const rel = path.relative(sessionsRoot(), file);
    const parts = rel.split(path.sep);
    return {
      file,
      project: parts[0] || '',
      sessionId: parts[1] || '',
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
  });
  const wanted = cwd ? projectSlug(cwd) : null;
  files.sort((a, b) => {
    if (wanted) {
      const aw = a.project === wanted ? 1 : 0;
      const bw = b.project === wanted ? 1 : 0;
      if (aw !== bw) return bw - aw;
    }
    return b.mtimeMs - a.mtimeMs;
  });
  return files;
}

export function resolveSession({ session, cwd } = {}) {
  const all = listSessions({ cwd });
  if (all.length === 0) {
    throw new Error(
      `No session logs under ${sessionsRoot()}. Set DSH_HOME if your sessions live elsewhere.`,
    );
  }
  if (!session || session === 'latest' || session === 'current') return all[0];
  const hit =
    all.find((s) => s.sessionId === session) ||
    all.find((s) => s.sessionId === 'session-' + session) ||
    all.find((s) => s.sessionId.includes(session));
  if (!hit) throw new Error(`Session not found: ${session}`);
  return hit;
}

export function readEvents(file) {
  const text = readSessionFile(file);
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* torn tail */
    }
  }
  return events;
}
