// mend: applies the edits an AI model wrote (unified diff, SEARCH/REPLACE, V4A, JSON tool calls) to a tree of text files,
// all or nothing. Written against SPEC.md (version 1); section numbers in the comments refer to it.
// Node 22+, the standard library alone. Run as `node main.ts [options] [PATCH]`.
// In a trial the grader sets MAKEFUN_ENV_URL and this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------------------------------------------
// Basic types

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A run that ends at once with a single line and exit 2 (section 2). */
class Exit2 extends Error {
  get line(): string {
    return this.message;
  }
}
/** A failed edit (section 2 codes). */
class Fail extends Error {
  code = '';
  path = '';
  static of(code: string, path: string): Fail {
    const f = new Fail(`${code} ${path}`);
    f.code = code;
    f.path = path;
    return f;
  }
}

/** Section 3: a safe path. */
function isSafe(p: string): boolean {
  if (p === '' || p[0] === '/' || p.indexOf('\\') >= 0) return false;
  for (const seg of p.split('/')) if (seg === '' || seg === '.' || seg === '..') return false;
  return true;
}

/** Section 3: patch lines. Split at LF, one trailing CR removed from each, no empty piece after a final LF. */
function splitPatch(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  while (from < text.length) {
    let to = text.indexOf('\n', from);
    if (to < 0) to = text.length;
    out.push(text.slice(from, to > from && text[to - 1] === '\r' ? to - 1 : to));
    from = to + 1;
  }
  return out;
}

const isBlank = (s: string): boolean => s.trim() === '';

// ---------------------------------------------------------------------------------------------------------------
// The tree and file text

class Overlay {
  private readonly seen = new Map<string, string | null>();
  readonly staged = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  /** The file as it is on disk (null: no such file). */
  onDisk(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p) as string | null;
  }
  /** The file as the edits so far leave it. */
  read(p: string): string | null {
    return this.staged.has(p) ? (this.staged.get(p) as string | null) : this.onDisk(p);
  }
  commit(writes: Array<[string, string | null]>): void {
    for (const [p, v] of writes) this.staged.set(p, v);
  }
}

type Edit = (tree: Overlay) => void;

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

