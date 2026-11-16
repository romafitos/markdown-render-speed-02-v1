// Fast drop-in replacement for marked 18.1.3 (default options, GFM on).
// A single-pass CommonMark 0.31.2 + GFM scanner written from the spec.
// Dependency-free, no regex in hot paths, no caching across cases.

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13; }
const _punctRe = /[\p{P}\p{S}]/u;
// Backslash escapes work on ASCII punctuation only (cm-013: \« stays
// literal because « is not ASCII punctuation).
function isAsciiPunctCode(c) {
  return c < 128 && PUNCT.indexOf(String.fromCharCode(c)) >= 0;
}
const _punctCache = new Map();
function isPunctCode(c) {
  if (c < 128) return PUNCT.indexOf(String.fromCharCode(c)) >= 0;
  let v = _punctCache.get(c);
  if (v === undefined) { v = _punctRe.test(String.fromCodePoint(c)); _punctCache.set(c, v); }
  return v;
}
function isLetterDigit(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c >= 128;
}

// Escape text content: & < > " '  (marked escapes all five in text and code)
function escText(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) { if (i > start) out += s.slice(start, i); out += rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape an attribute value (href/title/info): & is left alone when it starts
// a valid entity reference, everything else like escText.
function escAttr(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (!isEntityAt(s, i)) rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) { if (i > start) out += s.slice(start, i); out += rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Is there a valid entity reference starting at s[i] ('&')? Named references
// pass through as written (any name); numeric ones must have a valid code point.
function isEntityAt(s, i) {
  const n = s.length;
  if (s.charCodeAt(i + 1) === 35) {
    let j = i + 2, hex = false;
    if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
    const st = j;
    let v = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      let d = -1;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (hex && c >= 97 && c <= 102) d = c - 87;
      else if (hex && c >= 65 && c <= 70) d = c - 55;
      if (d < 0) break;
      v = v * (hex ? 16 : 10) + d; j++;
      if (v > 0x10FFFF) return false;
    }
    return j > st && j < n && s.charCodeAt(j) === 59;
  }
  let j = i + 1;
  while (j < n && isLetterDigit(s.charCodeAt(j))) j++;
  return j > i + 1 && j < n && s.charCodeAt(j) === 59;
}

// An entity reference starting at s[i] ('&'): returns [textToEmit, endIndex]
// or null when it is not a valid reference. Named references are emitted
// exactly as written; numeric ones decode to the character (0 and surrogates
// become U+FFFD, out-of-range stays literal).
function decodeEntity(s, i) {
  const n = s.length;
  if (s.charCodeAt(i + 1) === 35) {
    let j = i + 2, hex = false;
    if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
    const st = j;
    let v = 0, digits = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      let d = -1;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (hex && c >= 97 && c <= 102) d = c - 87;
      else if (hex && c >= 65 && c <= 70) d = c - 55;
      if (d < 0) break;
      v = v * (hex ? 16 : 10) + d; digits++; j++;
    }
    if (digits === 0 || j >= n || s.charCodeAt(j) !== 59 || v > 0x10FFFF) return null;
    if (v === 0 || (v >= 0xD800 && v <= 0xDFFF)) v = 0xFFFD;
    return [String.fromCodePoint(v), j + 1, true];
  }
  let j = i + 1;
  while (j < n && isLetterDigit(s.charCodeAt(j))) j++;
  if (j === i + 1 || j >= n || s.charCodeAt(j) !== 59) return null;
  return [s.slice(i, j + 1), j + 1, false];
}

// Column (tab-aware, tab = next multiple of 4) of first non-space char, and its index.
function indentInfo(s) {
  let col = 0, i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return [col, i];
}
function isBlankLine(s) { return indentInfo(s)[1] >= s.length; }

// Remove up to `cols` columns of leading indent; a tab straddling the boundary
// becomes the remaining spaces.
function stripCols(s, cols) {
  let col = 0, i = 0;
  while (i < s.length && col < cols) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const next = col + 4 - (col % 4);
      if (next <= cols) { col = next; i++; }
      else { return ' '.repeat(next - cols) + s.slice(i + 1); }
    } else break;
  }
  return s.slice(i);
}

// Strip `cols` columns starting at string index `start` (absolute column
// `absCol`); a tab straddling the boundary leaves its remainder as spaces.
// Non-space chars count as one column each (list markers, '>'). The leading
// tabs of the result are expanded to spaces, so the result is self-contained
// for later column math.
function stripPrefix(s, start, cols, absCol) {
  let col = absCol, i = start;
  const target = absCol + cols;
  while (i < s.length && col < target) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const next = col + 4 - (col % 4);
      if (next <= target) { col = next; i++; }
      else return expandLead(' '.repeat(next - target) + s.slice(i + 1), target);
    } else { col++; i++; }
  }
  return expandLead(s.slice(i), col);
}

// Expand the leading tabs of `s` to spaces, counting columns from `baseCol`.
function expandLead(s, baseCol) {
  let i = 0, col = baseCol, out = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; i++; }
    else break;
  }
  return i === 0 ? s : out + s.slice(i);
}

// Like stripCols, but for lines that will be parsed as blocks again: the
// result's leading tabs are expanded to spaces.
function stripColsE(s, cols) {
  let col = 0, i = 0;
  while (i < s.length && col < cols) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const next = col + 4 - (col % 4);
      if (next <= cols) { col = next; i++; }
      else return expandLead(' '.repeat(next - cols) + s.slice(i + 1), cols);
    } else break;
  }
  return expandLead(s.slice(i), col);
}

// Strip lazy-continuation marks (\u0001) from the front of a line.
// Several can accumulate when a lazy line passes through nested
// blockquotes/lists (cm-250/251/292/293).
function stripLazyMark(s) {
  let k = 0;
  while (k < s.length && s.charCodeAt(k) === 1) k++;
  return k === 0 ? s : s.slice(k);
}

// Strip leading spaces/tabs of a line (paragraph continuation lines).
function stripLead(s) {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  return s.slice(i);
}

// marked's cleanUrl: encodeURI, then restore '%' (so %20 stays %20).
function encodeHref(s) {
  try { return encodeURI(s).replace(/%25/g, '%'); } catch { return s; }
}

function normalizeLabel(s) {
  // marked's folding trick: lower->upper->lower folds ß/ẞ to "ss" (cm-540).
  return s.trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// A link label is invalid when it contains an unescaped '[': labels end at
// the first ']' and may not hold brackets (cm-547/548/590).
function validLabel(s) {
  if (s.length === 0 || s.length > 999) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) { i++; continue; }
    if (c === 91) return false;
  }
  return true;
}

// ---------------- inline parsing ----------------
// Parts: strings (already HTML-escaped text) or nodes:
// {k:1 em} {k:2 strong} {k:3 del} {k:4 code, s} {k:5 link, href, title, c}
// {k:6 img, src, alt, title} {k:7 html, s} {k:8 br} {k:9 delim, ch, n, open, close}

function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 ||
    (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000;
}

function renderParts(parts) {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (typeof p === 'string') { out += p; continue; }
    switch (p.k) {
      case 1: out += '<em>' + renderParts(p.c) + '</em>'; break;
      case 2: out += '<strong>' + renderParts(p.c) + '</strong>'; break;
      case 3: out += '<del>' + renderParts(p.c) + '</del>'; break;
      case 4: out += '<code>' + p.s + '</code>'; break;
      case 5: out += '<a href="' + p.href + '"' + (p.title !== null ? ' title="' + p.title + '"' : '') + '>' + renderParts(p.c) + '</a>'; break;
      case 6: out += '<img src="' + p.src + '" alt="' + p.alt + '"' + (p.title !== null ? ' title="' + p.title + '"' : '') + '>'; break;
      case 7: out += p.s; break;
      case 8: out += '<br>'; break;
      case 9: out += p.ch.repeat(p.n); break;
    }
  }
  return out;
}

function plainText(parts) {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (typeof p === 'string') out += p;
    else if (p.k === 4) out += p.raw !== undefined ? p.raw : p.s;
    else if (p.k === 5 || p.k === 1 || p.k === 2 || p.k === 3) out += plainText(p.c);
    else if (p.k === 6) out += p.rawAlt !== undefined ? p.rawAlt : p.alt;
    else if (p.k === 7) out += p.s;
    else if (p.k === 9) out += p.ch.repeat(p.n);
  }
  return out;
}

// Does this parsed inline tree contain an EXPLICIT link node? A link's
// text may not hold another (explicit) link (cm-518/519/532/533): when
// it does, the outer link never forms and the inner one stands.
// Autolinks do NOT count: marked still forms the outer link around an
// angle autolink, and bare-URL autolinks are disabled inside link text
// (inLink) so they never occur there.
function containsLink(parts) {
  for (const p of parts) {
    if (typeof p !== 'object') continue;
    if (p.k === 5 && !p.auto) return true;
    if ((p.k === 1 || p.k === 2 || p.k === 3) && containsLink(p.c)) return true;
  }
  return false;
}

