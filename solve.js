// A fast static site generator: an independent implementation of the
// makefun-site 1.0.0 specification, written from the spec for speed.
// run(input) returns the output tree { path: text }, byte-identical to the
// reference for every input. No dependencies, no I/O, no clock, no randomness.
//
// Speed notes (measured against the reference on the practice set):
// - inline markup is rendered in one pass that escapes as it scans, instead of
//   escaping one character at a time;
// - Markdown is lexed and rendered in a single fused pass, dispatching on
//   character codes instead of running a regex per line;
// - slugs are cached per string, with an ASCII fast path that skips Unicode
//   normalisation (NFKD is the identity on ASCII and ASCII holds no marks);
// - front matter is scanned line by line without splitting the whole file;
// - template rendering appends to one shared array per page instead of
//   concatenating strings through the tree walk, and each template is
//   compiled once to a native function (loops, branches and includes become
//   real code) instead of being walked node by node per render.

/* ---------------------------------------------------------------- utilities */

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** JavaScript's \s set, as a code-unit table (for words and list continuations). */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;

/** Whether code unit `c` is JavaScript whitespace (the \s set). */
function isWsCode(c) {
  return WS_TABLE[c] === 1;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function stripTrailingSlashes(s) {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 47) e--;
  return s.slice(0, e);
}

/* --------------------------------------------------------------------- text */

