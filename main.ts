// mend: one patch tool for every AI edit format.
//
// Reads a patch (unified diff, SEARCH/REPLACE blocks, V4A, or JSON tool-call
// edits) and applies it to the tree in the working directory: every file or
// none. Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
// Node 22, standard library only. The contract lives in SPEC.md next to this
// file; this code follows it section by section.
//
// How it works: the patch is fully parsed first into a list of small edit
// functions (a parse fault anywhere stops everything before any file is read).
// Each edit function runs against an in-memory picture of the tree and either
// updates that picture or throws a failure naming its code and path; a failed
// edit is rolled back and the rest still run. Only when no edit failed are the
// changed files written to disk (unless --check).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** The patch cannot be read in its format; n is the 1-based patch line. */
class ParseFault {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit failed; code is one of no-match, ambiguous, missing, exists, unsafe. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

type EditFn = (tree: Tree, strict: boolean) => void;

const isBlank = (s: string): boolean => s.trim() === '';

/** Patch lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A file split into lines plus its own break style and whether it ends with one. */
interface FileText {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    lines.pop();
    fin = true;
  }
  return { lines, br, fin };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}

/** The tree as the edits leave it: `cur` overrides, the rest read from disk. */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly cur = new Map<string, string | null>();
  /** Successful move edits, as (old path, new path) pairs. */
  readonly moves: Array<[string, string]> = [];

  diskText(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.cur.has(p) ? this.cur.get(p)! : this.diskText(p);
  }

  set(p: string, v: string | null): void {
    this.cur.set(p, v);
  }
}

/** Line equality at one matching tier. */
function tierEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const ra = a.replace(/[ \t]+$/, '');
  const rb = b.replace(/[ \t]+$/, '');
  if (tier === 1) return ra === rb;
  return ra.replace(/^[ \t]+/, '') === rb.replace(/^[ \t]+/, '');
}

/** Every 0-based position where `pat` occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], pat: string[], tier: number, from = 0): number[] {
  const hits: number[] = [];
  if (pat.length === 0) return hits;
  for (let i = from; i + pat.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < pat.length; j += 1) {
      if (!tierEqual(lines[i + j]!, pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence. */