function processEmphasis(parts) {
  const stack = [];
  for (let ai = 0; ai < parts.length; ai++) {
    const d = parts[ai];
    if (typeof d !== 'object' || d.k !== 9) continue;
    if (!parts.includes(d)) continue;
    if (d.close) {
      // Splicing children/opener/closer out of `parts` shifts every later
      // element left; re-anchor ai so the element after d is not skipped
      // (without this the 2nd emphasis pair in a paragraph stays literal).
      let shift = 0;
      while (d.n > 0 && parts.includes(d)) {
        let idx = stack.length - 1, opener = null;
        while (idx >= 0) {
          const o = stack[idx];
          if (!o.open || !parts.includes(o) || o.ch !== d.ch) { idx--; continue; }
          // Rule of 3 (spec rule 9): when either run can both open and close
          // and the lengths sum to a multiple of 3, they cannot match unless
          // both lengths are themselves multiples of 3 (cm-411/412/416/417).
          const oddMatch = (o.open && o.close) || (d.open && d.close);
          if (oddMatch && (o.n + d.n) % 3 === 0 && (o.n % 3 !== 0 || d.n % 3 !== 0)) { idx--; continue; }
          opener = o; break;
        }
        if (!opener) break;
        const use = opener.n >= 2 && d.n >= 2 ? 2 : 1;
        const kind = d.ch === '~' ? 3 : use === 2 ? 2 : 1;
        const oi = parts.indexOf(opener), ci = parts.indexOf(d);
        if (oi < 0 || ci < 0 || ci <= oi) break;
        const children = parts.slice(oi + 1, ci);
        // Delimiters swallowed into the new node can no longer open
        // emphasis (cm-469/470): drop them from the opener stack.
        for (const ch of children) {
          if (typeof ch === 'object' && ch.k === 9) {
            const si = stack.indexOf(ch);
            if (si >= 0) stack.splice(si, 1);
          }
        }
        parts.splice(oi + 1, ci - oi - 1, { k: kind, c: children });
        shift += (ci - oi - 1) - 1; // children removed, one node added
        opener.n -= use; d.n -= use;
        if (opener.n === 0) {
          const pi = parts.indexOf(opener);
          if (pi >= 0) { parts.splice(pi, 1); shift += 1; }
          const si = stack.indexOf(opener);
          if (si >= 0) stack.splice(si, 1);
        }
        if (d.n === 0) {
          const pi = parts.indexOf(d);
          if (pi >= 0) { parts.splice(pi, 1); shift += 1; }
          const si = stack.indexOf(d);
          if (si >= 0) stack.splice(si, 1);
        }
      }
      ai -= shift;
    }
    if (d.open && d.n > 0 && parts.includes(d)) stack.push(d);
  }
}

// End index (exclusive) of an autolink '<...>' starting at src[i], or -1.
function autolinkEnd(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const d = src.charCodeAt(j);
    if (d === 32 || d === 60 || d === 62 || d === 10) break;
    j++;
  }
  if (j >= n || src.charCodeAt(j) !== 62) return -1;
  const inner = src.slice(i + 1, j);
  const colon = inner.indexOf(':');
  if (colon > 0) {
    const sch = inner.slice(0, colon);
    if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}$/.test(sch) && colon + 1 < inner.length) return j + 1;
  }
  const em = tryEmailAt(inner, 0);
  if (em && em[1] === inner.length) return j + 1;
  return -1;
}

// Find the index of the ']' matching the '[' at src[i]; -1 if none.
function findBracket(src, i) {
  const n = src.length;
  let depth = 0;
  for (let j = i; j < n; j++) {
    const c = src.charCodeAt(j);
    if (c === 92) { j++; continue; }
    if (c === 60) {
      // A '<' that opens an autolink or HTML tag swallows any ']' inside
      // it (cm-524/526/536/538): skip past the whole construct.
      const ae = autolinkEnd(src, j);
      if (ae > 0) { j = ae - 1; continue; }
      const he = parseHtmlTag(src, j);
      if (he > 0) { j = he - 1; continue; }
    }
    if (c === 96) {
      let k = j, run = 0;
      while (k < n && src.charCodeAt(k) === 96) { k++; run++; }
      if (depth === 1) {
        // Marked's label regex: a backtick run at label level needs a
        // closing run of ANY length (`` ``fixes` `` is a code span for
        // label matching — doc-06/09/12), or 2+ backticks right before
        // ] (`` ``+(?=\]) ``, `[foo ``](x)`); otherwise the label fails.
        if (run >= 2 && k < n && src.charCodeAt(k) === 93) { j = k - 1; continue; }
        let m = k;
        while (m < n) {
          if (src.charCodeAt(m) === 96) {
            let q = m;
            while (q < n && src.charCodeAt(q) === 96) q++;
            j = q - 1; break;
          }
          m++;
        }
        if (m >= n) return -1;
      } else {
        // Inside nested brackets backticks are plain characters (the
        // nested pattern allows them): just skip the run.
        j = k - 1;
      }
      continue;
    }
    if (c === 91) depth++;
    else if (c === 93) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

function unescapeStr(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunctCode(s.charCodeAt(i + 1))) {
      if (i > start) out += s.slice(start, i);
      out += s[i + 1]; start = i + 2; i++;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function skipWs(src, i) {
  while (i < src.length && isSpaceCode(src.charCodeAt(i))) i++;
  return i;
}

// Parse a link destination starting at src[i]; returns [dest, nextIndex] or null.
function parseDest(src, i) {
  const n = src.length;
  if (i >= n) return null;
  if (src.charCodeAt(i) === 60) {
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 10 || c === 60) return null;
      if (c === 62) return [unescapeStr(src.slice(i + 1, j)), j + 1];
      if (c === 92) j++;
      j++;
    }
    return null;
  }
  let j = i, depth = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) break;
    if (c === 92 && j + 1 < n && isAsciiPunctCode(src.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 40) depth++;
    else if (c === 41) { if (depth === 0) break; depth--; }
    else if (c < 32) return null;
    j++;
  }
  if (j === i) return null;
  return [unescapeStr(src.slice(i, j)), j];
}

// Parse a link title starting at src[i]; returns [title, nextIndex] or null.
function parseTitle(src, i) {
  const n = src.length;
  const c = src.charCodeAt(i);
  if (c !== 34 && c !== 39 && c !== 40) return null;
  const open = c, close = c === 40 ? 41 : c;
  let j = i + 1;
  while (j < n) {
    const cc = src.charCodeAt(j);
    if (cc === 92 && j + 1 < n && isAsciiPunctCode(src.charCodeAt(j + 1))) { j += 2; continue; }
    if (cc === close) return [unescapeStr(src.slice(i + 1, j)), j + 1];
    j++;
  }
  return null;
}

// Parse the tail after a ']' at position j (index just past ']').
// Returns {href, title, end} or null.
function parseLinkTail(src, j, refs, linkText) {
  const n = src.length;
  if (j < n && src.charCodeAt(j) === 40) {
    // Inline link; if it fails to parse, fall through to the shortcut
    // reference link (cm-568: "[foo](not a link)" still links via [foo]).
    let k = skipWs(src, j + 1);
    if (k < n && src.charCodeAt(k) === 41) return { href: '', title: null, end: k + 1 };
    const d = parseDest(src, k);
    if (d) {
      k = skipWs(src, d[1]);
      let title = null, ok = true;
      if (k < n && src.charCodeAt(k) !== 41) {
        const t = parseTitle(src, k);
        if (!t) ok = false;
        else { title = t[0]; k = skipWs(src, t[1]); }
      }
      if (ok && k < n && src.charCodeAt(k) === 41) return { href: d[0], title, end: k + 1 };
    }
  } else if (j < n && src.charCodeAt(j) === 91) {
    // Full / collapsed reference link; a failed lookup does NOT fall
    // through to the shortcut (marked: "[foo][bar]" stays literal when
    // only [foo] is defined).
    const close = findBracket(src, j);
    if (close >= 0) {
      const label = src.slice(j + 1, close);
      // Collapsed reference: an empty second label means "use the link
      // text" (cm-553/554/555/566/576/584/585/586) — validLabel('')
      // is false, so the empty case needs its own branch.
      if (label === '' || validLabel(label)) {
        const key = normalizeLabel(label === '' ? linkText : label);
        const ref = refs.get(key);
        if (ref) return { href: ref.dest, title: ref.title, end: close + 1 };
      }
      return null;
    }
    return null;
  }
  if (!validLabel(linkText)) return null;
  const key = normalizeLabel(linkText);
  const ref = refs.get(key);
  if (!ref) return null;
  return { href: ref.dest, title: ref.title, end: j };
}

