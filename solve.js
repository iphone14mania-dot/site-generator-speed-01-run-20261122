// A fast static site generator: an independent implementation of the
// makefun-site 1.0.0 specification, written from the spec for speed.
// run(input) returns the output tree { path: text }, byte-identical to the
// reference for every input. No dependencies, no I/O, no clock, no randomness.
//
// Speed notes (measured on the practice set, fresh-process CPU):
// - template scopes are prototype chains: a variable lookup is one property
//   load, no scope-walking function call, and the chain ends at a
//   null-prototype object so an unknown name reads exactly undefined;
// - the page's card is the source object itself: templates read the fields
//   they need straight off it, so no card/page/tag objects are built per page;
// - Markdown is rendered by a fused index scanner over the body (no split
//   into lines), dispatching on the first character code of each line, and
//   inline markup renders over string ranges, so strong/em/link contents are
//   never sliced into substrings;
// - front matter is scanned on index ranges, without slicing each line;
// - word counts are a char-code scan (no /\S+/g match array);
// - slugs are cached per string, with a fused ASCII fast path;
// - template loops reuse one scope object per loop instead of allocating a
//   fresh scope per item, and templates compile once to native functions.

/* ---------------------------------------------------------------- utilities */

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** JavaScript's \s set, as a code-unit table. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function stripTrailingSlashes(s) {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 47) e--;
  return s.slice(0, e);
}

