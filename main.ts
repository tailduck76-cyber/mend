// mend — one patch tool for every AI edit format.
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
// Implements SPEC.md v1: unified diff, SEARCH/REPLACE, V4A, JSON edits,
// three-tier line matching, atomic all-or-nothing writes.
// In a trial (MAKEFUN_ENV_URL set) hands over to runner.ts — keep that.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

const isBlank = (s: string): boolean => s.trim() === '';

// Patch lines: split at \n, strip one trailing \r each, drop the empty
// piece after a final \n. Line numbers count these from 1.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---- file state: lines + own line break + final break (SPEC 3) ----
interface FileState { lines: string[]; br: string; finalBreak: boolean; }

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

// ---- three-tier matching (SPEC 5) ----
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  const want = old.map((l) => normLine(l, tier));
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], old: string[], from: number, maxTier: number): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(lines, old, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function findSingle(lines: string[], anchor: string, from: number, maxTier: number): number | null {
  for (let t = 0; t <= maxTier; t++) {
    const a = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === a) return i;
    }
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// One line of N: ctx = index into O (context line, written as the file's
// own matched line); otherwise an added line, re-indented at tier 2.
interface NItem { text: string; ctx: number | null; }

function applyReplace(fs: FileState, pos: number, old: string[], items: NItem[], tier: number): FileState {
  const out = fs.lines.slice(0, pos);
  const fileLead = old.length > 0 ? leadingWs(fs.lines[pos]!) : '';
  const patchLead = old.length > 0 ? leadingWs(old[0]!) : '';
  for (const it of items) {
    if (it.ctx !== null) {
      out.push(fs.lines[pos + it.ctx]!);
    } else if (tier === 2 && old.length > 0) {
      const t = it.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(patchLead)) out.push(fileLead + t.slice(patchLead.length));
      else out.push(t);
    } else {
      out.push(it.text);
    }
  }
  out.push(...fs.lines.slice(pos + old.length));
  return { lines: out, br: fs.br, finalBreak: fs.finalBreak };
}

// ---- tree: edits see earlier edits, writes happen only at the end ----
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(old: string, nw: string, text: string): void {
    this.now.set(old, null);
    this.now.set(nw, text);
    this.moves.push({ old, nw });
  }
}

type Edit = (tree: Tree) => void;

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (SPEC 9) ----
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const mustExist = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' &&
      (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) &&
      typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = mustExist(tree);
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
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC 6) ----
interface HunkElem { kind: 'ctx' | 'del' | 'add'; text: string; bs: boolean; rawEmpty?: boolean; }
interface Hunk { a: number; elems: HunkElem[]; }
interface UniSection { oldPath: string | null; newPath: string | null; isNew: boolean; isDel: boolean; hunks: Hunk[]; }

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;
const GIT_RE = /^diff --git a\/(.*?) b\/(.+)$/;

function dashPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}
function stripAB(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

interface UniDraft {
  gitOld: string | null; gitNew: string | null;
  dashOld?: string | null; dashNew?: string | null;
  renameFrom?: string; renameTo?: string;
  isNew: boolean; isDel: boolean; hunks: Hunk[];
}

function resolveUni(d: UniDraft): UniSection {
  let oldP: string | null;
  let newP: string | null;
  if (d.dashOld !== undefined) { oldP = d.dashOld; newP = d.dashNew ?? null; }
  else if (d.renameFrom !== undefined || d.renameTo !== undefined) { oldP = d.renameFrom ?? d.gitOld; newP = d.renameTo ?? d.gitNew; }
  else { oldP = d.gitOld; newP = d.gitNew; }
  return { oldPath: oldP, newPath: newP, isNew: d.isNew, isDel: d.isDel, hunks: d.hunks };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniDraft | null = null;
  let body: Hunk | null = null;

  const endBody = (): void => {
    if (body !== null && cur !== null) {
      const e = body.elems;
      // Empty lines at the end of a body are not part of it — but only
      // truly empty raw lines, not ' ' context lines with empty text.
      while (e.length > 0 && e[e.length - 1]!.kind === 'ctx' && e[e.length - 1]!.text === '' && e[e.length - 1]!.rawEmpty === true) e.pop();
      cur.hunks.push(body);
    }
    body = null;
  };
  const endSection = (): void => {
    if (cur !== null) { endBody(); sections.push(resolveUni(cur)); cur = null; }
  };
  const startGitSection = (line: string, idx: number): void => {
    const m = GIT_RE.exec(line);
    if (m === null || m[1] === '' || m[2] === '') throw new Exit2(`error: parse ${idx + 1}`);
    endSection();
    cur = { gitOld: m[1]!, gitNew: m[2]!, isNew: false, isDel: false, hunks: [] };
  };
  const startDashSection = (idx: number): void => {
    const oldP = stripAB(dashPath(lines[idx]!));
    const newP = stripAB(dashPath(lines[idx + 1]!));
    if (cur !== null && cur.dashOld === undefined && cur.hunks.length === 0 && body === null) {
      cur.dashOld = oldP; cur.dashNew = newP;
    } else {
      endSection();
      cur = { gitOld: null, gitNew: null, dashOld: oldP, dashNew: newP, isNew: false, isDel: false, hunks: [] };
    }
  };
  const startHunk = (line: string, idx: number): void => {
    if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
    const m = HUNK_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
    endBody();
    body = { a: Number(m[1]), elems: [] };
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) { startGitSection(line, i); i++; continue; }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) { startDashSection(i); i += 2; continue; }
    if (line.startsWith('@@')) { startHunk(line, i); i++; continue; }
    if (body !== null) {
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
        const kind = line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'del' : 'add';
        body.elems.push({ kind, text: line === '' ? '' : line.slice(1), bs: false, rawEmpty: line === '' });
        i++; continue;
      }
      if (line[0] === '\\') {
        const e = body.elems[body.elems.length - 1];
        if (e !== undefined) e.bs = true;
        i++; continue;
      }
      endBody();
      continue; // reprocess this line outside the body
    }
    if (cur !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
      i++; continue;
    }
    i++; // prose outside any section
  }
  endSection();
  return sections;
}