// Parse an inline HTML tag starting at src[i] ('<'); returns end index or -1.
function parseHtmlTag(src, i) {
  const n = src.length;
  let j = i + 1;
  if (src.startsWith('<!--', i)) {
    // Abruptly closed comments (marked's comment regex): <!--> and <!--->.
    if (src.charCodeAt(i + 4) === 62) return i + 5;
    if (src.charCodeAt(i + 4) === 45 && src.charCodeAt(i + 5) === 62) return i + 6;
    const e = src.indexOf('-->', i + 4);
    return e < 0 ? -1 : e + 3;
  }
  if (src.startsWith('<?', i)) {
    const e = src.indexOf('?>', i + 2);
    return e < 0 ? -1 : e + 2;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const e = src.indexOf(']]>', i + 9);
    return e < 0 ? -1 : e + 3;
  }
  if (src.charCodeAt(j) === 33) {
    j++;
    if (j >= n || !((src.charCodeAt(j) >= 65 && src.charCodeAt(j) <= 90) || (src.charCodeAt(j) >= 97 && src.charCodeAt(j) <= 122))) return -1;
    while (j < n && src.charCodeAt(j) !== 62) j++;
    return j >= n ? -1 : j + 1;
  }
  let closing = false;
  if (src.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n) return -1;
  const c0 = src.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (closing) {
    while (j < n && isSpaceCode(src.charCodeAt(j))) j++;
    return j < n && src.charCodeAt(j) === 62 ? j + 1 : -1;
  }
  while (j < n) {
    // An attribute must be preceded by whitespace (cm-609/622: <m:abc>
    // and <a href='bar'title=title> are not tags).
    let ws = 0;
    while (j < n && isSpaceCode(src.charCodeAt(j))) { j++; ws++; }
    if (j >= n) return -1;
    const c = src.charCodeAt(j);
    if (c === 62) return j + 1;
    if (c === 47) { j++; if (j < n && src.charCodeAt(j) === 62) return j + 1; return -1; }
    if (ws === 0) return -1;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return -1;
    while (j < n) {
      const d = src.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    // Whitespace after the attribute name belongs to the NEXT attribute
    // unless it is followed by '=' (cm-616: valueless `_boolean`
    // followed by `zoop:33=...` — consuming the space here made the
    // next attribute fail the ws===0 check at loop top).
    const saveWs = j;
    while (j < n && isSpaceCode(src.charCodeAt(j))) j++;
    if (j < n && src.charCodeAt(j) === 61) {
      j++;
      while (j < n && isSpaceCode(src.charCodeAt(j))) j++;
      if (j >= n) return -1;
      const q = src.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && src.charCodeAt(j) !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        if (j >= n) return -1;
        while (j < n) {
          const d = src.charCodeAt(j);
          if (isSpaceCode(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          j++;
        }
        if (j >= n) return -1;
      }
    } else {
      j = saveWs; // no '=': the space separates the next attribute
    }
  }
  return -1;
}

function isEmailLocalCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    '.!#$%&\'*+/=?^_`{|}~-'.indexOf(String.fromCharCode(c)) >= 0;
}
function isDomainCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45;
}

// Scan a domain starting at src[i]; returns [end, dotCount] or null.
function scanDomain(src, i) {
  const n = src.length;
  let j = i, dots = 0;
  while (true) {
    if (j >= n || !isDomainCode(src.charCodeAt(j))) return null;
    const ls = j;
    while (j < n && isDomainCode(src.charCodeAt(j))) j++;
    if (src.charCodeAt(j - 1) === 45) return null;
    if (j === ls) return null;
    if (j < n && src.charCodeAt(j) === 46 && j + 1 < n && isDomainCode(src.charCodeAt(j + 1))) { dots++; j++; continue; }
    break;
  }
  return [j, dots];
}

// Strip trailing punctuation from a candidate autolink [start,end);
// returns new end. Mirrors marked's _backpedal regex for extended
// autolinks: the URL is the longest prefix matching
// /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/
// - a trailing run of ?!.,:;*_'"~) is dropped (so a closing * or _
//   stays available as an emphasis delimiter, doc-01);
// - a balanced (...) group is kept, an unmatched ( ends the URL;
// - & starting an entity reference (name; at the very end) ends it.
function stripAutolinkTail(src, start, end) {
  const PUNCT_TAIL = '?!.,:;*_\'"~)';
  let i = start, validEnd = start;
  while (i < end) {
    const c = src[i];
    if (c === '(') {
      let j = i + 1;
      while (j < end && src[j] !== ')') j++;
      if (j >= end) break; // no closing ')' in the candidate: stop here
      i = j + 1; validEnd = i; continue;
    }
    if (c === '&') {
      let j = i + 1;
      while (j < end && ((src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57) ||
        (src.charCodeAt(j) >= 65 && src.charCodeAt(j) <= 90) ||
        (src.charCodeAt(j) >= 97 && src.charCodeAt(j) <= 122))) j++;
      if (j > i + 1 && j + 1 === end && src[j] === ';') break; // entity at end
      i++; validEnd = i; continue;
    }
    if (PUNCT_TAIL.indexOf(c) >= 0) {
      let j = i;
      while (j < end && PUNCT_TAIL.indexOf(src[j]) >= 0) j++;
      if (j >= end) break; // trailing punctuation run: drop it
      i = j; validEnd = j; continue;
    }
    i++; validEnd = i;
  }
  return validEnd;
}

// Try an extended autolink (www. / scheme:// / email / scheme:email) at src[i].
// Returns {href, text, end} or null. Caller guarantees word-start position.
// pendUnd is the count of still-open _ delimiters (see tryBareEmailAt).
function tryExtAutolink(src, i, pendUnd) {
  const n = src.length;
  // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
  if (isLetterDigit(src.charCodeAt(i)) && src.charCodeAt(i) < 128 &&
      ((src.charCodeAt(i) >= 65 && src.charCodeAt(i) <= 90) || (src.charCodeAt(i) >= 97 && src.charCodeAt(i) <= 122))) {
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) j++;
      else break;
    }
    if (j - i >= 2 && j - i <= 32 && j < n && src.charCodeAt(j) === 58) {
      const scheme = src.slice(i, j);
      // scheme://host/path
      if (src.charCodeAt(j + 1) === 47 && src.charCodeAt(j + 2) === 47) {
        const d = scanDomain(src, j + 3);
        if (d && d[1] >= 1) {
          let e = d[0];
          while (e < n) {
            const c = src.charCodeAt(e);
            if (isSpaceCode(c) || c === 60 || c === 34) break;
            e++;
          }
          e = stripAutolinkTail(src, i, e);
          const text = src.slice(i, e);
          return { href: text, text, end: e };
        }
      }
      // scheme:email[/one-segment]
      const em = tryBareEmailAt(src, j + 1, pendUnd);
      if (em) {
        let e = em[1];
        if (e < n && src.charCodeAt(e) === 47) {
          let k = e + 1;
          while (k < n) {
            const c = src.charCodeAt(k);
            if (isSpaceCode(c) || c === 60 || c === 47 || c === 34) break;
            k++;
          }
          if (k > e + 1) e = stripAutolinkTail(src, i, k);
        }
        const text = src.slice(i, e);
        return { href: text, text, end: e };
      }
    }
  }
  // www.domain/path
  if (src.startsWith('www.', i)) {
    const d = scanDomain(src, i + 4);
    if (d && d[1] >= 1) {
      let e = d[0];
      while (e < n) {
        const c = src.charCodeAt(e);
        if (isSpaceCode(c) || c === 60 || c === 34) break;
        e++;
      }
      e = stripAutolinkTail(src, i, e);
      const text = src.slice(i, e);
      return { href: 'http://' + text, text, end: e };
    }
    return null;
  }
  // bare email
  const em = tryBareEmailAt(src, i, pendUnd);
  if (em) {
    const text = src.slice(i, em[1]);
    return { href: 'mailto:' + text, text, end: em[1] };
  }
  return null;
}

// Bare-email local part per marked's url regex It: [A-Za-z0-9._+-]
// (narrower than isEmailLocalCode: !#$%&'*+/=?^`{|}~ are NOT local
// chars here, so a!b@c.com linkifies only b@c.com).
function isBareEmailLocalCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 95 || c === 43 || c === 45;
}
function isBareDomainCode(c) { // [A-Za-z0-9_-]
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
}
function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Domain of marked's bare-email regex It:
// [A-Za-z0-9-_]+ (?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+  over src[s..e).
function bareDomainValid(src, s, e) {
  let idx = s;
  if (idx >= e || !isBareDomainCode(src.charCodeAt(idx))) return false;
  while (idx < e && isBareDomainCode(src.charCodeAt(idx))) idx++;
  let groups = 0;
  while (idx < e) {
    if (src.charCodeAt(idx) !== 46) return false;
    idx++;
    const gs = idx;
    while (idx < e && isBareDomainCode(src.charCodeAt(idx))) idx++;
    if (idx === gs) return false;
    if (!isAlnumCode(src.charCodeAt(idx - 1))) return false;
    groups++;
  }
  return groups >= 1;
}

// Bare-email match mirroring marked's url regex It:
// [A-Za-z0-9._+-]+ @ [A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+ (?![\w-])
// Greedy with backtracking: the longest domain prefix satisfying the
// lookahead wins, so because@mark.example.com_ links because@mark.example
// (the .com is left literal) while because@mark.example.com_x links whole.
// Used for bare emails and scheme:email; angle autolinks keep the strict
// tryEmailAt (marked's wt regex has no _ in domain labels).
// pendUnd: number of still-open _ delimiters before this position. When
// the domain is followed by a _ run that closes one of them, marked
// matches the email inside the emphasis text (without the closer), so the
// full domain stands: __because@bar.com__ links the whole address.
function tryBareEmailAt(src, i, pendUnd) {
  const n = src.length;
  let j = i;
  while (j < n && isBareEmailLocalCode(src.charCodeAt(j))) j++;
  if (j === i || j >= n || src.charCodeAt(j) !== 64) return null;
  let k = j + 1;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (isAlnumCode(c) || c === 45 || c === 95 || c === 46) k++; else break;
  }
  let backEnd = -1, fullEnd = -1;
  for (let e = k; e > j + 1; e--) {
    if (!isAlnumCode(src.charCodeAt(e - 1))) continue;
    if (!bareDomainValid(src, j + 1, e)) continue;
    if (fullEnd < 0) fullEnd = e;
    if (e < n) {
      const c = src.charCodeAt(e);
      if (isAlnumCode(c) || c === 45 || c === 95) continue;
    }
    backEnd = e;
    break;
  }
  if (fullEnd < 0) return null;
  let end = backEnd;
  if ((end < 0 || fullEnd > end) && pendUnd > 0 && src.charCodeAt(fullEnd) === 95) end = fullEnd;
  if (end < 0) return null;
  return [i, end];
}