/** HTML escaping, batched: one regex scan, slices between the matches. */
const ESC_RE = /[&<>"']/g;
function escapeHtml(s) {
  ESC_RE.lastIndex = 0;
  let m = ESC_RE.exec(s);
  if (m === null) return s;
  let out = s.slice(0, m.index);
  let last = m.index;
  do {
    const c = s.charCodeAt(m.index);
    out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
    last = m.index + 1;
    m = ESC_RE.exec(s);
    if (m !== null) out += s.slice(last, m.index);
  } while (m !== null);
  return out + s.slice(last);
}

const MARKS_RE = /\p{M}/gu;

function finishSlug(out) {
  out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

function slugifyUncached(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  let out = '';
  if (ascii) {
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep < 0) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) {
        out += '-';
        gap = false;
      }
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(MARKS_RE, '');
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  return finishSlug(out);
}

/** Slugs are pure, so they are cached per input string across a whole run. */
const SLUG_CACHE = new Map();
function slugify(text) {
  const hit = SLUG_CACHE.get(text);
  if (hit !== undefined) return hit;
  const s = slugifyUncached(text);
  SLUG_CACHE.set(text, s);
  return s;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const DATE_CACHE = new Map();
function longDate(date) {
  let s = DATE_CACHE.get(date);
  if (s === undefined) {
    s = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    DATE_CACHE.set(date, s);
  }
  return s;
}

/** The words of a body: its runs of non-whitespace characters. */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/* -------------------------------------------------------------- front matter */

const KEY_BITS = Object.create(null);
KEY_BITS.title = 1;
KEY_BITS.date = 2;
KEY_BITS.tags = 4;
KEY_BITS.draft = 8;
KEY_BITS.layout = 16;
KEY_BITS.slug = 32;
KEY_BITS.summary = 64;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function trimEndST(s) {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return e === s.length ? s : s.slice(0, e);
}

function isBlankLine(s) {
  if (s.length === 0) return true;
  const c0 = s.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return false;
  for (let i = 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** One key's value: { v } on success, { e } with the refusal reason. */
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    if (raw.charCodeAt(0) === 34) {
      if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
        return { e: `key "${key}": a quoted string is not closed` };
      }
      const inner = raw.slice(1, -1);
      if (inner.indexOf('"') === -1 && inner.indexOf('\\') === -1) return { v: inner };
      let out = '';
      for (let i = 1; i < raw.length - 1; i++) {
        const c = raw.charCodeAt(i);
        if (c === 92) {
          const n = raw.charCodeAt(i + 1);
          if ((n !== 34 && n !== 92) || i + 1 === raw.length - 1) {
            return { e: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
          }
          out += raw[i + 1];
          i++;
        } else if (c === 34) {
          return { e: `key "${key}": a quoted string holds a stray quote` };
        } else out += raw[i];
      }
      return { v: out };
    }
    if (raw.charCodeAt(0) === 91) return { e: `key "${key}": a bare string opens on [` };
    return { v: raw };
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) {
          ok = false;
          break;
        }
      }
    }
    if (ok) {
      const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
      const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
      const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
    }
    return ok ? { v: raw } : { e: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
      return { e: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { v: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '') return { e: 'key "tags": an empty tag, or one holding " [ or ]' };
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        if (c === 34 || c === 91 || c === 93) return { e: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { v: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { v: true };
    if (raw === 'false') return { v: false };
    return { e: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) {
        return { e: 'key "layout": not a template name' };
      }
    }
    return { v: raw };
  }
  // slug: [a-z0-9] runs joined by single dashes, at most 64 characters.
  if (raw.length > 64) return { e: 'key "slug": not a slug' };
  let prevDash = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return { e: 'key "slug": not a slug' };
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return { e: 'key "slug": not a slug' };
  }
  if (prevDash) return { e: 'key "slug": not a slug' };
  return { v: raw };
}

/**
 * A source's front matter and body: { data, body }, or { e } with the first
 * reason it is refused. Scans line by line without splitting the body.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { e: 'no front matter' };
  // Find the closing line first: an unclosed front matter is refused before
  // any line inside it is judged.
  const pos = nl0 === -1 ? text.length : nl0 + 1;
  let closeStart = -1;
  let closeEnd = -1;
  let p = pos;
  while (p <= text.length) {
    const e = text.indexOf('\n', p);
    const lineEnd = e === -1 ? text.length : e;
    if (lineEnd - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      closeStart = p;
      closeEnd = e;
      break;
    }
    if (e === -1) break;
    p = e + 1;
  }
  if (closeStart === -1) return { e: 'the front matter is not closed' };
  const data = {};
  let seen = 0;
  let idx = 1;
  p = pos;
  while (p < closeStart) {
    const e = text.indexOf('\n', p);
    const line = text.slice(p, e);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        k++;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { e: `line ${idx + 1} is not "key: value"` };
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = trimEndST(line.slice(k + 2));
      else return { e: `line ${idx + 1} is not "key: value"` };
      // The reference's line pattern matches the value with `.`, which never
      // matches U+2028/U+2029, so a value holding one is not "key: value".
      if (raw.indexOf('\u2028') !== -1 || raw.indexOf('\u2029') !== -1) return { e: `line ${idx + 1} is not "key: value"` };
      const key = line.slice(0, k);
      const bit = KEY_BITS[key];
      if (bit === undefined) return { e: `unknown key "${key}"` };
      if (seen & bit) return { e: `key "${key}" is given twice` };
      if (raw === '') return { e: `key "${key}" has no value` };
      const r = fmValue(key, raw);
      if ('e' in r) return r;
      seen |= bit;
      data[key] = r.v;
    }
    p = e + 1;
    idx++;
  }
  if (!(seen & 1)) return { e: 'no title' };
  return { data, body: closeEnd === -1 ? '' : text.slice(closeEnd + 1) };
}

/* ----------------------------------------------------------------- markdown */

// The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! >
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

/** The first `**` at or after `from` outside a backslash escape, or -1. */
function findDoubleStar(s, from) {
  let j = s.indexOf('**', from);
  while (j !== -1) {
    // The first star is escaped exactly when an odd run of backslashes
    // stands right before it (pairs of backslashes escape each other).
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      bs++;
      k--;
    }
    if (bs % 2 === 0) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}

/** The first `]` at or after `from` outside a backslash escape, or -1. */
function findBracket(s, from) {
  let j = s.indexOf(']', from);
  while (j !== -1) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      bs++;
      k--;
    }
    if (bs % 2 === 0) return j;
    j = s.indexOf(']', j + 1);
  }
  return -1;
}