function hunkON(h: Hunk): { o: string[]; items: NItem[] } {
  const o: string[] = [];
  const items: NItem[] = [];
  for (const e of h.elems) {
    if (e.kind === 'ctx') { items.push({ text: e.text, ctx: o.length }); o.push(e.text); }
    else if (e.kind === 'del') { o.push(e.text); }
    else { items.push({ text: e.text, ctx: null }); }
  }
  return { o, items };
}

function lastCtxOrPlusBs(h: Hunk): boolean {
  for (let i = h.elems.length - 1; i >= 0; i--) {
    const e = h.elems[i]!;
    if (e.kind === 'ctx' || e.kind === 'add') return e.bs;
  }
  return false;
}

function applyHunks(before: string, hunks: Hunk[], maxTier: number, path: string): string {
  let fs = parseFile(before);
  let d = 0;
  for (const h of hunks) {
    const { o, items } = hunkON(h);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > fs.lines.length) pos = fs.lines.length;
      const nfs = applyReplace(fs, pos, o, items, 0);
      if (pos === fs.lines.length) nfs.finalBreak = !lastCtxOrPlusBs(h);
      fs = nfs;
      d += items.length;
    } else {
      const found = findTier(fs.lines, o, 0, maxTier);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const nfs = applyReplace(fs, best, o, items, found.tier);
      if (best + o.length === fs.lines.length) nfs.finalBreak = !lastCtxOrPlusBs(h);
      fs = nfs;
      d += items.length - o.length;
    }
  }
  return renderFile(fs);
}