// Try an email address at src[i]; returns [start, end] or null.
function tryEmailAt(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && isEmailLocalCode(src.charCodeAt(j))) j++;
  if (j === i || j >= n || src.charCodeAt(j) !== 64) return null;
  const d = scanDomain(src, j + 1);
  if (!d || d[1] < 1) return null;
  const e = d[0];
  if (e < n && (src[e] === '-' || src[e] === '_')) return null;
  return [i, e];
}

function parseInlineParts(src, refs, inLink) {
  const parts = [];
  const n = src.length;
  let i = 0, ts = 0, pendUnd = 0;
  // In a raw block (<pre>/<code>/<kbd>/<script>) text is output
  // verbatim: no entity decoding, no escaping (marked inlineText
  // escaped flag).
  const flush = (to) => { if (to > ts) parts.push(DOCST.inRawBlock ? src.slice(ts, to) : escText(src.slice(ts, to))); };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) { // backslash
      const nc = i + 1 < n ? src.charCodeAt(i + 1) : -1;
      if (nc >= 0 && isAsciiPunctCode(nc)) {
        flush(i); parts.push(escText(src[i + 1])); i += 2; ts = i; continue;
      }
      if (nc === 10) { flush(i); parts.push({ k: 8 }); i += 2; while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++; ts = i; continue; }
      i++; continue;
    }
    if (c === 96) { // code span
      flush(i);
      let j = i, run = 0;
      while (j < n && src.charCodeAt(j) === 96) { j++; run++; }
      let close = -1, closeEnd = -1, m = j;
      while (m < n) {
        if (src.charCodeAt(m) === 96) {
          let q = m, r2 = 0;
          while (q < n && src.charCodeAt(q) === 96) { q++; r2++; }
          if (r2 === run) { close = m; closeEnd = q; break; }
          m = q;
        } else m++;
      }
      if (close < 0) { parts.push('`'.repeat(run)); i = j; ts = i; continue; }
      let content = src.slice(j, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      parts.push({ k: 4, s: escText(content), raw: content });
      i = closeEnd; ts = i; continue;
    }
    if (c === 60) { // '<' autolink or HTML
      const ae = autolinkEnd(src, i);
      if (ae > 0) {
        const inner = src.slice(i + 1, ae - 1);
        const colon = inner.indexOf(':');
        const isMail = !(colon > 0 && /^[A-Za-z][A-Za-z0-9+.-]{1,31}$/.test(inner.slice(0, colon)) && colon + 1 < inner.length);
        flush(i);
        parts.push({ k: 5, href: escAttr((isMail ? 'mailto:' : '') + encodeHref(inner)), title: null, c: [escText(inner)], auto: true });
        i = ae; ts = i; continue;
      }
      const he = parseHtmlTag(src, i);
      if (he > 0) {
        flush(i);
        const tag = src.slice(i, he);
        // marked tag(): <a␣...> sets inLink (only with a space after a;
        // <a>, <a\t, <a\n do not), </a> clears it; <pre|code|kbd|script>
        // sets inRawBlock, its end tag clears it. inLink persists for
        // the whole document (doc-03); inRawBlock resets per block-level
        // inline tokenization (parseInline).
        if (!DOCST.inLink && /^<a /i.test(tag)) DOCST.inLink = true;
        else if (DOCST.inLink && /^<\/a>/i.test(tag)) DOCST.inLink = false;
        if (!DOCST.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) DOCST.inRawBlock = true;
        else if (DOCST.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) DOCST.inRawBlock = false;
        parts.push({ k: 7, s: tag }); i = he; ts = i; continue;
      }
      i++; continue;
    }
    if (c === 38) { // '&' entity (not decoded inside a raw block)
      if (DOCST.inRawBlock) { i++; continue; }
      const de = decodeEntity(src, i);
      if (de) { flush(i); parts.push(de[2] ? escText(de[0]) : de[0]); i = de[1]; ts = i; continue; }
      i++; continue;
    }
    if (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91) { // image
      const close = findBracket(src, i + 1);
      if (close >= 0) {
        const inner = src.slice(i + 2, close);
        const tail = parseLinkTail(src, close + 1, refs, inner);
        if (tail) {
          // marked De(): inLink is saved/restored around link-text
          // tokenization; inRawBlock is NOT restored for images (a <pre>
          // inside alt text leaks into the rest of this tokenization).
          const saveLink = DOCST.inLink;
          const children = parseInlineParts(inner, refs, true);
          DOCST.inLink = saveLink;
          const rawAlt = plainText(children);
          flush(i);
          parts.push({ k: 6, src: escAttr(encodeHref(tail.href)), alt: escAttr(rawAlt), rawAlt, title: tail.title !== null ? escAttr(tail.title) : null });
          i = tail.end; ts = i; continue;
        }
      }
      i++; continue;
    }
    if (c === 91) { // '[' link
      const close = findBracket(src, i);
      if (close >= 0) {
        const inner = src.slice(i + 1, close);
        const tail = parseLinkTail(src, close + 1, refs, inner);
        if (tail) {
          const saveLink = DOCST.inLink, saveRaw = DOCST.inRawBlock;
          const children = parseInlineParts(inner, refs, true);
          // marked De(): if the link text emitted a link, the outer
          // link never forms AND inRawBlock is restored; otherwise only
          // inLink is restored and inRawBlock leaks.
          if (containsLink(children)) { DOCST.inLink = saveLink; DOCST.inRawBlock = saveRaw; i++; continue; }
          DOCST.inLink = saveLink;
          flush(i);
          parts.push({ k: 5, href: escAttr(encodeHref(tail.href)), title: tail.title !== null ? escAttr(tail.title) : null, c: children });
          i = tail.end; ts = i; continue;
        }
      }
      i++; continue;
    }
    if (c === 42 || c === 95 || c === 126) { // emphasis delimiters
      flush(i);
      let j = i, run = 0;
      while (j < n && src.charCodeAt(j) === c) { j++; run++; }
      if (c === 126 && run >= 3) { parts.push('~'.repeat(run)); i = j; ts = i; continue; }
      const prev = i > 0 ? src.charCodeAt(i - 1) : -1;
      const next = j < n ? src.charCodeAt(j) : -1;
      const prevSpace = prev < 0 || isSpaceCode(prev);
      const prevPunct = prev >= 0 && isPunctCode(prev);
      const nextSpace = next < 0 || isSpaceCode(next);
      const nextPunct = next >= 0 && isPunctCode(next);
      const leftFlank = !nextSpace && (!nextPunct || prevSpace || prevPunct);
      const rightFlank = !prevSpace && (!prevPunct || nextSpace || nextPunct);
      let open, close2;
      if (c === 95) {
        open = leftFlank && (!rightFlank || prevPunct);
        close2 = rightFlank && (!leftFlank || nextPunct);
        // Open _ delimiters still pending when an email is scanned:
        // a _ run after the email domain closes one of them, so the
        // email is matched without the closer (see tryBareEmailAt).
        if (open) pendUnd += run;
        if (close2) pendUnd = Math.max(0, pendUnd - run);
      } else {
        open = leftFlank; close2 = rightFlank;
      }
      parts.push({ k: 9, ch: src[i], n: run, open, close: close2 });
      i = j; ts = i; continue;
    }
    if (c === 10) { // line break
      flush(i);
      let sp = 0, k = i - 1;
      while (k >= ts && src.charCodeAt(k) === 32) { sp++; k--; }
      if (sp >= 2) {
        const last = parts[parts.length - 1];
        if (typeof last === 'string') {
          let t = last;
          while (t.length > 0 && t.charCodeAt(t.length - 1) === 32) t = t.slice(0, -1);
          if (t === '') parts.pop(); else parts[parts.length - 1] = t;
        }
        parts.push({ k: 8 });
      } else {
        parts.push('\n');
      }
      i++;
      if (parts[parts.length - 1] && parts[parts.length - 1].k === 8) {
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
      }
      ts = i; continue;
    }
    // Extended autolinks (bare URL / www. / email) are disabled inside
    // link or image text (marked state.inLink — doc-01: a bare URL in
    // link text stays plain text and the outer link forms) and anywhere
    // after an unclosed <a␣...> tag earlier in the document (doc-03:
    // DOCST.inLink persists across paragraphs).
    // An email may start at any [A-Za-z0-9._+-] char (digits, '.', '_',
    // '+', '-' included: 1@a.com, .a@b.com linkify), and at the start
    // of a text run (right after a delimiter/code/link/html construct:
    // __because@x__ linkifies) or after a char that is not a bare-email
    // local char (a!b@c.com links b@c.com — '!' breaks the local part).
    if (!inLink && !DOCST.inLink && isBareEmailLocalCode(c) && (i === ts || !isBareEmailLocalCode(src.charCodeAt(i - 1)))) {
      const a = tryExtAutolink(src, i, pendUnd);
      if (a) {
        flush(i);
        parts.push({ k: 5, href: escAttr(encodeHref(a.href)), title: null, c: [escText(a.text)], auto: true });
        i = a.end; ts = i; continue;
      }
    }
    i++;
  }
  flush(n);
  processEmphasis(parts);
  return parts;
}