/** The first single `*` at or after `from` (one not beside another `*`), or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  let j = s.indexOf('*', from);
  while (j !== -1) {
    // The run of stars starting at j; pairs inside it cancel left to right,
    // so a single star survives exactly when the run's effective length
    // (one less when its first star is escaped) is odd.
    let k = j + 1;
    while (k < n && s.charCodeAt(k) === 42) k++;
    const runLen = k - j;
    let b = j - 1;
    let bs = 0;
    while (b >= from && s.charCodeAt(b) === 92) {
      bs++;
      b--;
    }
    const eff = bs % 2 === 1 ? runLen - 1 : runLen;
    if (eff % 2 === 1) return j + runLen - 1;
    j = s.indexOf('*', k);
  }
  return -1;
}

const WS_RE = /\s/;

/** The characters that matter inline: markup openers and the escapable five. */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline, appended to `out`. A regex scan jumps from one special
 * character to the next, so plain runs (which by construction hold no
 * character that needs escaping) are pushed as slices, and the five escapable
 * characters are written as entities where met. The regex is shared, so its
 * position is saved around the recursive calls. `linkFn(target)` resolves a
 * link target to its href.
 */
function inlineInto(s, linkFn, out) {
  SPECIAL_RE.lastIndex = 0;
  let run = 0;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      // backslash: an escapable next character is written (escaped); else the
      // backslash stays part of the plain run.
      if (i + 1 < s.length && ESCAPABLE[s.charCodeAt(i + 1)]) {
        if (i > run) out.push(s.slice(run, i));
        const nc = s.charCodeAt(i + 1);
        out.push(nc === 62 ? '&gt;' : s[i + 1]);
        run = i + 2;
        SPECIAL_RE.lastIndex = i + 2;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        run = j + 1;
        SPECIAL_RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2);
        if (j > i + 2) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<strong>');
          SPECIAL_RE.lastIndex = j + 2;
          inlineInto(s.slice(i + 2, j), linkFn, out);
          SPECIAL_RE.lastIndex = j + 2;
          out.push('</strong>');
          run = j + 2;
        } else SPECIAL_RE.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<em>');
        SPECIAL_RE.lastIndex = j + 1;
        inlineInto(s.slice(i + 1, j), linkFn, out);
        SPECIAL_RE.lastIndex = j + 1;
        out.push('</em>');
        run = j + 1;
      }
      continue;
    }
    if (c === 91) {
      const k = findBracket(s, i + 1);
      if (k !== -1 && s.charCodeAt(k + 1) === 40) {
        const m2 = s.indexOf(')', k + 2);
        if (m2 !== -1) {
          const target = s.slice(k + 2, m2);
          if (target !== '' && !WS_RE.test(target)) {
            if (i > run) out.push(s.slice(run, i));
            out.push('<a href="', escapeHtml(linkFn(target)), '">');
            SPECIAL_RE.lastIndex = m2 + 1;
            inlineInto(s.slice(i + 1, k), linkFn, out);
            SPECIAL_RE.lastIndex = m2 + 1;
            out.push('</a>');
            run = m2 + 1;
            continue;
          }
        }
      }
      continue;
    }
    if (i > run) out.push(s.slice(run, i));
    out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
    run = i + 1;
  }
  if (s.length > run) out.push(s.slice(run));
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(s) {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** A fence-open line's language, or null. */
function fenceLangOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    j++;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let a = k;
  while (a < line.length) {
    const d = line.charCodeAt(a);
    if (d !== 32 && d !== 9) break;
    a++;
  }
  let b = line.length;
  while (b > a) {
    const d = line.charCodeAt(b - 1);
    if (d !== 32 && d !== 9) break;
    b--;
  }
  if (b === a) return null;
  // The heading pattern's `.` never matches U+2028/U+2029.
  const s1 = line.indexOf('\u2028', a);
  if (s1 !== -1 && s1 < b) return null;
  const s2 = line.indexOf('\u2029', a);
  if (s2 !== -1 && s2 < b) return null;
  return { depth: k, text: line.slice(a, b) };
}

function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** An ordered-list line's number and item text, or null. */
function orderedStart(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  // The ordered pattern's `.` never matches U+2028/U+2029.
  const r = j + 2;
  if (line.indexOf('\u2028', r) !== -1 || line.indexOf('\u2029', r) !== -1) return null;
  return { num: Number(line.slice(0, j)), text: trimLine(line.slice(r)) };
}