function firstTier(
  lines: string[],
  pat: string[],
  strict: boolean,
  from = 0,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, pat, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** One line of a replacement: context lines come from the file, the rest from the patch. */
interface NewLine {
  text: string;
  /** Index into the old lines when this is a context line, else null. */
  oldIdx: number | null;
}

/**
 * Render replacement lines. A context line is the file's own matched line.
 * At tier 2 a non-context line that starts with the old lines' leading
 * whitespace has that whitespace replaced by the file's.
 */
function renderNew(
  fresh: NewLine[],
  fileLines: string[],
  at: number,
  tier: number,
  oldLead: string,
): string[] {
  const fileLead = fileLines[at] === undefined ? '' : leadWs(fileLines[at]!);
  return fresh.map((e) => {
    if (e.oldIdx !== null) return fileLines[at + e.oldIdx]!;
    const ln = e.text;
    if (tier !== 2 || ln === '' || ln.trim() === '' || !ln.startsWith(oldLead)) return ln;
    return fileLead + ln.slice(oldLead.length);
  });
}

/** Detect the patch format; null when none of the rules holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let k = 0; k < lines.length; k += 1) {
    if (lines[k]!.startsWith('diff --git ')) return 'unified';
    if (lines[k]!.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function jsonEdit(value: unknown, lineNo: number): EditFn {
  const fault = (): never => {
    throw new ParseFault(lineNo);
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fault();
  const o = value as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') fault();

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') fault();
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.set(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') fault();
    if (o.new_str !== undefined && typeof o.new_str !== 'string') fault();
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      const cur = tree.get(p);
      if (cur === null) throw new EditFault('missing', p);
      const nl = cur.indexOf('\n');
      const crlf = nl > 0 && cur[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(cur);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) fault();
    if (typeof o.new_str !== 'string') fault();
    const lineNo2 = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      const cur = tree.get(p);
      if (cur === null) throw new EditFault('missing', p);
      const f = splitFile(cur);
      if (lineNo2 < 0 || lineNo2 > f.lines.length) throw new EditFault('no-match', p);
      f.lines.splice(lineNo2, 0, ...add);
      tree.set(p, joinFile(f));
    };
  }

  return fault();
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) edits.push(jsonEdit(x, first + 1));
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      throw new ParseFault(idx + 1);
    }
    edits.push(jsonEdit(v, idx + 1));
  });
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): EditFn {
  return (tree, strict) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    const f = splitFile(cur);
    const found = firstTier(f.lines, oldLines, strict);
    if (found === null) throw new EditFault('no-match', path);
    if (found.at.length > 1) throw new EditFault('ambiguous', path);
    const at = found.at[0]!;
    const fresh: NewLine[] = newLines.map((t) => ({ text: t, oldIdx: null }));
    const rendered = renderNew(fresh, f.lines, at, found.tier, leadWs(oldLines[0]!));
    f.lines.splice(at, oldLines.length, ...rendered);
    tree.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[]): EditFn[] {
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const isSep = (l: string): boolean => l.trimEnd() === '=======';
  const isEnd = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';
  const edits: EditFn[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isSearch(lines[i]!)) {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(searchAt + 1);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (isSearch(lines[j]!)) throw new ParseFault(searchAt + 1);
      if (isSep(lines[j]!)) {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new ParseFault(searchAt + 1);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (isSearch(lines[j]!)) throw new ParseFault(searchAt + 1);
      if (isEnd(lines[j]!)) {
        end = j;
        break;
      }
    }
    if (end < 0) throw new ParseFault(searchAt + 1);
    edits.push(searchReplaceEdit(path, lines.slice(searchAt + 1, sep), lines.slice(sep + 1, end)));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface BodyItem {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface RawHunk {
  a: number;
  items: BodyItem[];
}

interface RawSection {
  oldP: string | null;
  newP: string | null;
  renameOld: string | null;
  renameNew: string | null;
  create: boolean;
  del: boolean;
  hunks: RawHunk[];
}

/** Split a hunk body into its old lines and its new lines (with context marks). */
function hunkOldNew(h: RawHunk): { oldLines: string[]; fresh: NewLine[] } {
  const oldLines: string[] = [];
  const fresh: NewLine[] = [];
  for (const it of h.items) {
    if (it.kind === ' ') {
      fresh.push({ text: it.text, oldIdx: oldLines.length });
      oldLines.push(it.text);
    } else if (it.kind === '-') {
      oldLines.push(it.text);
    } else if (it.kind === '+') {
      fresh.push({ text: it.text, oldIdx: null });
    }
  }
  return { oldLines, fresh };
}

/** True when a `\` line immediately follows the hunk's last context or `+` line. */
function hunkNoEol(h: RawHunk): boolean {
  let last = -1;
  h.items.forEach((it, idx) => {
    if (it.kind === ' ' || it.kind === '+') last = idx;
  });
  return last >= 0 && h.items[last + 1]?.kind === '\\';
}

/** True when a `\` line immediately follows the hunk's last `+` line. */
function hunkPlusNoEol(h: RawHunk): boolean {
  let last = -1;
  h.items.forEach((it, idx) => {
    if (it.kind === '+') last = idx;
  });
  return last >= 0 && h.items[last + 1]?.kind === '\\';
}

function hunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m === null ? null : Number(m[1]);
}

function stripPath(raw: string): string {
  let p = raw;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  return raw === '/dev/null' ? '' : stripPath(raw);
}