/** Section 3: a file's line break, lines and whether it ends with a line break. */
function splitFile(text: string): FileText {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

/** A file an edit creates: LF breaks, a final one (unless `final` is false). */
function createdText(lines: string[], final = true): string {
  return lines.length === 0 ? '' : lines.join('\n') + (final ? '\n' : '');
}

// ---------------------------------------------------------------------------------------------------------------
// Section 5: matching lines

const TIERS: Array<(s: string) => string> = [(s) => s, (s) => s.replace(/[ \t]+$/, ''), (s) => s.replace(/^[ \t]+|[ \t]+$/g, '')];

interface Found {
  tier: number;
  at: number[];
}

/** Occurrences of `old` in `file` at the first tier that has an acceptable one (`ok` filters positions). */
function findLines(file: string[], old: string[], strict: boolean, ok: (i: number) => boolean = () => true): Found | null {
  const last = file.length - old.length;
  for (let tier = 0; tier < (strict ? 1 : 3); tier += 1) {
    const f = TIERS[tier]!;
    const want = old.map(f);
    const have = tier === 0 ? file : file.map(f);
    const at: number[] = [];
    for (let i = 0; i <= last; i += 1) {
      if (!ok(i)) continue;
      let k = 0;
      while (k < want.length && have[i + k] === want[k]) k += 1;
      if (k === want.length) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** A line of a hunk, chunk or block: context (' '), old ('-') or new ('+'). */
interface Item {
  k: ' ' | '-' | '+';
  s: string;
}

const lead = (s: string): string => /^[ \t]*/.exec(s)![0];

/** The new lines N that replace the lines matched at `pos` (section 5). */
function newLines(items: Item[], file: string[], pos: number, tier: number): string[] {
  const old = items.filter((x) => x.k !== '+');
  const out: string[] = [];
  let seen = 0;
  const fromFile = lead(file[pos] ?? '');
  const fromPatch = old.length > 0 ? lead(old[0]!.s) : '';
  for (const x of items) {
    if (x.k === '-') {
      seen += 1;
    } else if (x.k === ' ') {
      out.push(file[pos + seen]!);
      seen += 1;
    } else if (tier === 2 && !isBlank(x.s) && x.s.startsWith(fromPatch)) {
      out.push(fromFile + x.s.slice(fromPatch.length));
    } else {
      out.push(x.s);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Section 6: unified diffs

interface Hunk {
  a: number;
  body: Array<{ t: string; s: string; empty: boolean }>;
}

interface USection {
  line: number;
  gitOld: string | null;
  gitNew: string | null;
  pair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** The path of a `---` / `+++` line (null: /dev/null). */
function pairPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseUnified(lines: string[]): Edit[] {
  const n = lines.length;
  const secs: USection[] = [];
  let cur: USection | null = null;
  let header = false;
  const isPair = (k: number): boolean => (lines[k] ?? '').startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ');
  const fresh = (line: number): USection => ({ line, gitOld: null, gitNew: null, pair: false, pairOld: null, pairNew: null, renFrom: null, renTo: null, newFile: false, deletedFile: false, hunks: [] });
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice(11);
      const cand: number[] = [];
      if (rest.startsWith('a/')) for (let k = rest.indexOf(' b/', 2); k >= 0; k = rest.indexOf(' b/', k + 1)) cand.push(k);
      const good = cand.filter((k) => k > 2 && k + 3 < rest.length);
      if (good.length === 0) throw new Exit2(`error: parse ${i + 1}`);
      const k = good.find((c) => rest.slice(2, c) === rest.slice(c + 3)) ?? good[0]!;
      cur = fresh(i + 1);
      cur.gitOld = rest.slice(2, k);
      cur.gitNew = rest.slice(k + 3);
      secs.push(cur);
      header = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEADER.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      header = false;
      const body: Hunk['body'] = [];
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || isPair(j)) break;
        const c = b[0];
        if (b === '') body.push({ t: ' ', s: '', empty: true });
        else if (c === ' ' || c === '-' || c === '+' || c === '\\') body.push({ t: c, s: b.slice(1), empty: false });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (isPair(i)) {
      if (cur === null || !header || cur.pair) {
        cur = fresh(i + 1);
        secs.push(cur);
        header = true;
      }
      cur.pair = true;
      cur.pairOld = pairPath(l);
      cur.pairNew = pairPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (header && cur !== null) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renFrom = l.slice(12);
      else if (l.startsWith('rename to ')) cur.renTo = l.slice(10);
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  return secs.map(unifiedEdit);
}

/** Does a `\` line directly follow the last context or `+` line of the body? */
function noFinalBreak(body: Hunk['body']): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.t === ' ' || body[k]!.t === '+') return body[k + 1]?.t === '\\';
  }
  return false;
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  const lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const items: Item[] = [];
    for (const b of h.body) if (b.t === ' ' || b.t === '-' || b.t === '+') items.push({ k: b.t, s: b.s });
    const old = items.filter((x) => x.k !== '+');
    const added = items.filter((x) => x.k !== '-').length;
    let pos: number;
    let repl: string[];
    if (old.length === 0) {
      pos = Math.min(Math.max(h.a + d, 0), lines.length);
      repl = items.filter((x) => x.k === '+').map((x) => x.s);
    } else {
      const r = findLines(lines, old.map((x) => x.s), strict);
      if (r === null) throw Fail.of('no-match', path);
      const target = h.a - 1 + d;
      pos = r.at[0]!;
      for (const c of r.at) if (Math.abs(c - target) < Math.abs(pos - target)) pos = c;
      repl = newLines(items, lines, pos, r.tier);
    }
    if (pos + old.length === lines.length) final = !noFinalBreak(h.body);
    lines.splice(pos, old.length, ...repl);
    d += added - old.length;
  }
  return joinFile(lines, f.br, final);
}

function unifiedEdit(sec: USection): Edit {
  let o: string | null;
  let nw: string | null;
  if (sec.pair) {
    o = sec.pairOld;
    nw = sec.pairNew;
  } else {
    o = sec.renFrom ?? sec.gitOld;
    nw = sec.renTo ?? sec.gitNew;
  }
  const creation = o === null || sec.newFile;
  const deletion = !creation && (nw === null || sec.deletedFile);
  if ((creation && (nw ?? o) === null) || (deletion && (o ?? nw) === null)) throw new Exit2(`error: parse ${sec.line}`);
  return (tree) => {
    if (creation) {
      const p = (nw ?? o) as string;
      if (!isSafe(p)) throw Fail.of('unsafe', p);
      if (tree.read(p) !== null) throw Fail.of('exists', p);
      const plus: string[] = [];
      let lastPlus = false;
      for (const h of sec.hunks) {
        h.body.forEach((b, k) => {
          if (b.t === '+') {
            plus.push(b.s);
            lastPlus = h.body[k + 1]?.t === '\\';
          }
        });
      }
      tree.commit([[p, createdText(plus, !lastPlus)]]);
      return;
    }
    if (deletion) {
      const p = (o ?? nw) as string;
      if (!isSafe(p)) throw Fail.of('unsafe', p);
      if (tree.read(p) === null) throw Fail.of('missing', p);
      tree.commit([[p, null]]);
      return;
    }
    const from = (o ?? nw) as string;
    const to = nw ?? from;
    const move = from !== to;
    if (!isSafe(from)) throw Fail.of('unsafe', from);
    if (move && !isSafe(to)) throw Fail.of('unsafe', to);
    const src = tree.read(from);
    if (src === null) throw Fail.of('missing', from);
    if (move && tree.read(to) !== null) throw Fail.of('exists', to);
    const out = applyHunks(src, sec.hunks, strictMode, from);
    if (move) {
      tree.commit([[to, out], [from, null]]);
      tree.moves.push([from, to]);
    } else tree.commit([[from, out]]);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    path = path ?? prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let e = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        e = k;
        break;
      }
    }
    let r = -1;
    if (e >= 0) {
      for (let k = e + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          r = k;
          break;
        }
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, e), lines.slice(e + 1, r)));
    prevEnd = r;
    prevPath = path;
    i = r + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, old: string[], nw: string[]): Edit {
  return (tree) => {
    if (!isSafe(path)) throw Fail.of('unsafe', path);
    const src = tree.read(path);
    if (old.length === 0) {
      if (src !== null) throw Fail.of('exists', path);
      tree.commit([[path, createdText(nw)]]);
      return;
    }
    if (src === null) throw Fail.of('missing', path);
    const f = splitFile(src);
    const r = findLines(f.lines, old, strictMode);
    if (r === null) throw Fail.of('no-match', path);
    if (r.at.length > 1) throw Fail.of('ambiguous', path);
    const items: Item[] = [...old.map((s): Item => ({ k: '-', s })), ...nw.map((s): Item => ({ k: '+', s }))];
    f.lines.splice(r.at[0]!, old.length, ...newLines(items, f.lines, r.at[0]!, r.tier));
    tree.commit([[path, joinFile(f.lines, f.br, f.final)]]);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Section 8: V4A patches

interface Chunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

function parseV4A(lines: string[]): Edit[] {
  const n = lines.length;
  const firstNb = lines.findIndex((l) => !isBlank(l));
  if (firstNb < 0) throw new Exit2('error: parse 1');
  if (lines[firstNb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNb + 1}`);
  let lastNb = n - 1;
  while (lastNb > firstNb && isBlank(lines[lastNb]!)) lastNb -= 1;
  if (lines[lastNb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);

  // Cut the lines between the two marker lines into sections, then read each one.
  const heads: Array<{ kind: 'add' | 'del' | 'upd'; path: string; at: number }> = [];
  const prefix: Array<[string, 'add' | 'del' | 'upd']> = [['*** Add File: ', 'add'], ['*** Delete File: ', 'del'], ['*** Update File: ', 'upd']];
  for (let i = firstNb + 1; i < lastNb; i += 1) {
    const l = lines[i]!;
    const h = prefix.find(([p]) => l.startsWith(p));
    if (h !== undefined) heads.push({ kind: h[1], path: l.slice(h[0].length).replace(/^ +| +$/g, ''), at: i });
    else if (heads.length === 0 && !isBlank(l)) throw new Exit2(`error: parse ${i + 1}`);
  }
  const edits: Edit[] = [];
  heads.forEach((h, hi) => {
    let end = hi + 1 < heads.length ? heads[hi + 1]!.at : lastNb;
    while (end > h.at + 1 && isBlank(lines[end - 1]!)) end -= 1;
    const bad = (i: number): Exit2 => new Exit2(`error: parse ${i + 1}`);
    if (h.kind === 'del') {
      if (end > h.at + 1) throw bad(h.at + 1);
      edits.push(v4aDelete(h.path));
    } else if (h.kind === 'add') {
      const add: string[] = [];
      for (let i = h.at + 1; i < end; i += 1) {
        const l = lines[i]!;
        if (l.startsWith('+')) add.push(l.slice(1));
        else if (l === '') add.push('');
        else throw bad(i);
      }
      edits.push(v4aAdd(h.path, add));
    } else {
      let move: string | null = null;
      const chunks: Chunk[] = [];
      let open: Chunk | null = null;
      for (let i = h.at + 1; i < end; i += 1) {
        const l = lines[i]!;
        if (i === h.at + 1 && l.startsWith('*** Move to: ')) {
          move = l.slice(13).replace(/^ +| +$/g, '');
        } else if (l.startsWith('@@')) {
          const a = l.slice(2).replace(/^ +| +$/g, '');
          open = { anchor: a === '' ? null : a, items: [], eof: false };
          chunks.push(open);
        } else if (l.trim() === '*** End of File') {
          if (open === null) throw bad(i);
          open.eof = true;
          open = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (open === null) {
            if (chunks.length > 0) throw bad(i);
            open = { anchor: null, items: [], eof: false };
            chunks.push(open);
          }
          open.items.push(l === '' ? { k: ' ', s: '' } : { k: l[0] as ' ' | '-' | '+', s: l.slice(1) });
        } else throw bad(i);
      }
      if (chunks.length === 0 && move === null) throw bad(h.at);
      edits.push(v4aUpdate(h.path, move, chunks));
    }
  });
  return edits;
}

function v4aAdd(path: string, lines: string[]): Edit {
  return (tree) => {
    if (!isSafe(path)) throw Fail.of('unsafe', path);
    if (tree.read(path) !== null) throw Fail.of('exists', path);
    tree.commit([[path, createdText(lines)]]);
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!isSafe(path)) throw Fail.of('unsafe', path);
    if (tree.read(path) === null) throw Fail.of('missing', path);
    tree.commit([[path, null]]);
  };
}

function v4aUpdate(path: string, move: string | null, chunks: Chunk[]): Edit {
  return (tree) => {
    if (!isSafe(path)) throw Fail.of('unsafe', path);
    if (move !== null && !isSafe(move)) throw Fail.of('unsafe', move);
    const src = tree.read(path);
    if (src === null) throw Fail.of('missing', path);
    if (move !== null && tree.read(move) !== null) throw Fail.of('exists', move);
    const f = splitFile(src);
    const lines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const r = findLines(lines, [ch.anchor], strictMode, (i) => i >= cursor);
        if (r === null) throw Fail.of('no-match', path);
        cursor = r.at[0]! + 1;
      }
      const old = ch.items.filter((x) => x.k !== '+');
      let pos: number;
      let repl: string[];
      if (old.length === 0) {
        pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
        repl = ch.items.map((x) => x.s);
      } else {
        const r = findLines(lines, old.map((x) => x.s), strictMode, (i) => i >= cursor && (!ch.eof || i + old.length === lines.length));
        if (r === null) throw Fail.of('no-match', path);
        pos = r.at[0]!;
        repl = newLines(ch.items, lines, pos, r.tier);
      }
      lines.splice(pos, old.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = joinFile(lines, f.br, f.final);
    if (move !== null) {
      tree.commit([[move, out], [path, null]]);
      tree.moves.push([path, move]);
    } else tree.commit([[path, out]]);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Section 9: JSON edits

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Does the text use CRLF breaks (section 3)? */
const usesCrlf = (text: string): boolean => {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
};

function jsonCreate(path: string, content: string): Edit {
  return (tree) => {
    if (!isSafe(path)) throw Fail.of('unsafe', path);
    if (tree.read(path) !== null) throw Fail.of('exists', path);
    tree.commit([[path, content]]);
  };
}

function jsonReplace(path: string, from: string, to: string): Edit {
  return (tree) => {
    if (!isSafe(path)) throw Fail.of('unsafe', path);
    const src = tree.read(path);
    if (src === null) throw Fail.of('missing', path);
    const crlf = usesCrlf(src);
    const norm = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
    const body = norm(src);
    const needle = norm(from);
    const hit = body.indexOf(needle);
    if (hit < 0) throw Fail.of('no-match', path);
    if (body.indexOf(needle, hit + 1) >= 0) throw Fail.of('ambiguous', path);
    const result = body.slice(0, hit) + norm(to) + body.slice(hit + needle.length);
    tree.commit([[path, crlf ? result.split('\n').join('\r\n') : result]]);
  };
}

function jsonInsert(path: string, after: number, text: string): Edit {
  const add = splitPatch(text);
  return (tree) => {
    if (!isSafe(path)) throw Fail.of('unsafe', path);
    const src = tree.read(path);
    if (src === null) throw Fail.of('missing', path);
    const f = splitFile(src);
    if (after < 0 || after > f.lines.length) throw Fail.of('no-match', path);
    f.lines.splice(after, 0, ...add);
    tree.commit([[path, joinFile(f.lines, f.br, f.final)]]);
  };
}

/** One edit object (section 9), or null when the value is not a valid one. */
function readJsonEdit(v: unknown): Edit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isStr(o.path)) return null;
  switch (o.command) {
    case 'create':
      return isStr(o.file_text) ? jsonCreate(o.path, o.file_text) : null;
    case 'str_replace':
      if (!isStr(o.old_str) || o.old_str === '') return null;
      if (o.new_str !== undefined && !isStr(o.new_str)) return null;
      return jsonReplace(o.path, o.old_str, o.new_str ?? '');
    case 'insert':
      return Number.isInteger(o.insert_line) && isStr(o.new_str) ? jsonInsert(o.path, o.insert_line as number, o.new_str) : null;
    default:
      return null;
  }
}

function parseJson(text: string, lines: string[]): Edit[] {
  const start = lines.findIndex((l) => !isBlank(l));
  if (start < 0) return [];
  if (lines[start]!.trimStart()[0] === '[') {
    // Array form: one fault anywhere is a fault of the line the array starts on.
    const refuse = new Exit2(`error: parse ${start + 1}`);
    let whole: unknown;
    try {
      whole = JSON.parse(text);
    } catch {
      throw refuse;
    }
    if (!Array.isArray(whole)) throw refuse;
    return whole.map((x) => readJsonEdit(x) ?? (() => { throw refuse; })());
  }
  // JSON Lines: one object a line, blank lines ignored.
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isBlank(lines[i]!)) continue;
    let edit: Edit | null = null;
    try {
      edit = readJsonEdit(JSON.parse(lines[i]!));
    } catch {
      edit = null;
    }
    if (edit === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(edit);
  }
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------
// Sections 1, 2, 4 and 10: the command

let strictMode = false;

function detect(lines: string[]): string | null {
  const head = lines.find((l) => !isBlank(l));
  if (head === undefined) return null;
  if (head.trim() === '*** Begin Patch') return 'v4a';
  if ('[{'.includes(head.trimStart()[0]!)) return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.startsWith('diff --git ')) return 'unified';
    if (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (ended || a === '-' || !a.startsWith('-')) pos.push(a);
    else if (a === '--') ended = true;
    else if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
    else if (a === '--check' && !check) check = true;
    else if (a === '--strict' && !strict) strict = true;
    else return { code: 2, out: ['error: usage'] };
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  strictMode = strict;

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    edits = kind === 'json' ? parseJson(text, lines) : kind === 'unified' ? parseUnified(lines) : kind === 'search-replace' ? parseSearchReplace(lines) : parseV4A(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Overlay();
  const fails: Fail[] = [];
  for (const edit of edits) {
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  // Changed paths, with moves folded into one `R` row (section 2).
  const rows: Array<[string, string]> = [];
  const taken = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (taken.has(from) || taken.has(to)) continue;
    if (tree.onDisk(from) !== null && tree.read(from) === null && tree.onDisk(to) === null && tree.read(to) !== null) {
      taken.add(from);
      taken.add(to);
      rows.push([to, `R ${from} -> ${to}`]);
    }
  }
  for (const p of tree.staged.keys()) {
    if (taken.has(p)) continue;
    const was = tree.onDisk(p);
    const now = tree.staged.get(p) as string | null;
    if (was === now) continue;
    rows.push([p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`]);
  }
  rows.sort((a, b) => byBytes(a[0], b[0]));

  if (!check) {
    for (const [p, v] of tree.staged) if (v === null && tree.onDisk(p) !== null) rmSync(p, { force: true });
    for (const [p, v] of tree.staged) {
      if (v === null || tree.onDisk(p) === v) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, v);
    }
  }
  return { code: 0, out: [...rows.map((r) => r[1]), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