function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  const maxTier = strict ? 0 : 2;
  return (tree) => {
    if (sec.isNew || sec.oldPath === null) {
      const np = sec.newPath;
      if (np === null) return;
      if (!safePath(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const e of h.elems) if (e.kind === 'add') plus.push(e.text);
      let noNl = false;
      outer: for (let i = sec.hunks.length - 1; i >= 0; i--) {
        for (let j = sec.hunks[i]!.elems.length - 1; j >= 0; j--) {
          const e = sec.hunks[i]!.elems[j]!;
          if (e.kind === 'add') { noNl = e.bs; break outer; }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (sec.isDel || sec.newPath === null) {
      const op = sec.oldPath!;
      if (!safePath(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = sec.oldPath!;
    const np = sec.newPath!;
    if (!safePath(op)) throw new Fail('unsafe', op);
    if (!safePath(np)) throw new Fail('unsafe', np);
    if (op !== np) {
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      tree.move(op, np, applyHunks(tree.get(op)!, sec.hunks, maxTier, op));
      return;
    }
    if (tree.get(op) === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(tree.get(op)!, sec.hunks, maxTier, op));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => uniSectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC 7) ----
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const maxTier = strict ? 0 : 2;
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fs = parseFile(before);
    const found = findTier(fs.lines, oldLines, 0, maxTier);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const items: NItem[] = newLines.map((t) => ({ text: t, ctx: null }));
    tree.now.set(path, renderFile(applyReplace(fs, found.occ[0]!, oldLines, items, found.tier)));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i;
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC 8) ----
interface VChunk { anchor: string | null; elems: HunkElem[]; eof: boolean; }
interface VSection { kind: 'add' | 'delete' | 'update'; path: string; moveTo: string | null; chunks: VChunk[]; lines: string[]; }

function chunkON(ch: VChunk): { o: string[]; items: NItem[] } {
  return hunkON({ a: 0, elems: ch.elems });
}

function vSectionEdit(sec: VSection, strict: boolean): Edit {
  const maxTier = strict ? 0 : 2;
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safePath(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safePath(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safePath(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safePath(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let fs = parseFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findSingle(fs.lines, ch.anchor, cursor, maxTier);
        if (at === null) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const { o, items } = chunkON(ch);
      if (o.length === 0) {
        const pos = ch.eof ? fs.lines.length : cursor;
        fs = applyReplace(fs, pos, o, items, 0);
        cursor = pos + items.length;
      } else {
        const found = findTier(fs.lines, o, cursor, maxTier);
        if (found === null) throw new Fail('no-match', sec.path);
        let pos: number | null = null;
        if (ch.eof) {
          for (const p of found.occ) {
            if (p + o.length === fs.lines.length) { pos = p; break; }
          }
          if (pos === null) throw new Fail('no-match', sec.path);
        } else {
          pos = found.occ[0]!;
        }
        fs = applyReplace(fs, pos, o, items, found.tier);
        cursor = pos + items.length;
      }
    }
    const text = renderFile(fs);
    if (sec.moveTo !== null) tree.move(sec.path, sec.moveTo, text);
    else tree.now.set(sec.path, text);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) { last = i; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) { i++; continue; }
    let kind: 'add' | 'delete' | 'update';
    let prefix: string;
    if (line.startsWith('*** Add File: ')) { kind = 'add'; prefix = '*** Add File: '; }
    else if (line.startsWith('*** Delete File: ')) { kind = 'delete'; prefix = '*** Delete File: '; }
    else if (line.startsWith('*** Update File: ')) { kind = 'update'; prefix = '*** Update File: '; }
    else throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(prefix.length).trim();
    const sec: VSection = { kind, path, moveTo: null, chunks: [], lines: [] };
    const secLine = i;
    i++;
    if (kind === 'add') {
      const collected: Array<{ text: string; plus: boolean }> = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l.startsWith('+')) collected.push({ text: l.slice(1), plus: true });
        else if (isBlank(l)) collected.push({ text: '', plus: false });
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (collected.length > 0 && !collected[collected.length - 1]!.plus) collected.pop();
      sec.lines = collected.map((c) => c.text);
      edits.push(vSectionEdit(sec, strict));
      continue;
    }
    if (kind === 'delete') {
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (!isBlank(l)) throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      edits.push(vSectionEdit(sec, strict));
      continue;
    }
    let chunk: VChunk | null = null;
    let state: 'start' | 'body' | 'afterEof' = 'start';
    const endChunk = (eof: boolean): void => {
      if (chunk !== null) { chunk.eof = eof; sec.chunks.push(chunk); chunk = null; }
    };
    const startChunk = (anchor: string | null): void => {
      chunk = { anchor, elems: [], eof: false };
      state = 'body';
    };
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      if (state === 'start') {
        if (isBlank(l)) { i++; continue; }
        if (l.startsWith('*** Move to: ')) { sec.moveTo = l.slice('*** Move to: '.length).trim(); i++; continue; }
        if (l.startsWith('@@')) { startChunk(l.slice(2).trim() === '' ? null : l.slice(2).trim()); i++; continue; }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') { startChunk(null); continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (state === 'afterEof') {
        if (isBlank(l)) { i++; continue; }
        if (l.startsWith('@@')) { startChunk(l.slice(2).trim() === '' ? null : l.slice(2).trim()); i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (l.startsWith('@@')) { endChunk(false); startChunk(l.slice(2).trim() === '' ? null : l.slice(2).trim()); i++; continue; }
      if (l === '*** End of File' || l.startsWith('*** End of File ')) { endChunk(true); state = 'afterEof'; i++; continue; }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        const k2 = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'del' : 'add';
        chunk!.elems.push({ kind: k2, text: l === '' ? '' : l.slice(1), bs: false });
        i++; continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (state === 'body' && chunk !== null) {
      const e = chunk.elems;
      while (e.length > 0 && e[e.length - 1]!.kind === 'ctx' && e[e.length - 1]!.text === '') e.pop();
      endChunk(false);
    }
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${secLine + 1}`);
    edits.push(vSectionEdit(sec, strict));
  }
  return edits;
}

// ---- driver (SPEC 1, 2, 10) ----
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
  try { text = readFileSync(file ?? 0, 'utf8'); } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.slice();
    try { edit(tree); } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const moved = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const wasNew = tree.original(m.nw);
    const nowOld = tree.now.get(m.old);
    const nowNew = tree.now.get(m.nw);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null && nowNew !== undefined) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      moved.add(m.old);
      moved.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