/** A bullet-list line: `- ` or `* `, with no U+2028/U+2029 in the item. */
function isBulletLine(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== 32) return false;
  // The bullet pattern's `.` never matches U+2028/U+2029.
  return line.indexOf('\u2028', 2) === -1 && line.indexOf('\u2029', 2) === -1;
}

/** A list continuation: two or more spaces, then a non-space character. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !isWsCode(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLangOf(line) !== null || headingOf(line) !== null || isHR(line);
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings)
 * and its excerpt (the first paragraph's inline HTML, or ""). Lexing and
 * rendering happen in one pass over the lines, into one shared array.
 */
function renderMarkdown(src, linkFn) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLangOf(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      // A language holds only [A-Za-z0-9_+-], so it needs no escaping.
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      if (body.length === 0) out.push(`<pre><code${cls}></code></pre>\n`);
      else out.push(`<pre><code${cls}>`, escapeHtml(body.join('\n')), '\n</code></pre>\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const parts = [];
      inlineInto(hd.text, linkFn, parts);
      const html = parts.join('');
      out.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      if (body.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(body.join('\n'), linkFn, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    let ordered = false;
    let startNum = 1;
    let firstItem = null;
    if (isBulletLine(line)) {
      firstItem = trimLine(line.slice(2));
    } else {
      const on = orderedStart(line);
      if (on !== null) {
        ordered = true;
        startNum = on.num;
        firstItem = on.text;
      }
    }
    if (firstItem !== null) {
      const items = [[firstItem]];
      i++;
      while (i < n) {
        const l = lines[i];
        if (ordered) {
          const on = orderedStart(l);
          if (on !== null) {
            items.push([on.text]);
            i++;
            continue;
          }
        } else if (isBulletLine(l)) {
          items.push([trimLine(l.slice(2))]);
          i++;
          continue;
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`, '\n');
      for (const it of items) {
        out.push('<li>');
        inlineInto(it.join('\n'), linkFn, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const parts = [];
    inlineInto(body.join('\n'), linkFn, parts);
    const html = parts.join('');
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

/* ---------------------------------------------------------------- templates */

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isSpaces(src, a, b) {
  for (let k = a; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Token kinds: 0 text, 1 var, 2 raw, 3 tag. */
function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 0, text });
      text = '';
      tokens.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = isSpaces(src, lineStart, open) && isSpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 0, text });
    text = '';
    tokens.push({ t: 3, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });
  return tokens;
}

/**
 * `src` parsed into a tree of nodes. Node kinds: 0 text, 1 var, 2 raw,
 * 3 if, 4 for, 5 include, 6 root. Tokenising runs to completion before the
 * tree is built, so a lexical error anywhere beats a structural error.
 */
function parseTemplate(name, src) {
  const tokens = tokenizeTemplate(name, src);
  const root = { k: 6, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokens) {
    if (tok.t === 0) body.push({ k: 0, text: tok.text });
    else if (tok.t === 1 || tok.t === 2) body.push({ k: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 4, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 3, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 3 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 4 : 3)) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 6 ? parent.body : parent.k === 4 ? parent.body : parent.els ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 4 ? 'for' : 'if'} is not closed`);
  }
  return root.body;
}

/** The value of the first name of a path in the scope chain, or undefined. */
function lkFirst(sc, name) {
  let s = sc;
  while (s !== null && !Object.hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

/** A value as text: strings, numbers and booleans as themselves, arrays joined by ", ", anything else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Compile a parsed template (a tree of nodes) into a render function.
 * The generated function has the signature fn(sc, T, out, D): sc is the scope
 * chain ({vars, parent}), T the map of compiled templates, out the array the
 * output is appended to, D the include depth. Loops, branches and includes
 * become native code. A path's first name is resolved statically when an
 * enclosing for in this template binds it (that binding is innermost in the
 * chain whatever template includes this one); otherwise the scope chain is
 * walked at run time, since an including template's loops may bind it. The
 * remaining path segments are inlined as own-property checks.
 */
function compileTemplate(nodes) {
  const lines = [];
  let uid = 0;
  lines.push('let _v;');
  const emitLookup = (path, sc, stack) => {
    const first = path[0];
    let bound = null;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === first || first === 'loop') {
        bound = stack[i];
        break;
      }
    }
    if (bound !== null) lines.push(`_v=${bound.svar}.vars[${JSON.stringify(first)}];`);
    else lines.push(`_v=lk1(${sc},${JSON.stringify(first)});`);
    for (let k = 1; k < path.length; k++) {
      const seg = JSON.stringify(path[k]);
      lines.push(`_v=_v!==null&&typeof _v==='object'&&Object.hasOwn(_v,${seg})?_v[${seg}]:undefined;`);
    }
  };
  const emit = (ns, sc, stack) => {
    for (const n of ns) {
      const k = n.k;
      if (k === 0) lines.push(`out.push(${JSON.stringify(n.text)});`);
      else if (k === 1 || k === 2) {
        emitLookup(n.path, sc, stack);
        lines.push(k === 1 ? 'out.push(esc(txt(_v)));' : 'out.push(txt(_v));');
      } else if (k === 3) {
        emitLookup(n.path, sc, stack);
        lines.push(`if(tr(_v)!==${n.not}){`);
        emit(n.then, sc, stack);
        if (n.els !== null) {
          lines.push('}else{');
          emit(n.els, sc, stack);
        }
        lines.push('}');
      } else if (k === 4) {
        emitLookup(n.path, sc, stack);
        const u = uid++;
        lines.push(`{const _x${u}=_v;if(Array.isArray(_x${u})){for(let _j${u}=0;_j${u}<_x${u}.length;_j${u}++){const _s${u}={vars:{[${JSON.stringify(n.name)}]:_x${u}[_j${u}],loop:{index:_j${u}+1,first:_j${u}===0,last:_j${u}===_x${u}.length-1,length:_x${u}.length}},parent:${sc}};`);
        emit(n.body, `_s${u}`, [...stack, { name: n.name, svar: `_s${u}` }]);
        lines.push('}}}');
      } else {
        const u = uid++;
        lines.push(`{const _f${u}=T.get(${JSON.stringify(n.name)});if(_f${u}!==undefined&&D<8)_f${u}(${sc},T,out,D+1);}`);
      }
    }
  };
  emit(nodes, 'sc', []);
  const factory = new Function('lk1', 'txt', 'esc', 'tr', `return function fn(sc,T,out,D){\n${lines.join('\n')}\n}`);
  return factory(lkFirst, textOf, escapeHtml, truthy);
}

/* -------------------------------------------------------------------- links */

/** A target kept as written: one with a scheme, or opening on / or #. */
function isAbsoluteLink(target) {
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return true;
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

/** `rel` from the directory `dir`, or null when it climbs above the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/* ------------------------------------------------------------------ pipeline */

const RESERVED = ['posts', 'tags', 'page'];

/** A source's tags, each slug once, in its own order. */
function ownTags(s) {
  const names = s.data.tags ?? [];
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const slug = slugify(name);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(name);
    }
  }
  return out;
}

/** A page's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.dateLong,
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.dateLong };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const base = stripTrailingSlashes(input.site.base_url);

  // Sources, in code-unit order of path; line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push(f);
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('e' in fm) {
      report.push(`refused ${s.path}: ${fm.e}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's directory and url, its slug unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    s.dateLong = s.data.date === undefined ? '' : longDate(s.data.date);
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resolveCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const spath = s.path;
    const linkFn = (target) => {
      if (isAbsoluteLink(target)) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      if (rel === '') {
        broken.add(`broken-link ${spath} -> ${target}`);
        return target;
      }
      const key = `${dir}\0${rel}`;
      let path = resolveCache.get(key);
      if (path === undefined) {
        path = resolvePath(dir, rel);
        resolveCache.set(key, path);
      }
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${spath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, linkFn);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug; newer and older.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index and tag pages through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const topScope = { vars: { site, tags: allTags, recent }, parent: null };
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ vars, parent: topScope }, templates, out, 0);
    return out.join('');
  };
  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