function parseInline(src, refs) {
  DOCST.inRawBlock = false; // marked lex(): reset before each queued item
  return renderParts(parseInlineParts(src, refs));
}

// ---------------- block parsing ----------------

// How many leading lines of `lines` are link reference definitions.
function countDefLines(lines, refs) {
  let n = 0;
  while (n < lines.length) {
    const d = parseRefDef(lines, n, refs);
    if (d === 0) break;
    n += d;
  }
  return n;
}

// Does the previous (already stripped) line of a list item / blockquote
// allow a non-indented line after it to be a lazy continuation?
// Marked's list tokenizer rule (doc-02): a lazy line is appended unless
// the previous line was blank, is indented >= 4 columns (indented
// code), or starts a fence / ATX heading / HTML block / thematic
// break. In particular a line of fence CONTENT does not block laziness
// — `function f(a, b) {` at indent 0 inside an item's ```css fence is
// still item content. This replaces the too-strict "last block must be
// a paragraph" gate.
function prevLineAllowsLazy(prev) {
  if (prev === '') return false;
  const [pi, px] = indentInfo(prev);
  if (pi >= 4) return false;
  const rest = prev.slice(px);
  if (rest.length === 0) return false;
  const c = rest.charCodeAt(0);
  if (c === 35) {
    let j = 0;
    while (j < rest.length && rest.charCodeAt(j) === 35) j++;
    if (j <= 6 && (j === rest.length || rest.charCodeAt(j) === 32 || rest.charCodeAt(j) === 9)) return false;
  }
  if (c === 96 || c === 126) {
    let j = 0;
    while (j < rest.length && rest.charCodeAt(j) === c) j++;
    if (j >= 3 && !(c === 96 && rest.slice(j).indexOf('`') >= 0)) return false;
  }
  if (c === 60) { const t = htmlBlockType(rest); if (t >= 1 && t <= 6) return false; }
  if (isThematicBreak(rest)) return false;
  return true;
}

// Is the last top-level block of `lines` a code block? (Reached from a
// lazy line, a closed fence/heading/hr would already have failed
// prevLineAllowsLazy, so a 'c' here is an unclosed fenced code block
// whose content the lazy line joins.)
function lastBlockIsCode(lines, refs, inItem) {
  const blocks = parseBlocks(lines, 0, lines.length, refs, false, false, inItem);
  return blocks.length > 0 && blocks[blocks.length - 1].t === 'c';
}

// Is the deepest last block of `lines` (parsed as blocks) a paragraph?
// Laziness only applies to paragraph continuation lines.
function lastIsParagraph(lines, refs, inItem) {
  if (lines.length === 0) return false;
  const blocks = parseBlocks(lines, 0, lines.length, refs, false, false, inItem);
  if (blocks.length === 0) return false;
  let b = blocks[blocks.length - 1];
  for (;;) {
    if (b.t === 'q') {
      if (b.blocks.length === 0) return false;
      b = b.blocks[b.blocks.length - 1];
    } else if (b.t === 'l') {
      const it = b.items[b.items.length - 1];
      if (!it || it.blocks.length === 0) return false;
      b = it.blocks[it.blocks.length - 1];
    } else break;
  }
  return b.t === 'p';
}

function isThematicBreak(rest) {
  const c = rest.charCodeAt(0);
  if (c !== 42 && c !== 45 && c !== 95) return false;
  let n = 0;
  for (let i = 0; i < rest.length; i++) {
    const d = rest.charCodeAt(i);
    if (d === c) n++;
    else if (d !== 32 && d !== 9) return false;
  }
  return n >= 3;
}

function isSetextLine(rest) {
  if (rest.length === 0) return 0;
  const c = rest.charCodeAt(0);
  if (c !== 61 && c !== 45) return 0;
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === c) i++;
  while (i < rest.length) {
    const d = rest.charCodeAt(i);
    if (d !== 32 && d !== 9) return 0;
    i++;
  }
  return c === 61 ? 1 : 2;
}

// Parse a list marker at the start of `rest`; null if none.
// Returns {bullet, delim, num, empty, contentCol}
function listMarker(line, ind, idx) {
  const rest = line.slice(idx);
  const c = rest.charCodeAt(0);
  if (c === 45 || c === 43 || c === 42) {
    if (rest.length === 1 || rest.charCodeAt(1) === 32 || rest.charCodeAt(1) === 9) {
      return markerInfo(line, ind, idx, true, null, 1);
    }
    return null;
  }
  if (c >= 48 && c <= 57) {
    let j = 0;
    while (j < rest.length && rest.charCodeAt(j) >= 48 && rest.charCodeAt(j) <= 57) j++;
    if (j > 9) return null;
    if (j < rest.length && (rest.charCodeAt(j) === 46 || rest.charCodeAt(j) === 41) &&
        (j + 1 >= rest.length || rest.charCodeAt(j + 1) === 32 || rest.charCodeAt(j + 1) === 9)) {
      const num = parseInt(rest.slice(0, j), 10);
      if (num > 999999999) return null;
      return markerInfo(line, ind, idx, false, rest.charCodeAt(j), j + 1, num);
    }
  }
  return null;
}

function markerInfo(line, ind, idx, bullet, delim, width, num) {
  // Count whitespace columns after the marker.
  let col = ind + width, i = idx + width, ws = 0, wsCols = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; ws++; wsCols++; i++; }
    else if (c === 9) { const nx = col + 4 - (col % 4); wsCols += nx - col; col = nx; ws++; i++; }
    else break;
  }
  const empty = i >= line.length;
  const contentCol = empty ? ind + width + 1 : (wsCols >= 5 ? ind + width + 1 : col);
  return { bullet, delim, num: num === undefined ? 0 : num, empty, contentCol, markerChar: line.charCodeAt(idx) };
}