function parseUnified(lines: string[]): EditFn[] {
  const sections: RawSection[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    let sec: RawSection | null = null;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      sec = { oldP: m[1]!, newP: m[2]!, renameOld: null, renameNew: null, create: false, del: false, hunks: [] };
      sections.push(sec);
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldP: null, newP: null, renameOld: null, renameNew: null, create: false, del: false, hunks: [] };
      sec.oldP = headerPath(line) === '' ? null : headerPath(line);
      sec.newP = headerPath(lines[i + 1]!) === '' ? null : headerPath(lines[i + 1]!);
      sections.push(sec);
      i += 2;
    } else if (line.startsWith('@@')) {
      throw new ParseFault(i + 1);
    } else {
      i += 1;
      continue;
    }
    // Header lines, then hunks, until the next section starts.
    let inHeader = true;
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (!inHeader && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith('@@')) {
        const a = hunkHeader(l);
        if (a === null) throw new ParseFault(i + 1);
        inHeader = false;
        i += 1;
        const items: BodyItem[] = [];
        while (i < n) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
            items.push({ kind: (b === '' ? ' ' : (b[0] as BodyItem['kind'])), text: b === '' ? '' : b.slice(1) });
            i += 1;
          } else break;
        }
        while (items.length > 0 && items[items.length - 1]!.kind === ' ' && items[items.length - 1]!.text === '') items.pop();
        sec.hunks.push({ a, items });
        continue;
      }
      if (!inHeader) {
        i += 1;
        continue;
      }
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new ParseFault(i + 2);
        sec.oldP = headerPath(l) === '' ? null : headerPath(l);
        sec.newP = headerPath(lines[i + 1]!) === '' ? null : headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) sec.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.create = true;
      else if (l.startsWith('deleted file mode')) sec.del = true;
      i += 1;
    }
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => unifiedEdit(s));
}

/** Apply one section's hunks to a file's text; returns the new text. */
function applyHunks(text: string, hunks: RawHunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { oldLines, fresh } = hunkOldNew(h);
    if (oldLines.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, f.lines.length));
      const rendered = renderNew(fresh, f.lines, at, 0, '');
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...rendered);
      if (atEnd) f.fin = !hunkNoEol(h);
      d += fresh.length;
      continue;
    }
    const found = firstTier(f.lines, oldLines, strict);
    if (found === null) throw new EditFault('no-match', path);
    const target = h.a - 1 + d;
    let best = found.at[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.at) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const rendered = renderNew(fresh, f.lines, best, found.tier, leadWs(oldLines[0]!));
    const runsToEnd = best + oldLines.length === f.lines.length;
    f.lines.splice(best, oldLines.length, ...rendered);
    if (runsToEnd) f.fin = !hunkNoEol(h);
    d += fresh.length - oldLines.length;
  }
  return joinFile(f);
}

function unifiedEdit(s: RawSection): EditFn {
  const oldP = s.oldP ?? s.renameOld ?? null;
  const newP = s.newP ?? s.renameNew ?? null;
  const isCreate = s.create || oldP === null;
  const isDelete = !isCreate && (s.del || newP === null);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree, strict) => {
    if (isCreate) {
      const p = newP ?? '';
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const it of h.items) if (it.kind === '+') plus.push(it.text);
      let fin = true;
      for (let k = s.hunks.length - 1; k >= 0; k -= 1) {
        const h = s.hunks[k]!;
        if (h.items.some((it) => it.kind === '+')) {
          fin = !hunkPlusNoEol(h);
          break;
        }
      }
      tree.set(p, plus.length === 0 ? '' : `${plus.join('\n')}${fin ? '\n' : ''}`);
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) === null) throw new EditFault('missing', p);
      tree.set(p, null);
      return;
    }
    if (isMove) {
      const from = oldP!;
      const to = newP!;
      if (!isSafePath(from)) throw new EditFault('unsafe', from);
      if (!isSafePath(to)) throw new EditFault('unsafe', to);
      const cur = tree.get(from);
      if (cur === null) throw new EditFault('missing', from);
      if (tree.get(to) !== null) throw new EditFault('exists', to);
      tree.set(from, null);
      tree.set(to, applyHunks(cur, s.hunks, strict, from));
      tree.moves.push([from, to]);
      return;
    }
    const p = oldP!;
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new EditFault('missing', p);
    tree.set(p, applyHunks(cur, s.hunks, strict, p));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function chunkOldNew(c: V4aChunk): { oldLines: string[]; fresh: NewLine[] } {
  const oldLines: string[] = [];
  const fresh: NewLine[] = [];
  for (const it of c.items) {
    if (it.kind === ' ') {
      fresh.push({ text: it.text, oldIdx: oldLines.length });
      oldLines.push(it.text);
    } else if (it.kind === '-') {
      oldLines.push(it.text);
    } else if (it.kind === '+') {
      fresh.push({ text: it.text, oldIdx: null });
    }
  }
  return { oldLines, fresh };
}

function v4aAddEdit(path: string, bodyLines: string[]): EditFn {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) !== null) throw new EditFault('exists', path);
    tree.set(path, bodyLines.length === 0 ? '' : `${bodyLines.join('\n')}\n`);
  };
}

