// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`. It reads a patch in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names
// at the first of three matching tiers, and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a patch performed, so the report can print `R old -> new` for them. */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  noteMove(oldP: string, newP: string): void {
    if (oldP !== newP) this.moves.push({ old: oldP, new: newP });
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Files as lines (SPEC.md section 3) ----

interface FState {
  lines: string[];
  br: string;
  ends: boolean;
}

function parseFile(text: string): FState {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function renderFile(s: FState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.ends ? s.br : '');
}

// ---- Matching lines at three tiers (SPEC.md section 5) ----

type Tier = 0 | 1 | 2;

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Positions at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: Tier, from = 0): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0 || k > lines.length) return out;
  for (let i = Math.max(0, from); i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at or after `from`, or null when it never does. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: Tier; at: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, o, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of N: `ctx` is its index in O when it is a context line, else -1. */
interface MappedLine {
  text: string;
  ctx: number;
}

/**
 * Replace O's lines at `pos` with N. A context line is written as the file's own
 * matched line; at tier 2 every other line is re-indented from O's first line to
 * the file's first matched line.
 */
function applyReplace(lines: string[], o: string[], n: MappedLine[], tier: Tier, pos: number): string[] {
  const reindent = tier === 2 && o.length > 0;
  const p = reindent ? leadWs(o[0]!) : '';
  const f = reindent ? leadWs(lines[pos] ?? '') : '';
  const out = lines.slice(0, pos);
  for (const ml of n) {
    if (ml.ctx >= 0) out.push(lines[pos + ml.ctx]!);
    else if (reindent && ml.text !== '' && ml.text.trim() !== '' && ml.text.startsWith(p)) out.push(f + ml.text.slice(p.length));
    else out.push(ml.text);
  }
  out.push(...lines.slice(pos + o.length));
  return out;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  o: string[];
  n: MappedLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noNlPlus: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:[ \t].*)?$/;
const isDiffGitLine = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');

function parseDiffGit(l: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
  if (!m) throw new Exit2(`error: parse ${lineNo}`);
  return [m[1]!, m[2]!];
}

/** The path after `--- ` or `+++ `, up to the first tab, spaces removed, `a/`/`b/` stripped. */
function headerPath(l: string): string {
  const t = l.slice(4).split('\t')[0]!.trim();
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function parseHunk(a: number, body: string[]): Hunk {
  const entries: { kind: string; text: string }[] = [];
  for (const l of body) {
    if (l === '') entries.push({ kind: ' ', text: '' });
    else if (l[0] === ' ') entries.push({ kind: ' ', text: l.slice(1) });
    else if (l[0] === '-') entries.push({ kind: '-', text: l.slice(1) });
    else if (l[0] === '+') entries.push({ kind: '+', text: l.slice(1) });
    else entries.push({ kind: '\\', text: l.slice(1) });
  }
  const followedByBackslash = (k: number): boolean => k + 1 < entries.length && entries[k + 1]!.kind === '\\';
  let noNl = false;
  let noNlPlus = false;
  for (let k = entries.length - 1; k >= 0; k--) {
    if (entries[k]!.kind === ' ' || entries[k]!.kind === '+') {
      noNl = followedByBackslash(k);
      break;
    }
  }
  for (let k = entries.length - 1; k >= 0; k--) {
    if (entries[k]!.kind === '+') {
      noNlPlus = followedByBackslash(k);
      break;
    }
  }
  const o: string[] = [];
  const n: MappedLine[] = [];
  for (const e of entries) {
    if (e.kind === ' ') {
      const idx = o.length;
      o.push(e.text);
      n.push({ text: e.text, ctx: idx });
    } else if (e.kind === '-') o.push(e.text);
    else if (e.kind === '+') n.push({ text: e.text, ctx: -1 });
  }
  return { a, o, n, noNl, noNlPlus };
}

function applyUnifiedHunk(st: FState, h: Hunk, d: number, strict: boolean, path: string): FState {
  if (h.o.length === 0) {
    let pos = h.a + d;
    if (pos < 0) pos = 0;
    if (pos > st.lines.length) pos = st.lines.length;
    const out = [...st.lines.slice(0, pos), ...h.n.map((ml) => ml.text), ...st.lines.slice(pos)];
    return { lines: out, br: st.br, ends: pos === st.lines.length ? !h.noNl : st.ends };
  }
  const found = findTier(st.lines, h.o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.at[0]!;
  for (const p of found.at) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const out = applyReplace(st.lines, h.o, h.n, found.tier, best);
  return { lines: out, br: st.br, ends: best + h.o.length === st.lines.length ? !h.noNl : st.ends };
}

/**
 * Parse one section starting at `start` (its `diff --git` line, or its `--- ` line).
 * Returns the index after the section and the section's edit.
 */
function parseUnifiedSection(lines: string[], start: number, diffX: string | null, diffY: string | null, strict: boolean): { next: number; edit: Edit } {
  let j = start;
  if (diffX !== null) j++;
  let oldP: string | null = null;
  let newP: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let isCreate = false;
  let isDelete = false;
  let havePair = false;
  const hunks: Hunk[] = [];
  let inHeader = true;
  while (j < lines.length) {
    const l = lines[j]!;
    if (inHeader) {
      if (l.startsWith('@@')) {
        inHeader = false;
        continue;
      }
      if (isDiffGitLine(l)) break;
      if (l.startsWith('--- ')) {
        const nx = lines[j + 1];
        if (nx === undefined || !nx.startsWith('+++ ')) throw new Exit2(`error: parse ${j + 2}`);
        if (havePair) break;
        oldP = headerPath(l);
        newP = headerPath(nx);
        havePair = true;
        j += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        newP = headerPath(l);
        j++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        renameFrom = l.slice(12).trim();
        j++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        renameTo = l.slice(10).trim();
        j++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        isCreate = true;
        j++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        isDelete = true;
        j++;
        continue;
      }
      j++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${j + 1}`);
      const a = Number(m[1]);
      j++;
      const body: string[] = [];
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j++;
        } else break;
      }
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      hunks.push(parseHunk(a, body));
      continue;
    }
    if (isDiffGitLine(l)) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    j++;
  }
  const oldPath = oldP ?? renameFrom ?? diffX ?? '';
  const newPath = newP ?? renameTo ?? diffY ?? '';
  if (oldPath === '/dev/null' || isCreate) {
    const p = newPath;
    const edit: Edit = (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added: string[] = [];
      for (const h of hunks) for (const ml of h.n) if (ml.ctx < 0) added.push(ml.text);
      let ends = false;
      for (let k = hunks.length - 1; k >= 0; k--) {
        if (hunks[k]!.n.some((ml) => ml.ctx < 0)) {
          ends = !hunks[k]!.noNlPlus;
          break;
        }
      }
      tree.now.set(p, added.length === 0 ? '' : added.join('\n') + (ends ? '\n' : ''));
    };
    return { next: j, edit };
  }
  if (newPath === '/dev/null' || isDelete) {
    const p = oldPath;
    const edit: Edit = (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
    return { next: j, edit };
  }
  const op = oldPath;
  const np = newPath;
  const edit: Edit = (tree) => {
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
    let st = parseFile(before);
    let d = 0;
    for (const h of hunks) {
      st = applyUnifiedHunk(st, h, d, strict, op);
      d += h.n.length - h.o.length;
    }
    const out = renderFile(st);
    if (op !== np) {
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.noteMove(op, np);
    } else {
      tree.now.set(op, out);
    }
  };
  return { next: j, edit };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isDiffGitLine(l)) {
      const [dx, dy] = parseDiffGit(l, i + 1);
      const s = parseUnifiedSection(lines, i, dx, dy, strict);
      edits.push(s.edit);
      i = s.next;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = parseUnifiedSection(lines, i, null, null, strict);
      edits.push(s.edit);
      i = s.next;
    } else {
      i++;
    }
  }
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = parseFile(before);
    const found = findTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const out = applyReplace(
      st.lines,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: -1 })),
      found.tier,
      found.at[0]!,
    );
    tree.now.set(path, renderFile({ lines: out, br: st.br, ends: st.ends }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevPath: string | null = null;
  let regionStart = 0;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k >= regionStart; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let k = searchLine + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let k = sep + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(makeSearchReplaceEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    regionStart = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: MappedLine[];
}

interface RawLine {
  no: number;
  text: string;
}

function parseVChunk(anchor: string | null, eof: boolean, body: RawLine[]): VChunk {
  const o: string[] = [];
  const n: MappedLine[] = [];
  for (const b of body) {
    const l = b.text;
    if (l === '') {
      const idx = o.length;
      o.push('');
      n.push({ text: '', ctx: idx });
    } else if (l[0] === ' ') {
      const idx = o.length;
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: idx });
    } else if (l[0] === '-') o.push(l.slice(1));
    else if (l[0] === '+') n.push({ text: l.slice(1), ctx: -1 });
    else throw new Exit2(`error: parse ${b.no}`);
  }
  return { anchor, eof, o, n };
}

function applyV4aChunk(st: FState, ch: VChunk, cursor: number, strict: boolean, path: string): { st: FState; cursor: number } {
  let cur = cursor;
  if (ch.anchor !== null && ch.anchor !== '') {
    const tiers: Tier[] = strict ? [0] : [0, 1, 2];
    let foundAt = -1;
    for (const t of tiers) {
      for (let k = cur; k < st.lines.length; k++) {
        if (lineEq(st.lines[k]!, ch.anchor, t)) {
          foundAt = k;
          break;
        }
      }
      if (foundAt >= 0) break;
    }
    if (foundAt < 0) throw new Fail('no-match', path);
    cur = foundAt + 1;
  }
  if (ch.o.length === 0) {
    const pos = ch.eof ? st.lines.length : cur;
    const out = [...st.lines.slice(0, pos), ...ch.n.map((ml) => ml.text), ...st.lines.slice(pos)];
    return { st: { lines: out, br: st.br, ends: st.ends }, cursor: pos + ch.n.length };
  }
  const found = findTier(st.lines, ch.o, strict, cur);
  if (found === null) throw new Fail('no-match', path);
  let pos = -1;
  for (const p of found.at) {
    if (ch.eof && p + ch.o.length !== st.lines.length) continue;
    pos = p;
    break;
  }
  if (pos < 0) throw new Fail('no-match', path);
  const out = applyReplace(st.lines, ch.o, ch.n, found.tier, pos);
  return { st: { lines: out, br: st.br, ends: st.ends }, cursor: pos + ch.n.length };
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i++;
      const raw: RawLine[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push({ no: i + 1, text: lines[i]! });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const added: string[] = [];
      for (const r of raw) {
        if (r.text === '') added.push('');
        else if (r.text[0] === '+') added.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, added.length === 0 ? '' : added.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i++;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      const raw: RawLine[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push({ no: i + 1, text: lines[i]! });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: RawLine[] } | null = null;
      let chunkOpened = false;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(parseVChunk(cur.anchor, cur.eof, cur.body));
          cur = null;
        }
      };
      while (idx < raw.length) {
        const r = raw[idx]!;
        if (r.text.startsWith('@@')) {
          closeChunk();
          cur = { anchor: r.text.slice(2).trim(), eof: false, body: [] };
          chunkOpened = true;
          idx++;
          continue;
        }
        if (r.text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          closeChunk();
          idx++;
          continue;
        }
        if (r.text.startsWith('***')) throw new Exit2(`error: parse ${r.no}`);
        if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
          if (cur === null) {
            if (chunkOpened) throw new Exit2(`error: parse ${r.no}`);
            cur = { anchor: null, eof: false, body: [] };
            chunkOpened = true;
          }
          cur.body.push(r);
          idx++;
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      const mv = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== null && mv !== p && tree.get(mv) !== null) throw new Fail('exists', mv);
        let st = parseFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          const r = applyV4aChunk(st, ch, cursor, strict, p);
          st = r.st;
          cursor = r.cursor;
        }
        const out = renderFile(st);
        if (mv !== null && mv !== p) {
          tree.now.set(p, null);
          tree.now.set(mv, out);
          tree.noteMove(p, mv);
        } else {
          tree.now.set(p, out);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---- Invocation, output and atomicity (SPEC.md sections 1, 2, 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const mv of tree.moves) {
    if (tree.original(mv.old) !== null && tree.now.get(mv.old) === null && tree.original(mv.new) === null && tree.now.get(mv.new) !== null) {
      const di = rows.findIndex((r) => r.key === mv.old && r.line.startsWith('D '));
      const ai = rows.findIndex((r) => r.key === mv.new && r.line.startsWith('A '));
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