// HTML block type at a line (rest starts with '<'), 0 = none.
function htmlBlockType(rest) {
  if (rest.charCodeAt(0) !== 60) return 0;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (rest.startsWith('<![CDATA[')) return 5;
  if (rest.charCodeAt(1) === 33) {
    const c = rest.charCodeAt(2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 4;
    return 0;
  }
  let j = 1, closing = false;
  if (rest.charCodeAt(j) === 47) { closing = true; j++; }
  const ns = j;
  while (j < rest.length) {
    const c = rest.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (j === ns) return 0;
  const name = rest.slice(ns, j).toLowerCase();
  const after = j < rest.length ? rest.charCodeAt(j) : -1;
  if (!closing && (name === 'pre' || name === 'script' || name === 'style' || name === 'textarea') &&
      (after === -1 || after === 32 || after === 9 || after === 62 || (after === 47 && rest.charCodeAt(j + 1) === 62))) return 1;
  if (BLOCK_TAGS.has(name) && (after === -1 || after === 32 || after === 9 || after === 62 || (after === 47 && rest.charCodeAt(j + 1) === 62))) return 6;
  // type 7: complete tag alone on the line
  const he = parseHtmlTag(rest, 0);
  if (he > 0) {
    let k = he;
    while (k < rest.length && (rest.charCodeAt(k) === 32 || rest.charCodeAt(k) === 9)) k++;
    if (k >= rest.length) return 7;
  }
  return 0;
}

// Can this line start a block that interrupts a paragraph?
// `inItem`: inside a list item's content, ANY list marker interrupts
// the paragraph (marked tokenizes item text with state.top=false, so
// the line-by-line `text` tokenizer stops at any marker — doc-01
// `505791.`). At top level / in blockquotes only a 1-start ordered
// list (or any bullet) interrupts.
function canInterrupt(line, inItem) {
  const [ind, idx] = indentInfo(line);
  if (ind > 3) return false;
  const rest = line.slice(idx);
  if (rest.length === 0) return false;
  const c = rest.charCodeAt(0);
  if (c === 35) return true;
  if (c === 96 || c === 126) {
    let j = 0;
    while (j < rest.length && rest.charCodeAt(j) === c) j++;
    if (j >= 3) {
      if (c === 96 && rest.slice(j).indexOf('`') >= 0) return false;
      return true;
    }
  }
  if (c === 62) return true;
  if (c === 60) { const t = htmlBlockType(rest); return t >= 1 && t <= 6; }
  if (isThematicBreak(rest)) return true;
  const m = listMarker(line, ind, idx);
  if (m) {
    if (m.empty) return false;
    if (m.bullet) return true;
    return inItem ? true : m.num === 1;
  }
  return false;
}

// Unescape \| -> | in a table cell fragment (\\ stays \\, other escapes
// stay for inline parsing). A \| inside a code span must also lose its
// backslash (gfm-200: `\|` renders <code>|</code>).
function unescapePipe(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length) {
      const nx = s.charCodeAt(i + 1);
      if (nx === 124) { out += s.slice(start, i) + '|'; i++; start = i + 1; }
      else if (nx === 92) i++;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function splitTableRow(line) {
  const cells = [];
  let cur = '', i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      const nx = line.charCodeAt(i + 1);
      if (nx === 92) { cur += '\\\\'; i += 2; continue; }
      if (nx === 124) { cur += '|'; i += 2; continue; }
      cur += '\\'; i++; continue;
    }
    if (c === 96) {
      // Backticks do NOT protect pipes in table cells (marked splits
      // `a | b` inside backticks, and an unmatched backtick must not
      // swallow the rest of the row): treat them as ordinary chars.
      // `\|` -> `|` unescaping is handled by the backslash branch
      // above, so `\|` inside a code span still renders as `|`.
      cur += '`'; i++; continue;
    }
    if (c === 124) { cells.push(cur); cur = ''; i++; continue; }
    cur += line[i]; i++;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((s) => s.trim());
}

// Is `line` a table body row in marked's sense? The table regex's row
// part excludes: blank lines (spaces only — a TAB-only line is a ROW,
// doc-02), ATX headings, thematic breaks, blockquotes, fenced code,
// indented code, list markers (bullet or 1-start ordered), HTML blocks.
function isTableRowLine(line) {
  if (/^ *$/.test(line)) return false; // empty or spaces-only (tab-only is a row)
  const [ind, idx] = indentInfo(line);
  const rest = line.slice(idx);
  if (rest.length === 0) return true; // whitespace-only line with a tab: a row
  if (ind >= 4) return false; // indented code (needs a non-space char after the indent)
  const c = rest.charCodeAt(0);
  if (c === 35) {
    let j = 0;
    while (j < rest.length && rest.charCodeAt(j) === 35) j++;
    if (j <= 6 && (j === rest.length || rest.charCodeAt(j) === 32 || rest.charCodeAt(j) === 9)) return false;
  }
  if (c === 96 || c === 126) {
    let j = 0;
    while (j < rest.length && rest.charCodeAt(j) === c) j++;
    if (j >= 3 && !(c === 96 && rest.slice(j).indexOf('`') >= 0)) return false;
  }
  if (c === 62) return false;
  if (c === 60) { const t = htmlBlockType(rest); if (t >= 1 && t <= 6) return false; }
  if (isThematicBreak(rest)) return false;
  const m = listMarker(line, ind, idx);
  if (m && !m.empty && (m.bullet || m.num === 1)) return false;
  return true;
}

function isDelimiterRow(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    let a = 0;
    if (/^:-+:$/.test(t)) a = 2;
    else if (/^-+:$/.test(t)) a = 1;
    else if (/^:-+$/.test(t)) a = 3; // left: marked emits align="left"
    else if (/^-+$/.test(t)) a = 0;
    else return null;
    aligns.push(a);
  }
  return aligns;
}

// Parse a link reference definition starting at lines[k]; returns lines consumed or 0.
// The destination and the title may each sit on a following line, and a title
// may span several lines. Works on the paragraph's remaining lines joined.
function parseRefDef(lines, k, refs) {
  const text = lines.slice(k).join('\n');
  let p = 0, col = 0;
  while (p < text.length) {
    const c = text.charCodeAt(p);
    if (c === 32) { col++; p++; }
    else if (c === 9) { col += 4 - (col % 4); p++; }
    else break;
  }
  if (col > 3) return 0;
  if (text.charCodeAt(p) !== 91) return 0;
  const close = findBracket(text, p);
  if (close < 0) return 0;
  const label = text.slice(p + 1, close);
  if (label.trim() === '' || !validLabel(label)) return 0;
  let q = close + 1;
  if (text.charCodeAt(q) !== 58) return 0;
  q++;
  q = skipWs(text, q);
  let dest = null;
  if (q < text.length && text.charCodeAt(q) === 60) {
    let j = q + 1;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c === 10 || c === 60) return 0;
      if (c === 62) break;
      if (c === 92) j++;
      j++;
    }
    if (j >= text.length) return 0;
    dest = unescapeStr(text.slice(q + 1, j));
    q = j + 1;
  } else {
    let j = q, depth = 0;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92 && j + 1 < text.length && isAsciiPunctCode(text.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) { if (depth === 0) break; depth--; }
      else if (c < 32) return 0;
      j++;
    }
    if (j === q) return 0;
    dest = unescapeStr(text.slice(q, j));
    q = j;
  }
  let title = null, endPos = q;
  let r = q;
  while (r < text.length && (text.charCodeAt(r) === 32 || text.charCodeAt(r) === 9)) r++;
  // Title rules (from spec examples 197/201/209/210):
  // - Same-line title: must be separated from the destination by
  //   whitespace, must be a complete quoted string, and must be followed
  //   only by spaces to end of line. Any violation invalidates the
  //   whole definition.
  // - Next-line title: optional. If well-formed it is used; if malformed
  //   (unterminated, or followed by junk) the definition stands without
  //   a title and the title line stays paragraph text.
  // - Any other junk after the destination invalidates the definition.
  const tryTitle = (at) => {
    const t = parseTitle(text, at);
    if (!t) return false;
    let s = t[1];
    while (s < text.length && (text.charCodeAt(s) === 32 || text.charCodeAt(s) === 9)) s++;
    if (s < text.length && text.charCodeAt(s) !== 10) return false;
    title = t[0]; endPos = t[1];
    return true;
  };
  if (r < text.length && (text.charCodeAt(r) === 34 || text.charCodeAt(r) === 39 || text.charCodeAt(r) === 40)) {
    if (r === q) return 0; // no whitespace between destination and title
    if (!tryTitle(r)) return 0; // same-line title malformed: no definition
  } else if (r < text.length && text.charCodeAt(r) === 10) {
    let s = r + 1;
    while (s < text.length && (text.charCodeAt(s) === 32 || text.charCodeAt(s) === 9)) s++;
    if (s < text.length && (text.charCodeAt(s) === 34 || text.charCodeAt(s) === 39 || text.charCodeAt(s) === 40)) {
      tryTitle(s); // malformed next-line title: definition stands without it
    }
  } else if (r < text.length) {
    return 0;
  }
  const key = normalizeLabel(label);
  if (!refs.has(key)) refs.set(key, { dest, title });
  let consumed = 1;
  for (let i = 0; i < endPos; i++) if (text.charCodeAt(i) === 10) consumed++;
  return consumed;
}