function v4aDeleteEdit(path: string): EditFn {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) === null) throw new EditFault('missing', path);
    tree.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[]): EditFn {
  return (tree, strict) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const anchorAt = firstTier(f.lines, [ch.anchor], strict, cursor);
        if (anchorAt === null) throw new EditFault('no-match', path);
        cursor = anchorAt.at[0]! + 1;
      }
      const { oldLines, fresh } = chunkOldNew(ch);
      if (oldLines.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const rendered = renderNew(fresh, f.lines, at, 0, '');
        f.lines.splice(at, 0, ...rendered);
        cursor = at + rendered.length;
        continue;
      }
      const found = firstTier(f.lines, oldLines, strict, cursor);
      if (found === null) throw new EditFault('no-match', path);
      let at: number | null = null;
      for (const p of found.at) {
        if (ch.eof && p + oldLines.length !== f.lines.length) continue;
        at = p;
        break;
      }
      if (at === null) throw new EditFault('no-match', path);
      const rendered = renderNew(fresh, f.lines, at, found.tier, leadWs(oldLines[0]!));
      f.lines.splice(at, oldLines.length, ...rendered);
      cursor = at + rendered.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.set(path, out);
    }
  };
}

function parseV4a(lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const sectionAt = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const sectionPath = (l: string, kind: 'add' | 'delete' | 'update'): string => {
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    return l.slice(prefix.length).trim();
  };
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const kind = sectionAt(line);
    if (kind === null) throw new ParseFault(i + 1);
    const path = sectionPath(line, kind);
    const startLine = i + 1;
    i += 1;
    const raw: string[] = [];
    while (i < last && sectionAt(lines[i]!) === null) {
      raw.push(lines[i]!);
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const bodyLines: string[] = [];
      raw.forEach((l, idx) => {
        if (l === '') bodyLines.push('');
        else if (l.startsWith('+')) bodyLines.push(l.slice(1));
        else throw new ParseFault(startLine + idx);
      });
      edits.push(v4aAddEdit(path, bodyLines));
    } else if (kind === 'delete') {
      raw.forEach((l, idx) => {
        if (!isBlank(l)) throw new ParseFault(startLine + idx);
      });
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let rest = raw;
      if (rest.length > 0 && rest[0]!.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let closed = false;
      rest.forEach((l, idx) => {
        const no = startLine + (raw.length - rest.length) + idx;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), eof: false, items: [] };
          chunks.push(cur);
          closed = false;
          return;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new ParseFault(no);
          cur.eof = true;
          cur = null;
          closed = true;
          return;
        }
        if (l.startsWith('*** Move to: ')) throw new ParseFault(no);
        if (l.startsWith('*** ')) throw new ParseFault(no);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0 || closed) throw new ParseFault(no);
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          cur.items.push({ kind: (l === '' ? ' ' : (l[0] as BodyItem['kind'])), text: l === '' ? '' : l.slice(1) });
          return;
        }
        throw new ParseFault(no);
      });
      chunks.forEach((c) => {
        while (c.items.length > 0 && c.items[c.items.length - 1]!.kind === ' ' && c.items[c.items.length - 1]!.text === '') c.items.pop();
      });
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(startLine);
      edits.push(v4aUpdateEdit(path, moveTo, chunks));
    }
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Command line, output, and the trial hand-over (SPEC sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function runCli(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.cur);
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.cur.clear();
      for (const [k, v] of snap) tree.cur.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const moved = tree.moves.filter(
    ([o, nw]) => tree.diskText(o) !== null && tree.get(o) === null && tree.diskText(nw) === null && tree.get(nw) !== null,
  );
  const movedOld = new Set(moved.map(([o]) => o));
  const movedNew = new Set(moved.map(([, nw]) => nw));
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.cur.keys()) {
    const was = tree.diskText(p);
    const now = tree.get(p);
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, nw] of moved) rows.push({ key: nw, line: `R ${o} -> ${nw}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of tree.cur.keys()) {
      const was = tree.diskText(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialUrl = process.env.MAKEFUN_ENV_URL;
if (trialUrl !== undefined && trialUrl !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable set.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialUrl);
} else {
  const result = runCli(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