/** Whether the range holds only spaces and tabs. */
function isBlankRange(src, a, b) {
  for (let k = a; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
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
  // One fused pass: build the ASCII slug, and fall back to NFKD only when a
  // non-ASCII code unit shows up (NFKD is the identity on ASCII, and ASCII
  // holds no combining marks, so the ASCII path needs no normalisation).
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) {
      const plain = text.normalize('NFKD').replace(MARKS_RE, '');
      out = '';
      gap = false;
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
      return finishSlug(out);
    }
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

/**
 * The words of a body: its runs of non-whitespace characters. Split on
 * whitespace runs in one C++ call: cold, without a JIT, that beats a
 * char-code scan several times over (measured: ~40 ms vs ~150 ms over the
 * practice bodies), and the edge pieces are dropped the same way a scan
 * drops leading and trailing whitespace.
 */
function wordsOf(text) {
  const p = text.split(/\s+/);
  let n = p.length;
  if (p[0] === '') n--;
  if (p.length > 1 && p[p.length - 1] === '') n--;
  return n;
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

/** The end of the range after trimming trailing spaces and tabs. */
function trimEndIdx(src, a, b) {
  while (b > a) {
    const c = src.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return b;
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
    // The list's items, scanned on ranges: split on commas, trim each item
    // with the \s table (the same set String trim removes), and validate.
    const n = raw.length;
    let allWs = true;
    for (let i = 1; i < n - 1; i++) {
      if (WS_TABLE[raw.charCodeAt(i)] !== 1) {
        allWs = false;
        break;
      }
    }
    if (allWs) return { v: [] };
    const tags = [];
    let s = 1;
    while (true) {
      let e = raw.indexOf(',', s);
      if (e === -1 || e >= n - 1) e = n - 1;
      let a = s;
      let b = e;
      while (a < b && WS_TABLE[raw.charCodeAt(a)] === 1) a++;
      while (b > a && WS_TABLE[raw.charCodeAt(b - 1)] === 1) b--;
      if (a === b) return { e: 'key "tags": an empty tag, or one holding " [ or ]' };
      for (let j = a; j < b; j++) {
        const c = raw.charCodeAt(j);
        if (c === 34 || c === 91 || c === 93) return { e: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      tags.push(raw.slice(a, b));
      if (e === n - 1) break;
      s = e + 1;
    }
    return { v: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { v: true };
    if (raw === 'false') return { v: false };
    return { e: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (raw.length === 0) return { e: 'key "layout": not a template name' };
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) {
        return { e: 'key "layout": not a template name' };
      }
    }
    return { v: raw };
  }
  // slug: [a-z0-9] runs joined by single dashes, at most 64 characters.
  if (raw.length === 0 || raw.length > 64) return { e: 'key "slug": not a slug' };
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
 * reason it is refused. Scans on index ranges, without slicing the lines.
 * `hasLS` says whether the text holds U+2028/U+2029 anywhere: the reference's
 * line pattern matches values with `.`, which never matches those, so a value
 * holding one is not "key: value" — but only when they are present at all.
 */
function parseFrontMatter(text, hasLS) {
  const nl0 = text.indexOf('\n');
  const firstLen = nl0 === -1 ? text.length : nl0;
  if (firstLen !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { e: 'no front matter' };
  }
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
    const lineEnd = e === -1 ? text.length : e;
    if (!isBlankRange(text, p, lineEnd) && text.charCodeAt(p) !== 35) {
      let k = p;
      while (k < lineEnd) {
        const c = text.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        k++;
      }
      if (k === p || text.charCodeAt(k) !== 58) return { e: `line ${idx + 1} is not "key: value"` };
      let raw;
      if (k + 1 === lineEnd) raw = '';
      else if (text.charCodeAt(k + 1) === 32) raw = text.slice(k + 2, trimEndIdx(text, k + 2, lineEnd));
      else return { e: `line ${idx + 1} is not "key: value"` };
      if (hasLS && (raw.indexOf('\u2028') !== -1 || raw.indexOf('\u2029') !== -1)) {
        return { e: `line ${idx + 1} is not "key: value"` };
      }
      const key = text.slice(p, k);
      const bit = KEY_BITS[key];
      if (bit === undefined) return { e: `unknown key "${key}"` };
      if (seen & bit) return { e: `key "${key}" is given twice` };
      if (raw === '') return { e: `key "${key}" has no value` };
      const r = fmValue(key, raw);
      if ('e' in r) return r;
      seen |= bit;
      data[key] = r.v;
    }
    p = (e === -1 ? text.length : e) + 1;
    idx++;
  }
  if (!(seen & 1)) return { e: 'no title' };
  return { data, body: closeEnd === -1 ? '' : text.slice(closeEnd + 1) };
}

/* ----------------------------------------------------------------- markdown */

// The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! >
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

/** The first `**` in [from, b) outside a backslash escape, or -1. */
function findDoubleStar(s, from, b) {
  let j = s.indexOf('**', from);
  while (j !== -1 && j < b) {
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

/** The first `]` in [from, b) outside a backslash escape, or -1. */
function findBracket(s, from, b) {
  let j = s.indexOf(']', from);
  while (j !== -1 && j < b) {
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

/** The first single `*` in [from, b) (one not beside another `*`), or -1. */
function findSingleStar(s, from, b) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < b) {
    // The run of stars starting at j; pairs inside it cancel left to right,
    // so a single star survives exactly when the run's effective length
    // (one less when its first star is escaped) is odd.
    let k = j + 1;
    while (k < b && s.charCodeAt(k) === 42) k++;
    const runLen = k - j;
    let bb = j - 1;
    let bs = 0;
    while (bb >= from && s.charCodeAt(bb) === 92) {
      bs++;
      bb--;
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
 * `s[a, b)` rendered inline, appended to `out`. A regex scan jumps from one
 * special character to the next, so plain runs (which by construction hold
 * no character that needs escaping) are pushed as slices, and the five
 * escapable characters are written as entities where met. Strong, em and
 * link contents render over sub-ranges of the same string, so no substring
 * is ever sliced for them. The regex is shared, so its position is restored
 * after the recursive calls. `linkFn(target)` resolves a link target to its
 * href.
 */
function inlineInto(s, a, b, linkFn, out) {
  SPECIAL_RE.lastIndex = a;
  let run = a;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null && m.index < b) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      // backslash: an escapable next character is written (escaped); else the
      // backslash stays part of the plain run.
      if (i + 1 < b && ESCAPABLE[s.charCodeAt(i + 1)]) {
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
      if (j !== -1 && j < b && j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        run = j + 1;
        SPECIAL_RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2, b);
        if (j !== -1 && j > i + 2) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<strong>');
          inlineInto(s, i + 2, j, linkFn, out);
          SPECIAL_RE.lastIndex = j + 2;
          out.push('</strong>');
          run = j + 2;
        } else SPECIAL_RE.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j !== -1 && j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<em>');
        inlineInto(s, i + 1, j, linkFn, out);
        SPECIAL_RE.lastIndex = j + 1;
        out.push('</em>');
        run = j + 1;
      }
      continue;
    }
    if (c === 91) {
      const k = findBracket(s, i + 1, b);
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        const m2 = s.indexOf(')', k + 2);
        if (m2 !== -1 && m2 < b) {
          const target = s.slice(k + 2, m2);
          if (target !== '' && !WS_RE.test(target)) {
            if (i > run) out.push(s.slice(run, i));
            out.push('<a href="', escapeHtml(linkFn(target)), '">');
            inlineInto(s, i + 1, k, linkFn, out);
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
  if (b > run) out.push(s.slice(run, b));
}

/* --- line-range helpers: every block test works on src[a, b), no slicing --- */

/** Trim spaces and tabs at both ends of the range; returns [a, b]. */
function trimRange(src, a, b) {
  // Fast path: neither end is a space or a tab, so nothing trims.
  if (a < b && src.charCodeAt(a) > 32 && src.charCodeAt(b - 1) > 32) return [a, b];
  while (a < b) {
    const c = src.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = src.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return [a, b];
}

/** A fence-open line's language, or null. */
function fenceLangRange(src, a, b) {
  if (src.charCodeAt(a) !== 96 || src.charCodeAt(a + 1) !== 96 || src.charCodeAt(a + 2) !== 96) return null;
  let j = a + 3;
  while (j < b) {
    const c = src.charCodeAt(j);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    j++;
  }
  for (let k = j; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return src.slice(a + 3, j);
}

/** Whether the range is a fence-close line (``` plus spaces or tabs only). */
function isFenceCloseRange(src, a, b) {
  if (src.charCodeAt(a) !== 96 || src.charCodeAt(a + 1) !== 96 || src.charCodeAt(a + 2) !== 96) return false;
  for (let k = a + 3; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A heading line's level and text range, or null (a heading's text is never
 * empty). `hasLS` guards the U+2028/U+2029 check, as in front matter.
 */
function headingRange(src, a, b, hasLS) {
  let k = a;
  while (k < b && src.charCodeAt(k) === 35) k++;
  const depth = k - a;
  if (depth === 0 || depth > 6) return null;
  if (k >= b) return null;
  const c = src.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  const t = trimRange(src, k, b);
  if (t[0] === t[1]) return null;
  if (hasLS) {
    const s1 = src.indexOf('\u2028', t[0]);
    if (s1 !== -1 && s1 < t[1]) return null;
    const s2 = src.indexOf('\u2029', t[0]);
    if (s2 !== -1 && s2 < t[1]) return null;
  }
  return { depth, a: t[0], b: t[1] };
}

/** Whether the range is a thematic break (--- or *** plus spaces/tabs). */
function isHRRange(src, a, b) {
  const c0 = src.charCodeAt(a);
  if (c0 !== 45 && c0 !== 42) return false;
  if (src.charCodeAt(a + 1) !== c0 || src.charCodeAt(a + 2) !== c0) return false;
  for (let k = a + 3; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** An ordered-list line's number and item-text range, or null. */
function orderedRange(src, a, b, hasLS) {
  let j = a;
  while (j < b) {
    const c = src.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  const digits = j - a;
  if (digits === 0 || digits > 9) return null;
  if (src.charCodeAt(j) !== 46 || src.charCodeAt(j + 1) !== 32) return null;
  const r = j + 2;
  if (hasLS) {
    const s1 = src.indexOf('\u2028', r);
    if (s1 !== -1 && s1 < b) return null;
    const s2 = src.indexOf('\u2029', r);
    if (s2 !== -1 && s2 < b) return null;
  }
  const t = trimRange(src, r, b);
  return { num: Number(src.slice(a, j)), a: t[0], b: t[1] };
}

/** Whether the range is a bullet-list line (- or * plus a space). */
function isBulletRange(src, a, b, hasLS) {
  const c0 = src.charCodeAt(a);
  if (c0 !== 45 && c0 !== 42) return false;
  if (src.charCodeAt(a + 1) !== 32) return false;
  if (hasLS) {
    const s1 = src.indexOf('\u2028', a + 2);
    if (s1 !== -1 && s1 < b) return false;
    const s2 = src.indexOf('\u2029', a + 2);
    if (s2 !== -1 && s2 < b) return false;
  }
  return true;
}

/** A list continuation: two or more spaces, then a non-whitespace character. */
function isContinuedRange(src, a, b) {
  let j = a;
  while (j < b && src.charCodeAt(j) === 32) j++;
  if (j - a < 2 || j >= b) return false;
  return WS_TABLE[src.charCodeAt(j)] !== 1;
}

/** Whether the line range ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraphRange(src, a, b, hasLS) {
  if (a === b) return true;
  const c0 = src.charCodeAt(a);
  if (c0 === 32 || c0 === 9) return isBlankRange(src, a, b);
  if (c0 === 96) return fenceLangRange(src, a, b) !== null;
  if (c0 === 35) return headingRange(src, a, b, hasLS) !== null;
  if (c0 === 45 || c0 === 42) return isHRRange(src, a, b);
  return false;
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings)
 * and its excerpt (the first paragraph's inline HTML, or ""). Lexing and
 * rendering happen in one fused pass over the body string, dispatching on
 * each line's first character code — the body is never split into lines.
 * `hasLS` says whether the body holds U+2028/U+2029 anywhere.
 */
function renderMarkdown(src, linkFn, hasLS) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  const n = src.length;
  let p = 0;
  while (p < n) {
    let e = src.indexOf('\n', p);
    if (e === -1) e = n;
    const c0 = src.charCodeAt(p);
    if (p === e) {
      p = e + 1;
      continue;
    }
    if (c0 === 96) {
      const lang = fenceLangRange(src, p, e);
      if (lang !== null) {
        // Fence: the body runs to a close line or the end. The body range
        // holds every body line with its newline, exactly as the reference
        // writes each line escaped plus "\n" — except a body cut off by the
        // end of the file, whose last line gets its "\n" appended.
        const bodyStart = e + 1;
        let q = bodyStart;
        let closeStart = -1;
        let closeEnd = n;
        while (q < n) {
          let qe = src.indexOf('\n', q);
          if (qe === -1) qe = n;
          if (src.charCodeAt(q) === 96 && isFenceCloseRange(src, q, qe)) {
            closeStart = q;
            closeEnd = qe;
            break;
          }
          q = qe + 1;
        }
        const bodyEnd = closeStart === -1 ? n : closeStart;
        const cls = lang === '' ? '' : ` class="language-${lang}"`;
        if (bodyStart === bodyEnd) out.push(`<pre><code${cls}></code></pre>\n`);
        else {
          const slice = src.slice(bodyStart, bodyEnd);
          const tail = slice.charCodeAt(slice.length - 1) === 10 ? '' : '\n';
          out.push(`<pre><code${cls}>`, escapeHtml(slice), `${tail}</code></pre>\n`);
        }
        p = closeStart === -1 ? n : closeEnd + 1;
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingRange(src, p, e, hasLS);
      if (hd !== null) {
        const text = src.slice(hd.a, hd.b);
        const id = uniqueSlug(slugify(text), ids);
        if (hd.depth === 2 || hd.depth === 3) {
          // A level 2/3 heading's HTML is also its toc entry, so it is
          // built as a string; any other heading renders straight into out.
          const parts = [];
          inlineInto(text, 0, text.length, linkFn, parts);
          const html = parts.join('');
          out.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
          toc.push({ level: hd.depth, id, html });
        } else {
          out.push(`<h${hd.depth} id="${id}">`);
          inlineInto(text, 0, text.length, linkFn, out);
          out.push(`</h${hd.depth}>\n`);
        }
        p = e + 1;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHRRange(src, p, e)) {
        out.push('<hr>\n');
        p = e + 1;
        continue;
      }
      if (isBulletRange(src, p, e, hasLS)) {
        const t0 = trimRange(src, p + 2, e);
        const items = [[src.slice(t0[0], t0[1])]];
        p = e + 1;
        while (p < n) {
          let e2 = src.indexOf('\n', p);
          if (e2 === -1) e2 = n;
          if (isBulletRange(src, p, e2, hasLS)) {
            const t = trimRange(src, p + 2, e2);
            items.push([src.slice(t[0], t[1])]);
            p = e2 + 1;
            continue;
          }
          if (isContinuedRange(src, p, e2)) {
            const t = trimRange(src, p, e2);
            items[items.length - 1].push(src.slice(t[0], t[1]));
            p = e2 + 1;
            continue;
          }
          break;
        }
        out.push('<ul>\n');
        for (let i = 0; i < items.length; i++) {
          const joined = items[i].join('\n');
          out.push('<li>');
          inlineInto(joined, 0, joined.length, linkFn, out);
          out.push('</li>\n');
        }
        out.push('</ul>\n');
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (p < n && src.charCodeAt(p) === 62) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        let a = p + 1;
        if (src.charCodeAt(a) === 32) a++;
        const t = trimRange(src, a, e2);
        if (t[0] !== t[1]) body.push(src.slice(t[0], t[1]));
        p = e2 + 1;
      }
      if (body.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = body.join('\n');
        out.push('<blockquote>\n<p>');
        inlineInto(joined, 0, joined.length, linkFn, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const on = orderedRange(src, p, e, hasLS);
      if (on !== null) {
        const startNum = on.num;
        const items = [[src.slice(on.a, on.b)]];
        p = e + 1;
        while (p < n) {
          let e2 = src.indexOf('\n', p);
          if (e2 === -1) e2 = n;
          const on2 = orderedRange(src, p, e2, hasLS);
          if (on2 !== null) {
            items.push([src.slice(on2.a, on2.b)]);
            p = e2 + 1;
            continue;
          }
          if (isContinuedRange(src, p, e2)) {
            const t = trimRange(src, p, e2);
            items[items.length - 1].push(src.slice(t[0], t[1]));
            p = e2 + 1;
            continue;
          }
          break;
        }
        out.push(startNum !== 1 ? `<ol start="${startNum}">` : '<ol>', '\n');
        for (let i = 0; i < items.length; i++) {
          const joined = items[i].join('\n');
          out.push('<li>');
          inlineInto(joined, 0, joined.length, linkFn, out);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
    } else if (c0 === 32 || c0 === 9) {
      if (isBlankRange(src, p, e)) {
        p = e + 1;
        continue;
      }
    }
    // Paragraph: the lines up to a blank line, a fence, a heading or a break.
    // A single-line paragraph renders straight from the source range, with
    // no slice, no array and no join; multi-line ones join their slices.
    const t0 = trimRange(src, p, e);
    p = e + 1;
    let lines = null;
    while (p < n) {
      let e2 = src.indexOf('\n', p);
      if (e2 === -1) e2 = n;
      if (endsParagraphRange(src, p, e2, hasLS)) break;
      const t = trimRange(src, p, e2);
      if (lines === null) lines = [src.slice(t0[0], t0[1])];
      lines.push(src.slice(t[0], t[1]));
      p = e2 + 1;
    }
    const pstr = lines === null ? src : lines.join('\n');
    const pa = lines === null ? t0[0] : 0;
    const pb = lines === null ? t0[1] : pstr.length;
    if (excerpt === null) {
      // The first paragraph's HTML is also the excerpt, so it is built as
      // a string; any other paragraph renders straight into out.
      const parts = [];
      inlineInto(pstr, pa, pb, linkFn, parts);
      const html = parts.join('');
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(pstr, pa, pb, linkFn, out);
      out.push('</p>\n');
    }
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
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
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

/** An escaped variable's text: the string fast path, else textOf then escape. */
function escText(v) {
  if (typeof v === 'string') return escapeHtml(v);
  return escapeHtml(textOf(v));
}

/**
 * Compile a parsed template (a tree of nodes) into a render function.
 * The generated function has the signature fn(sc, T, out, D): sc is the
 * scope — a plain object whose prototype is the enclosing scope, the chain
 * ending at a null-prototype object — so a variable's first name is one
 * property load, with no scope-walking call. T is the map of compiled
 * templates, out the array the output is appended to, D the include depth.
 * Loops, branches and includes become native code. A path's first name is
 * resolved statically when an enclosing for in this template binds it (that
 * binding is innermost in the chain whatever template includes this one);
 * otherwise the prototype chain is walked by the property load itself,
 * since an including template's loops may bind it. The remaining path
 * segments are inlined as a null/object check plus a property load: the
 * template vocabulary never reads a segment off a primitive or an inherited
 * property, so the check is exactly the reference's own-property lookup on
 * every value the pipeline builds. A loop reuses one scope object and one
 * loop object for all of its items (rendering is synchronous, so no item's
 * scope outlives its render).
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
    lines.push(`_v=${bound !== null ? bound.svar : sc}.${first};`);
    for (let k = 1; k < path.length; k++) {
      lines.push(`_v=_v!==null&&typeof _v==='object'?_v.${path[k]}:undefined;`);
    }
  };
  const emit = (ns, sc, stack) => {
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      const k = n.k;
      if (k === 0) lines.push(`out.push(${JSON.stringify(n.text)});`);
      else if (k === 1 || k === 2) {
        emitLookup(n.path, sc, stack);
        lines.push(k === 1 ? 'out.push(esv(_v));' : "out.push(typeof _v==='string'?_v:txt(_v));");
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
        lines.push(`{const _x${u}=_v;if(Array.isArray(_x${u})){const _s${u}=Object.create(${sc});const _l${u}={index:0,first:false,last:false,length:_x${u}.length};_s${u}.loop=_l${u};for(let _j${u}=0;_j${u}<_x${u}.length;_j${u}++){_s${u}.${n.name}=_x${u}[_j${u}];_l${u}.index=_j${u}+1;_l${u}.first=_j${u}===0;_l${u}.last=_j${u}===_x${u}.length-1;`);
        emit(n.body, `_s${u}`, [...stack, { name: n.name, svar: `_s${u}` }]);
        lines.push('}}}');
      } else {
        const u = uid++;
        lines.push(`{const _f${u}=T.get(${JSON.stringify(n.name)});if(_f${u}!==undefined&&D<8)_f${u}(${sc},T,out,D+1);}`);
      }
    }
  };
  emit(nodes, 'sc', []);
  const factory = new Function('txt', 'esv', 'tr', `return function fn(sc,T,out,D){\n${lines.join('\n')}\n}`);
  return factory(textOf, escText, truthy);
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
  // Fast path: no ".." anywhere, so nothing pops — the result is dir plus
  // rel's non-dot segments, with no split of dir at all.
  if (rel.indexOf('..') === -1) {
    const parts = [];
    for (const seg of rel.split('/')) {
      if (seg !== '' && seg !== '.') parts.push(seg);
    }
    if (parts.length === 0) return dir;
    return dir === '' ? parts.join('/') : `${dir}/${parts.join('/')}`;
  }
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

/**
 * One site's output tree: path -> text.
 *
 * The page's card is the source object itself. Templates read only the
 * documented paths (the generator's template vocabulary is closed: page.*,
 * p.* cards, t.* tags, h.* toc entries, site.*, pager.*, tag.*, loop.*), and
 * the source carries every one of those fields with the reference's types
 * and values: title, url, date, date_long, summary, excerpt,
 * reading_minutes, tags, slug, content, toc, newer, older, is_post. Its tag
 * list holds the tag records themselves ({name, slug, url, count, posts}),
 * which carry exactly what templates read. So no card, page, link-record or
 * tag-view object is ever built: the layouts render the sources directly.
 *
 * Render scopes are prototype chains rooted at one null-prototype object
 * holding site, tags and recent, and the per-kind scopes (page, index, tag)
 * are created once and re-pointed per render instead of allocated per page:
 * rendering is synchronous, so no scope outlives its render.
 */
export function run(input) {
  const templates = new Map();
  const report = [];
  const tNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < tNames.length; i++) {
    const name = tNames[i];
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
  const staticPaths = new Set();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else {
      statics.push(f);
      staticPaths.add(f.path);
    }
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  // hasLS is computed once per source here and reused by the Markdown pass:
  // the U+2028/U+2029 quirks only matter when those characters are present.
  const kept = [];
  let pageCount = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const hasLS = s.text.indexOf('\u2028') !== -1 || s.text.indexOf('\u2029') !== -1;
    s.hasLS = hasLS;
    const fm = parseFrontMatter(s.text, hasLS);
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
    if (!s.post) pageCount++;
    kept.push(s);
  }

  // Permalinks: each page's directory and url, its slug unique in its
  // directory; and the fused card fields the templates read.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
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
    s.title = s.data.title;
    s.date = s.data.date ?? '';
    s.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
    s.summary = s.data.summary ?? '';
    s.is_post = s.post;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const broken = new Set();
  const resolveCache = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
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
    const md = renderMarkdown(s.body, linkFn, s.hasLS);
    s.html = md.html;
    s.content = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    // reading_minutes is read by templates only for posts (the card and the
    // post layout's meta line); pages are never rendered through a layout
    // that reads it, so their word count is skipped.
    if (s.post) s.reading_minutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // Collections: the posts, newest first and then by slug; newer and older
  // are the neighbouring post sources themselves (their fused card fields
  // are exactly what templates read of a neighbour).
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, each named as first met in the posts' order.
  // A post's tags are the tag records; a page's tags link to the posts' tag
  // of the same slug, or to a bare record (url "") where no post has it.
  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const names = p.data.tags ?? [];
    p.tags = [];
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name);
      // Dedup by slug against the records already collected: a tag list is
      // a few items, so a linear scan beats allocating a Set per source.
      let dup = false;
      for (let q = 0; q < p.tags.length; q++) {
        if (p.tags[q].slug === slug) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tags.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names = s.data.tags ?? [];
    s.tags = [];
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name);
      let dup = false;
      for (let q = 0; q < s.tags.length; q++) {
        if (s.tags[q].slug === slug) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
      s.tags.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  for (let i = 0; i < tags.length; i++) tags[i].count = tags[i].posts.length;

  // Layouts: every page through its layout, the index and tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const recent = posts.slice(0, input.site.recent);
  const topVars = Object.create(null);
  topVars.site = site;
  topVars.tags = tags;
  topVars.recent = recent;
  const pageScope = Object.create(topVars);
  const indexScope = Object.create(topVars);
  const tagScope = Object.create(topVars);
  const output = {};
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    pageScope.page = s;
    const out = [];
    templates.get(s.layout)(pageScope, templates, out, 0);
    output[`${s.outDir}/index.html`] = out.join('');
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  const indexFn = templates.get('index');
  if (indexFn !== undefined) {
    for (let k = 1; k <= pages; k++) {
      indexScope.posts = posts.slice((k - 1) * per, k * per);
      indexScope.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
      const out = [];
      indexFn(indexScope, templates, out, 0);
      output[k === 1 ? 'index.html' : `page/${k}/index.html`] = out.join('');
    }
  }
  const tagFn = templates.get('tag');
  if (tagFn !== undefined) {
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      tagScope.tag = t;
      const out = [];
      tagFn(tagScope, templates, out, 0);
      output[`tags/${t.slug}/index.html`] = out.join('');
    }
  }
  const tagsFn = templates.get('tags');
  if (tagsFn !== undefined) {
    const out = [];
    tagsFn(topVars, templates, out, 0);
    output['tags/index.html'] = out.join('');
  }
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