function parseBlocks(lines, start, end, refs, isTop, docEndsNL, inItem) {
  const out = [];
  // Looseness tracking (cm-307/318/319): a block records whether a blank
  // line preceded it AT THIS LEVEL, so a list can tell whether two of
  // its own item's blocks were blank-separated — blanks consumed inside
  // a nested sublist/fence/quote do not leak upward.
  let pendingBlank = false;
  const emit = (b) => { b.blankBefore = pendingBlank; pendingBlank = false; out.push(b); };
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { pendingBlank = true; i++; continue; }
    const [ind, idx] = indentInfo(line);
    const rest = line.slice(idx);
    const c0 = rest.charCodeAt(0);

    // ATX heading
    if (ind <= 3 && c0 === 35) {
      let j = 0;
      while (j < rest.length && rest.charCodeAt(j) === 35) j++;
      if (j <= 6 && (j === rest.length || rest.charCodeAt(j) === 32 || rest.charCodeAt(j) === 9)) {
        let content = rest.slice(j).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        let k = content.length;
        while (k > 0 && content.charCodeAt(k - 1) === 35) k--;
        if (k < content.length && k > 0 && (content.charCodeAt(k - 1) === 32 || content.charCodeAt(k - 1) === 9)) {
          content = content.slice(0, k).replace(/[ \t]+$/, '');
        } else if (k === 0) content = '';
        emit({ t: 'h', lv: j, src: content });
        i++; continue;
      }
    }

    // Fenced code
    if (ind <= 3 && (c0 === 96 || c0 === 126)) {
      let j = 0;
      while (j < rest.length && rest.charCodeAt(j) === c0) j++;
      if (j >= 3 && !(c0 === 96 && rest.slice(j).indexOf('`') >= 0)) {
        const infoRaw = rest.slice(j).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        const info = unescapeStr(infoRaw.split(/[ \t]/)[0] || '');
        const content = [];
        let k = i + 1, closed = false;
        while (k < end) {
          const l2 = lines[k];
          const [ind2, idx2] = indentInfo(l2);
          const r2 = l2.slice(idx2);
          if (ind2 <= 3 && r2.length > 0) {
            let q = 0;
            while (q < r2.length && r2.charCodeAt(q) === c0) q++;
            if (q >= j) {
              let e = q;
              while (e < r2.length && (r2.charCodeAt(e) === 32 || r2.charCodeAt(e) === 9)) e++;
              if (e >= r2.length) { closed = true; break; }
            }
          }
          content.push(stripCols(l2, ind));
          k++;
        }
        if (!closed) {
          // Unclosed fence: content runs to end of input; trailing
          // blank lines are kept modulo the last-line rule below.
        }
        // Fenced content = lines joined with '\n' + a final '\n',
        // except when the last content line is exactly '' (empty):
        // then one trailing '\n' is dropped (marked: "b\n\n\n```" ->
        // "b\n\n", "b\n\n```" -> "b\n", "```\n\n\n```" -> "\n"). A
        // spaces-only last line is NOT empty, so it keeps the '\n'.
        const lastEmpty = content.length > 0 && content[content.length - 1] === '';
        emit({ t: 'c', info, content: content.length ? content.join('\n') + (lastEmpty ? '' : '\n') : '' });
        i = closed ? k + 1 : end;
        continue;
      }
    }

    // Indented code
    if (ind >= 4) {
      const content = [];
      let k = i;
      while (k < end) {
        const l2 = lines[k];
        if (isBlankLine(l2)) {
          let m = k + 1;
          while (m < end && isBlankLine(lines[m])) m++;
          if (m < end && indentInfo(lines[m])[0] >= 4) { content.push(stripCols(l2, 4)); k++; continue; }
          break;
        }
        if (indentInfo(l2)[0] < 4) break;
        content.push(stripCols(l2, 4));
        k++;
      }
      emit({ t: 'c', info: '', content: content.length ? content.join('\n') + '\n' : '' });
      i = k; continue;
    }

    // HTML block
    if (ind <= 3 && c0 === 60) {
      const type = htmlBlockType(rest);
      if (type > 0) {
        const raw = [];
        let k = i, endsAtBlank = false;
        if (type === 1) {
          const tagMatch = rest.match(/^<([A-Za-z]+)/);
          const tag = tagMatch ? tagMatch[1].toLowerCase() : '';
          const closeTag = '</' + tag;
          while (k < end) {
            raw.push(lines[k]);
            if (lines[k].toLowerCase().indexOf(closeTag) >= 0) { k++; break; }
            k++;
          }
        } else if (type === 2) {
          while (k < end) {
            raw.push(lines[k]);
            if (lines[k].indexOf('-->') >= 0) { k++; break; }
            // Abruptly closed comment on the opening line (<!--> / <!--->)
            // ends the block here (marked's comment regex).
            if (k === i) {
              const ci = lines[k].indexOf('<!--');
              if (ci >= 0 && (lines[k].charCodeAt(ci + 4) === 62 ||
                  (lines[k].charCodeAt(ci + 4) === 45 && lines[k].charCodeAt(ci + 5) === 62))) { k++; break; }
            }
            k++;
          }
        } else if (type === 3) {
          while (k < end) { raw.push(lines[k]); if (lines[k].indexOf('?>') >= 0) { k++; break; } k++; }
        } else if (type === 4) {
          while (k < end) { raw.push(lines[k]); if (lines[k].indexOf('>') >= 0) { k++; break; } k++; }
        } else if (type === 5) {
          while (k < end) { raw.push(lines[k]); if (lines[k].indexOf(']]>') >= 0) { k++; break; } k++; }
        } else {
          while (k < end && !isBlankLine(lines[k])) { raw.push(lines[k]); k++; }
          endsAtBlank = k < end;
        }
        // The raw text keeps its final newline unless the next line is blank
        // (or there is none and this is not the top level / the document
        // does not end with a newline).
        const trail = k < end ? !isBlankLine(lines[k]) : (isTop && docEndsNL);
        emit({ t: 'x', raw: raw.length ? raw.join('\n') + (trail ? '\n' : '') : '' });
        i = k; continue;
      }
    }

    // Thematic break
    if (ind <= 3 && isThematicBreak(rest)) { emit({ t: 'hr' }); i++; continue; }

    // Blockquote
    if (ind <= 3 && c0 === 62) {
      const sub = [];
      let k = i;
      while (k < end) {
        const l2 = lines[k];
        const [ind2, idx2] = indentInfo(l2);
        if (ind2 <= 3 && l2.charCodeAt(idx2) === 62) {
          if (idx2 + 1 < l2.length && (l2.charCodeAt(idx2 + 1) === 32 || l2.charCodeAt(idx2 + 1) === 9)) {
            sub.push(stripPrefix(l2, idx2 + 1, 1, ind2 + 1));
          } else {
            sub.push(l2.slice(idx2 + 1));
          }
          k++; continue;
        }
        // A blank line with no '>' marker ends the blockquote (cm-242/252):
        // the next '>' line starts a new blockquote.
        if (isBlankLine(l2)) break;
        // Lazy continuation line of the quote's paragraph: its leading
        // whitespace is stripped, and it is marked with \u0001 so the
        // recursive block parse treats it as paragraph text, never as a
        // block start (cm-238: "    - bar" -> "foo\n- bar"). A setext
        // underline that follows another lazy line is padded with four
        // spaces (marked's blockquoteSetextReplace, cm-093).
        // Lazy continuation line of the quote's paragraph. Unlike list
        // items (marked's list tokenizer), a blockquote gathers lazy
        // lines only as paragraph continuations — a line after an open
        // fence is NOT quote content (doc-01 `used foo_bar_baz used`).
        if (sub.length > 0 && sub[sub.length - 1] !== '' && !canInterrupt(l2) && lastIsParagraph(sub, refs)) {
          let lazy = stripLead(stripLazyMark(l2));
          if (sub[sub.length - 1].charCodeAt(0) === 1) {
            const [li, lx] = indentInfo(lazy);
            if (li <= 3 && isSetextLine(lazy.slice(lx)) > 0) lazy = '    ' + lazy;
          }
          sub.push('\u0001' + lazy);
          k++; continue;
        }
        break;
      }
      emit({ t: 'q', blocks: parseBlocks(sub, 0, sub.length, refs, false, docEndsNL) });
      i = k; continue;
    }

    // List
    if (ind <= 3) {
      const m0 = listMarker(line, ind, idx);
      if (m0) {
        const list = parseList(lines, i, end, refs, ind, m0);
        emit(list.node);
        i = list.next;
        continue;
      }
    }

    // Paragraph (with link ref defs, table, setext)
    {
      const para = [];
      let k = i;
      while (k < end) {
        const l2 = lines[k];
        if (isBlankLine(l2)) {
          // A trailing spaces-only line (last line of this text unit) is
          // paragraph content, not a blank line: marked's paragraph match
          // only treats a whitespace-only line as blank when a newline
          // follows it (cm-241).
          if (l2 !== '' && k === end - 1) { para.push(l2); k++; continue; }
          break;
        }
        if (k > i) {
          // Lazy continuation line (marked \u0001 by a blockquote/list):
          // already stripped, always paragraph text, never a setext
          // underline or a block start.
          if (l2.charCodeAt(0) === 1) { para.push(stripLazyMark(l2)); k++; continue; }
          const [ind2, idx2] = indentInfo(l2);
          const r2 = l2.slice(idx2);
          if (ind2 <= 3 && isSetextLine(r2) > 0) {
            // A setext underline after nothing but link reference
            // definitions is paragraph text, not a heading underline.
            if (countDefLines(para, refs) >= para.length) { para.push(l2); k++; continue; }
            para.push(l2); k++; break;
          }
          if (canInterrupt(l2, inItem)) break;
        }
        para.push(l2.charCodeAt(0) === 1 ? stripLazyMark(l2) : l2);
        k++;
      }
      let consumed = 0;
      while (consumed < para.length) {
        const d = parseRefDef(para, consumed, refs);
        if (d === 0) break;
        consumed += d;
      }
      // A paragraph entirely consumed by link reference definitions
      // emits no block — but a blank line before it still counts as a
      // blank-separated element for list looseness (cm-317: the def
      // line after a blank makes the list loose, like marked's `space`
      // token between the paragraph and the def). Record it on the
      // block array; parseList reads it. Only when a real block
      // precedes it at this level (leading blanks do not count).
      if (consumed >= para.length) {
        if (pendingBlank && out.length > 0) out.blankSepDef = true;
        i = k; continue;
      }
      const rem = para.slice(consumed);
      // Table?
      if (rem.length >= 2) {
        const [indH, idxH] = indentInfo(rem[0]);
        const aligns = isDelimiterRow(rem[1]);
        if (aligns && rem[0].indexOf('|') >= 0) {
          const head = splitTableRow(rem[0]);
          if (head.length === aligns.length) {
            const rows = [];
            for (let r = 2; r < rem.length; r++) {
              const cells = splitTableRow(rem[r]);
              while (cells.length < head.length) cells.push('');
              rows.push(cells.slice(0, head.length));
            }
            // Rows continue past the paragraph's blank-line break while
            // the following lines are table rows in marked's sense (a
            // tab-only line is a row, not a blank — doc-02).
            while (k < end && isTableRowLine(lines[k])) {
              const cells = splitTableRow(lines[k]);
              while (cells.length < head.length) cells.push('');
              rows.push(cells.slice(0, head.length));
              k++;
            }
            emit({ t: 'tb', aligns, head, rows });
            i = k; continue;
          }
        }
      }
      // Setext?
      if (rem.length >= 2) {
        const [indL, idxL] = indentInfo(rem[rem.length - 1]);
        const lv = indL <= 3 ? isSetextLine(rem[rem.length - 1].slice(idxL)) : 0;
        if (lv > 0) {
          emit({ t: 'h', lv, src: rem.slice(0, -1).join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') });
          i = k; continue;
        }
      }
      emit({ t: 'p', src: rem.join('\n') });
      i = k; continue;
    }
  }
  return out;
}

function parseList(lines, start, end, refs, listInd, m0) {
  const bullet = m0.bullet;
  const delim = m0.delim;
  const markerChar = m0.markerChar;
  const items = [];
  let loose = false;
  let i = start;
  let cur = null; // {lines, contentCol, checked}
  const startNum = m0.num;

  const finishItem = () => {
    if (!cur) return;
    // detect task checkbox on first line
    let first = cur.lines[0] || '';
    const fi = indentInfo(first);
    const fr = first.slice(fi[1]);
    let checked = null;
    if (fr.startsWith('[ ]') || fr.startsWith('[x]') || fr.startsWith('[X]')) {
      const after = fr.slice(3);
      if (after === '' || after.charCodeAt(0) === 32 || after.charCodeAt(0) === 9) {
        const restAfter = after.replace(/^[ \t]+/, '');
        const startsBlock = restAfter.startsWith('```') || restAfter.startsWith('~~~') ||
          restAfter.charCodeAt(0) === 35 || restAfter.charCodeAt(0) === 62;
        if (!startsBlock) {
          checked = fr.charCodeAt(1) !== 32;
          cur.lines[0] = first.slice(0, fi[1]) + restAfter;
        }
      }
    }
    cur.checked = checked;
    // Looseness is decided from the item's parsed blocks (blankBefore),
    // not raw lines: blanks inside a nested sublist/fence belong to
    // that nested structure, not to this list (cm-307/318/319).
    // "Items separated by blank lines" is still set in the blank
    // lookahead branch below.
    items.push(cur);
    cur = null;
  };

  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) {
      // look ahead for next non-blank
      let m = i + 1;
      while (m < end && isBlankLine(lines[m])) m++;
      if (m >= end) break;
      const [ind2, idx2] = indentInfo(lines[m]);
      const nm = ind2 <= 3 ? listMarker(lines[m], ind2, idx2) : null;
      const sameList = nm && nm.bullet === bullet && (bullet ? nm.markerChar === markerChar : nm.delim === delim) && ind2 < cur.contentCol;
      if (sameList) {
        loose = true;
        finishItem();
        i = m;
        continue;
      }
      // An item with no content yet followed by a blank line is empty:
      // the list ends and the following content is outside it (cm-280).
      if (cur && !cur.lines.some((l) => !isBlankLine(l))) break;
      if (cur && ind2 >= cur.contentCol) {
        // blank lines inside the item
        while (i < m) { cur.lines.push(''); i++; }
        continue;
      }
      break;
    }
    const [ind2, idx2] = indentInfo(line);
    if (cur === null) {
      const m = listMarker(line, ind2, idx2);
      cur = { lines: [stripPrefix(line, idx2, m.contentCol - ind2, ind2)], contentCol: m.contentCol, checked: null };
      i++; continue;
    }
    if (ind2 < cur.contentCol && ind2 <= 3 && isThematicBreak(line.slice(idx2))) break;
    // A following item joins this list when its marker is indented less
    // than the current item's content indent (cm-295/310/311/312: items
    // with different indents are siblings; a marker at indent >= the
    // content indent belongs to the item, e.g. a child list).
    const nm = ind2 <= 3 ? listMarker(line, ind2, idx2) : null;
    const sameList = nm && nm.bullet === bullet && (bullet ? nm.markerChar === markerChar : nm.delim === delim) && ind2 < cur.contentCol;
    if (sameList) {
      finishItem();
      cur = { lines: [stripPrefix(line, idx2, nm.contentCol - ind2, ind2)], contentCol: nm.contentCol, checked: null };
      i++; continue;
    }
    if (nm && ind2 < cur.contentCol) {
      // A marker of a different type/delimiter/bullet char ALWAYS ends
      // this list (cm-302: "3) baz" after "1./2."; marked: even "- foo"
      // + "2. bar" splits) — the paragraph-interruption rule does not
      // apply inside the list parser, which owns the line.
      break;
    }
    if (ind2 >= cur.contentCol) {
      cur.lines.push(stripColsE(line, cur.contentCol));
      i++; continue;
    }
    if (cur.lines.length > 0 && !canInterrupt(line, true) && prevLineAllowsLazy(cur.lines[cur.lines.length - 1])) {
      // A lazy line after an open fenced code block is fence content
      // (raw, no sentinel — doc-02 `function f(a, b) {`); otherwise
      // paragraph text with the \u0001 sentinel.
      if (lastBlockIsCode(cur.lines, refs, true)) cur.lines.push(line);
      else cur.lines.push('\u0001' + stripLead(stripLazyMark(line)));
      i++; continue;
    }
    break;
  }
  finishItem();
  const parsedItems = items.map((it) => ({ blocks: parseBlocks(it.lines, 0, it.lines.length, refs, false, false, true), checked: it.checked }));
  // A list is loose when any item directly contains two blocks with a
  // blank line between them (blankBefore on any block after the first).
  // Leading blanks of an item do not count (cm-278/279).
  for (const it of parsedItems) {
    for (let bi = 1; bi < it.blocks.length; bi++) {
      if (it.blocks[bi].blankBefore) { loose = true; break; }
    }
    // Blank line before a (consumed) link reference definition inside
    // the item also makes the list loose (cm-317).
    if (it.blocks.blankSepDef) loose = true;
    if (loose) break;
  }
  const node = {
    t: 'l', ord: !bullet, start: startNum, tight: !loose,
    items: parsedItems,
  };
  return { node, next: i };
}

function renderBlocks(blocks, refs) {
  let out = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'p': out += '<p>' + parseInline(b.src, refs) + '</p>\n'; break;
      case 'h': out += '<h' + b.lv + '>' + parseInline(b.src, refs) + '</h' + b.lv + '>\n'; break;
      case 'c':
        out += '<pre><code' + (b.info ? ' class="language-' + escAttr(b.info) + '"' : '') + '>' + escText(b.content) + '</code></pre>\n';
        break;
      case 'x': out += b.raw; break;
      case 'hr': out += '<hr>\n'; break;
      case 'q': out += '<blockquote>\n' + renderBlocks(b.blocks, refs) + '</blockquote>\n'; break;
      case 'l': {
        out += b.ord ? '<ol' + (b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n' : '<ul>\n';
        for (const it of b.items) {
          out += '<li>';
          const cb = it.checked === null ? '' :
            '<input ' + (it.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox">';
          if (it.blocks.length === 0) {
            out += cb;
          } else if (b.tight) {
            for (let bi = 0; bi < it.blocks.length; bi++) {
              const blk = it.blocks[bi];
              if (blk.t === 'p') {
                const inner = parseInline(blk.src, refs);
                out += (bi === 0 && cb ? cb + (inner ? ' ' : '') : '') + inner;
              } else {
                out += (bi === 0 && cb ? cb + ' ' : '') + renderBlocks([blk], refs);
              }
            }
          } else {
            for (let bi = 0; bi < it.blocks.length; bi++) {
              const blk = it.blocks[bi];
              if (blk.t === 'p') {
                out += '<p>' + (bi === 0 && cb ? cb + ' ' : '') + parseInline(blk.src, refs) + '</p>\n';
              } else {
                out += (bi === 0 && cb ? cb + ' ' : '') + renderBlocks([blk], refs);
              }
            }
          }
          out += '</li>\n';
        }
        out += b.ord ? '</ol>\n' : '</ul>\n';
        break;
      }
      case 'tb': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let ci = 0; ci < b.head.length; ci++) {
          out += '<th' + (b.aligns[ci] === 1 ? ' align="right"' : b.aligns[ci] === 2 ? ' align="center"' : b.aligns[ci] === 3 ? ' align="left"' : '') + '>' +
            parseInline(b.head[ci], refs) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.rows.length > 0) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let ci = 0; ci < b.head.length; ci++) {
              out += '<td' + (b.aligns[ci] === 1 ? ' align="right"' : b.aligns[ci] === 2 ? ' align="center"' : b.aligns[ci] === 3 ? ' align="left"' : '') + '>' +
                parseInline(row[ci], refs) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody></table>\n';
        } else {
          out += '</table>\n';
        }
        break;
      }
    }
  }
  return out;
}

// Document-level lexer state, mirroring marked's Lexer.state. inLink
// persists across every inline tokenization in the document (an unclosed
// <a ...> tag in one paragraph disables extended autolinks in all later
// ones — doc-03); inRawBlock is reset before each block-level inline
// tokenization (marked's lex() queue loop) but leaks within one.
const DOCST = { inLink: false, inRawBlock: false };

export function parse(markdown) {
  DOCST.inLink = false; DOCST.inRawBlock = false;
  const src = markdown.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
  let lines = src === '' ? [] : src.split('\n');
  if (src.endsWith('\n')) lines.pop();
  const refs = new Map();
  const blocks = parseBlocks(lines, 0, lines.length, refs, true, src.endsWith('\n'));
  return renderBlocks(blocks, refs);
}
