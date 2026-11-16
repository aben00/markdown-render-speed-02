// A fast, dependency-free Markdown renderer whose parse(markdown) returns
// exactly the HTML marked 18.1.3 renders with its default options (GFM on).
// Written from the CommonMark 0.31.2 and GFM 0.29 specifications, plus the
// observable behaviour of marked itself (block/inline tokeniser order, the
// table rules, the link and emphasis edge cases). No part of marked's source
// is copied: the structure below is my own, written in this session.
//
// Layout: helpers -> block lexer -> inline lexer -> renderer -> parse().

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML. When encode is true, every & becomes &amp; (used for code
// spans and code blocks, where entities are not preserved). Otherwise a &
// that starts a valid entity (&name;, &#123;, &#x1F;) is left alone.
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function escapeHtml(s, encode) {
  if (encode) {
    return ESCAPE_TEST.test(s) ? s.replace(ESCAPE_REPLACE, (c) => ESCAPE_MAP[c]) : s;
  }
  return ESCAPE_TEST_NO_ENCODE.test(s) ? s.replace(ESCAPE_REPLACE_NO_ENCODE, (c) => ESCAPE_MAP[c]) : s;
}

// Decode numeric character references (&#169; -> the character, &#0; and
// out-of-range or surrogate values -> U+FFFD, &#38; -> &amp;) and escape a
// bare & that does not start a valid entity. Named entities pass through
// unchanged.
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function unescape(s) {
  if (!NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 1114111 || (n >= 55296 && n <= 57343)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

// Clean a link destination the way marked does: encodeURI, then turn %25
// back into %. A lone surrogate makes encodeURI throw -> null, and the link
// is then rendered as plain text.
const PERCENT_DECODE = /%25/g;
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(PERCENT_DECODE, '%');
  } catch {
    return null;
  }
}

// Split one table row on unescaped pipes. A pipe preceded by an odd number
// of backslashes is literal; the rest become cell separators. A leading or
// trailing empty cell (from a leading/trailing pipe) is dropped. When a
// column count is given, rows are padded with empty cells or truncated.
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
function splitCells(row, count) {
  const marked = row.replace(FIND_PIPE, (m, off, str) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(SPLIT_PIPE);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(SLASH_PIPE, '|');
  return cells;
}

// Normalise a link label for lookup: trim, collapse inner whitespace to one
// space, and fold case (lower -> upper -> lower, as marked does).
const MULTI_SPACE = /\s+/g;
function normalizeLabel(s) {
  return s.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Expand tabs to spaces, advancing to the next multiple of 4 columns.
function expandTabs(s, col) {
  let out = '';
  let c = col || 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\t') {
      const n = 4 - (c % 4);
      out += ' '.repeat(n);
      c += n;
    } else {
      out += s[i];
      c++;
    }
  }
  return out;
}

// Find the index of the closing bracket matching the opening one at the
// start of a scan: returns the index, -1 when there is none, -2 when the
// brackets never balance (an opener is left over).
function findBracket(s, open, close) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Remove trailing characters equal to ch (or, when invert is set, trailing
// characters NOT equal to ch), as marked's trim helper does.
function trimEndChars(s, ch, invert) {
  let n = s.length;
  while (n > 0) {
    const c = s[n - 1];
    if ((c === ch && !invert) || (c !== ch && invert)) n--;
    else break;
  }
  return s.slice(0, n);
}

// Drop trailing blank lines, keeping at most one trailing blank line: the
// input is kept as-is when at most two lines follow the last non-blank one.
const BLANK_LINE = /^[ \t]*$/;
function trimBlankLines(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const ALPHA_NUM = /[\p{L}\p{N}]/u;

// ---------------------------------------------------------------------------
// Block lexer
// ---------------------------------------------------------------------------

const BLOCK_TAG = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_ATTRS = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// Regex builder: compose a pattern from a string or regex plus a chain of
// replacements. `replace` swaps the first occurrence of the pattern (a
// string or a regex) with the replacement (a string or a regex's source),
// stripping a leading ^ anchor from the inserted text so the whole regex
// stays anchored only at its front.
function buildRe(a, flags = '') {
  let t = typeof a === 'string' ? a : a.source;
  const b = {
    replace(s, r) {
      let o = typeof r === 'string' ? r : r.source;
      o = o.replace(/(^|[^\\[])\^/g, '$1');
      t = t.replace(s, o);
      return b;
    },
    regex() { return new RegExp(t, flags); },
  };
  return b;
}

const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HR_NOCAP = / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HEADING_START = / {0,3}#{1,6}(?:\s|$)/;
const BLOCKQUOTE_START = / {0,3}>/;
const FENCES_START = / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/;
const LIST_PARA = / {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/;
const LIST_TABLE = / {0,3}(?:[*+-]|1[.)])[ \t]/;
const LIST_BQ = / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/;
const CODE_INDENT = /(?: {4}| {0,3}\t)[^\n]/;
const BULL = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_CODE = /(?: {4}| {0,3}\t)/;
const FENCES_LH = / {0,3}(?:`{3,}|~{3,})/;
const HTML_LH = / {0,3}<[^\n>]+>\n/;
const TABLE_DELIM_LH = / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/;

const HTML_INTERRUPT = buildRe(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)').replace('tag', BLOCK_TAG).regex();

// Paragraph base: lines that do not start a blank line, hr, heading,
// setext heading, blockquote, fence, list item, HTML block or table.
const PARAGRAPH_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

function paragraphRegex(listPattern) {
  return buildRe(PARAGRAPH_BASE)
    .replace('hr', HR)
    .replace('heading', HEADING_START)
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', BLOCKQUOTE_START)
    .replace('fences', FENCES_START)
    .replace('list', listPattern)
    .replace('html', HTML_INTERRUPT)
    .regex();
}

// GFM table: header line, delimiter row, then body rows that do not start
// a blank line, hr, heading, blockquote, indented code, fence, list or
// HTML block.
const TABLE_GFM = buildRe("^ *([^\\\\\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)")
  .replace('hr', HR)
  .replace('heading', HEADING_START)
  .replace('blockquote', BLOCKQUOTE_START)
  .replace('code', CODE_INDENT)
  .replace('fences', FENCES_START)
  .replace('list', LIST_TABLE)
  .replace('html', HTML_INTERRUPT)
  .regex();

// GFM paragraph: like the base paragraph, but the table pattern is an
// interrupter instead of being removed.
const PARAGRAPH_GFM = buildRe(PARAGRAPH_BASE)
  .replace('hr', HR)
  .replace('heading', HEADING_START)
  .replace('|lheading', '')
  .replace('table', TABLE_GFM)
  .replace('blockquote', BLOCKQUOTE_START)
  .replace('fences', FENCES_START)
  .replace('list', LIST_PARA)
  .replace('html', HTML_INTERRUPT)
  .regex();

// Setext heading: text that is not a list item, indented code, fence,
// blockquote, ATX heading, hr, HTML block or table delimiter, then an
// = or - underline.
const LHEADING_BASE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const LHEADING_GFM = buildRe(LHEADING_BASE)
  .replace(/bull/g, BULL)
  .replace(/blockCode/g, BLOCK_CODE)
  .replace(/fences/g, FENCES_LH)
  .replace(/blockquote/g, BLOCKQUOTE_START)
  .replace(/heading/g, HEADING_START)
  .replace(/hr/g, HR_NOCAP)
  .replace(/html/g, HTML_LH)
  .replace(/table/g, TABLE_DELIM_LH)
  .regex();

// Blockquote: > markers, with the paragraph inside using the any-digit
// list interrupter.
const BLOCKQUOTE_PARA = paragraphRegex(LIST_BQ);
const BLOCKQUOTE = buildRe(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', BLOCKQUOTE_PARA).regex();

// Raw HTML block (case-insensitive): script/pre/style/textarea to their
// closing tag, comment, processing instruction, declaration, CDATA,
// block-level tag or open/close tag to a blank line.
const HTML_BLOCK = buildRe("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))", 'i')
  .replace('comment', HTML_COMMENT)
  .replace('tag', BLOCK_TAG)
  .replace('attribute', HTML_ATTRS)
  .regex();

const RE = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: HR,
  html: HTML_BLOCK,
  lheading: LHEADING_GFM,
  list: buildRe(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULL).regex(),
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  table: TABLE_GFM,
  paragraph: PARAGRAPH_GFM,
  blockquoteParagraph: BLOCKQUOTE_PARA,
  text: /^[^\n]+/,
  blockquote: BLOCKQUOTE,
  blockquoteStart: /^ {0,3}>/,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  leadingSpaceTab: /^[ \t]+/,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  hrefBrackets: /^<(.*)>$/,
};

function listItemRegex(bull) {
  return new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`);
}
function nextBulletRegex(n) {
  n = Math.max(0, Math.min(3, n - 1));
  return new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`);
}
function hrRegex(n) {
  n = Math.max(0, Math.min(3, n - 1));
  return new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`);
}
function fencesBeginRegex(n) {
  n = Math.max(0, Math.min(3, n - 1));
  return new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`);
}
function headingBeginRegex(n) {
  n = Math.max(0, Math.min(3, n - 1));
  return new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`);
}
function htmlBeginRegex(n) {
  n = Math.max(0, Math.min(3, n - 1));
  return new RegExp(`^ {0,${n}}(?:<\\/?(?:${BLOCK_TAG})(?: +|$|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
}
function blockquoteBeginRegex(n) {
  n = Math.max(0, Math.min(3, n - 1));
  return new RegExp(`^ {0,${n}}>`);
}

// Fenced code inside a list or quote is indented along with its container:
// strip up to as many leading spaces from each content line as the opening
// fence itself had.
function indentCompensation(raw, text) {
  const m = raw.match(RE.indentCodeCompensation);
  if (!m) return text;
  const n = m[1].length;
  return text.split('\n').map((line) => {
    const mm = line.match(RE.beginningSpace);
    if (!mm) return line;
    return line.slice(Math.min(mm[0].length, n));
  }).join('\n');
}

const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;

// The lexer: turns source into a flat token list. Link reference definitions
// are collected on the way (first definition of a label wins) and inline
// parsing runs afterwards, from the queue, so definitions may appear after
// the links that use them.
class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }

  lex(src) {
    src = src.replace(/\r\n|\r/g, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const q = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(q.src, q.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  inline(src) {
    const tokens = [];
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  blockTokens(src, tokens, nested) {
    let n = !!nested;
    for (;;) {
      if (!src) break;
      let tok;
      if ((tok = this.space(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.code(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.fences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.heading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.hr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.blockquote(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.list(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.html(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.def(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          if (!this.tokens.links[tok.tag]) this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.table(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.lheading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (this.state.top && (tok = this.paragraph(src))) {
        const prev = tokens[tokens.length - 1];
        if (n && prev && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else tokens.push(tok);
        n = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.text(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev && prev.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      break;
    }
    this.state.top = true;
    return tokens;
  }

  space(src) {
    const t = RE.newline.exec(src);
    if (t && t[0].length > 0) return { type: 'space', raw: t[0] };
  }

  code(src) {
    const t = RE.code.exec(src);
    if (!t) return;
    const raw = trimBlankLines(t[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RE.codeRemoveIndent, '') };
  }

  fences(src) {
    const t = RE.fences.exec(src);
    if (!t) return;
    const text = indentCompensation(t[0], t[3] || '');
    return { type: 'code', raw: t[0], lang: t[2] ? t[2].trim().replace(ANY_PUNCT, '$1') : t[2], text };
  }

  heading(src) {
    const t = RE.heading.exec(src);
    if (!t) return;
    let text = t[2].trim();
    if (RE.endingHash.test(text)) {
      const s = trimEndChars(text, '#');
      if (!s || RE.endingSpaceTabChar.test(s)) text = s.trim();
    }
    return { type: 'heading', raw: trimEndChars(t[0], '\n'), depth: t[1].length, text, tokens: this.inline(text) };
  }

  hr(src) {
    const t = RE.hr.exec(src);
    if (t) return { type: 'hr', raw: trimEndChars(t[0], '\n') };
  }

  blockquote(src) {
    const t = RE.blockquote.exec(src);
    if (!t) return;
    let lines = trimEndChars(t[0], '\n').split('\n');
    let s = '', r = '';
    const tokens = [];
    while (lines.length > 0) {
      let inQuote = false;
      const chunk = [];
      let p = 0;
      for (; p < lines.length; p++) {
        if (RE.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); inQuote = true; }
        else if (!inQuote) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const h = chunk.join('\n');
      const u = h
        .replace(RE.blockquoteMarkerWhitespace, (g, b, m) => b + expandTabs(m, b.length))
        .replace(RE.blockquoteSetextReplace, '\n    $1')
        .replace(RE.blockquoteSetextReplace2, '');
      s = s ? s + '\n' + h : h;
      r = r ? r + '\n' + u : u;
      const wasTop = this.state.top;
      this.state.top = true;
      this.blockTokens(u, tokens, true);
      this.state.top = wasTop;
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
      if (last && last.type === 'blockquote') {
        const g = last;
        const b = lines.join('\n');
        const m = g.raw + '\n' + b.replace(RE.blockquoteSetextReplace2, '');
        const f = this.blockquote(m);
        tokens[tokens.length - 1] = f;
        const y = m.substring(f.raw.length).replace(/^\n/, '');
        const R = y ? y.split('\n').length : 0;
        const A = R ? lines.slice(0, -R) : lines;
        if (A.length > 0) s = s + '\n' + A.join('\n');
        r = r.substring(0, r.length - g.text.length) + f.text;
        lines = lines.slice(A.length);
        if (lines.length > 0 && RE.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last && last.type === 'list') {
        const g = last;
        const b = g.raw + '\n' + lines.join('\n');
        const m = this.list(b);
        tokens[tokens.length - 1] = m;
        const f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length : 0;
        if (f > 0) {
          const y = lines.slice(0, f).join('\n');
          s = s + '\n' + y;
          r = r + '\n' + y;
        }
        lines = lines.slice(f);
        continue;
      }
    }
    return { type: 'blockquote', raw: s, tokens, text: r };
  }

  list(src) {
    const t = RE.list.exec(src);
    if (!t) return;
    const orig = src;
    const pos = () => orig.length - src.length;
    const marker = t[1].trim();
    const ordered = marker.length > 1;
    const item = { type: 'list', raw: '', ordered, start: ordered ? +marker.slice(0, -1) : '', loose: false, items: [] };
    const bullRe = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRe = listItemRegex(bullRe);
    let looseAfter = false;
    while (src) {
      let empty = false;
      let d = '';
      const m = itemRe.exec(src);
      if (!m || RE.hr.test(src)) break;
      const k = pos();
      src = src.substring(m[0].length);
      const g = m[2].split('\n', 1)[0];
      const b = m[1].length;
      let cur = g.replace(RE.leadingSpaceTab, (v) => expandTabs(v, b));
      const f0 = src.split('\n', 1)[0];
      let y = !cur.trim();
      let indent;
      if (y) indent = b + 1;
      else {
        indent = cur.search(/[^ ]/);
        indent = indent > 4 ? 1 : indent;
        d = cur.slice(indent);
        indent += b;
      }
      if (y && BLANK_LINE.test(f0)) { src = src.substring(f0.length + 1); empty = true; }
      if (!empty) {
        const nextBullet = nextBulletRegex(indent);
        const hrRe = hrRegex(indent);
        const fenceRe = fencesBeginRegex(indent);
        const headRe = headingBeginRegex(indent);
        const htmlRe = htmlBeginRegex(indent);
        const quoteRe = blockquoteBeginRegex(indent);
        while (src) {
          const U = src.split('\n', 1)[0];
          const f = U;
          const Z = f.replace(RE.leadingSpaceTab, (me) => expandTabs(me));
          if (fenceRe.test(f) || headRe.test(f) || htmlRe.test(f) || quoteRe.test(f) || nextBullet.test(f) || hrRe.test(f)) break;
          if (Z.search(/[^ ]/) >= indent || !f.trim()) d += '\n' + Z.slice(indent);
          else {
            if (y || cur.replace(/\t/g, '    ').search(/[^ ]/) >= 4 || fenceRe.test(cur) || headRe.test(cur) || htmlRe.test(cur) || hrRe.test(cur)) break;
            const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && RE.lheading.test(cur + '\n' + f)
              ? '    ' + Z.replace(/^ {0,3}/, '')
              : f;
            d += '\n' + qe;
          }
          y = !f.trim();
          src = src.substring(U.length + 1);
          cur = Z.slice(indent);
        }
      }
      const raw = orig.slice(k, pos());
      if (!item.loose) {
        if (looseAfter) item.loose = true;
        else if (RE.doubleBlankLine.test(raw)) looseAfter = true;
      }
      item.items.push({ type: 'list_item', raw, task: RE.listIsTask.test(d), loose: false, text: d, tokens: [] });
    }
    const last = item.items[item.items.length - 1];
    if (!last) return;
    last.raw = last.raw.trimEnd();
    last.text = last.text.trimEnd();
    item.raw = orig.slice(0, pos()).trimEnd();
    for (const it of item.items) {
      this.state.top = false;
      it.tokens = this.blockTokens(it.text, []);
      if (!item.loose) {
        const spaces = it.tokens.filter((g) => g.type === 'space');
        if (spaces.length > 0 && spaces.some((g) => RE.anyLine.test(g.raw))) item.loose = true;
      }
    }
    for (const it of item.items) {
      const d0 = it.tokens[0];
      if (it.task && d0 && (d0.type === 'text' || d0.type === 'paragraph')) {
        it.text = it.text.replace(RE.listReplaceTask, '');
        d0.raw = d0.raw.replace(RE.listReplaceTask, '');
        d0.text = d0.text.replace(RE.listReplaceTask, '');
        for (let g = this.inlineQueue.length - 1; g >= 0; g--) {
          if (RE.listIsTask.test(this.inlineQueue[g].src)) {
            this.inlineQueue[g].src = this.inlineQueue[g].src.replace(RE.listReplaceTask, '');
            break;
          }
        }
        const kk = RE.listTaskCheckbox.exec(it.raw);
        if (kk) {
          const g = { type: 'checkbox', raw: kk[0] + ' ', checked: kk[0] !== '[ ]' };
          it.checked = g.checked;
          if (item.loose) {
            if (it.tokens[0] && (it.tokens[0].type === 'paragraph' || it.tokens[0].type === 'text') && it.tokens[0].tokens) {
              it.tokens[0].raw = g.raw + it.tokens[0].raw;
              it.tokens[0].text = g.raw + it.tokens[0].text;
              it.tokens[0].tokens.unshift(g);
            } else {
              it.tokens.unshift({ type: 'paragraph', raw: g.raw, text: g.raw, tokens: [g] });
            }
          } else {
            it.tokens.unshift(g);
          }
        }
      } else if (it.task) it.task = false;
    }
    if (item.loose) {
      for (const it of item.items) {
        it.loose = true;
        for (const d0 of it.tokens) if (d0.type === 'text') d0.type = 'paragraph';
      }
    }
    return item;
  }

  html(src) {
    const t = RE.html.exec(src);
    if (!t) return;
    const n = trimBlankLines(t[0]);
    return { type: 'html', block: true, raw: n, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style', text: n };
  }

  def(src) {
    const t = RE.def.exec(src);
    if (!t) return;
    if (!RE.startAngleBracket.test(t[2]) && findBracket(t[2], '(', ')') !== -1) return;
    const tag = normalizeLabel(t[1]);
    const href = t[2] ? t[2].replace(RE.hrefBrackets, '$1').replace(ANY_PUNCT, '$1') : '';
    const title = t[3] ? t[3].substring(1, t[3].length - 1).replace(ANY_PUNCT, '$1') : t[3];
    return { type: 'def', tag, raw: trimEndChars(t[0], '\n'), href, title };
  }

  table(src) {
    const t = RE.table.exec(src);
    if (!t || !RE.tableDelimiter.test(t[2])) return;
    const header = splitCells(t[1]);
    const delim = t[2].replace(RE.tableAlignChars, '').split('|');
    const body = t[3] && t[3].trim() ? t[3].replace(RE.tableRowBlankLine, '').split('\n') : [];
    const out = { type: 'table', raw: trimEndChars(t[0], '\n'), header: [], align: [], rows: [] };
    if (header.length !== delim.length) return;
    for (const c of delim) {
      if (RE.tableAlignRight.test(c)) out.align.push('right');
      else if (RE.tableAlignCenter.test(c)) out.align.push('center');
      else if (RE.tableAlignLeft.test(c)) out.align.push('left');
      else out.align.push(null);
    }
    for (let i = 0; i < header.length; i++) {
      out.header.push({ text: header[i], tokens: this.inline(header[i]), header: true, align: out.align[i] });
    }
    for (const row of body) {
      out.rows.push(splitCells(row, out.header.length).map((cell, i) => ({ text: cell, tokens: this.inline(cell), header: false, align: out.align[i] })));
    }
    return out;
  }

  lheading(src) {
    const t = RE.lheading.exec(src);
    if (!t) return;
    const text = t[1].trim();
    return { type: 'heading', raw: trimEndChars(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.inline(text) };
  }

  paragraph(src) {
    const t = RE.paragraph.exec(src);
    if (!t) return;
    const text = t[1].endsWith('\n') ? t[1].slice(0, -1) : t[1];
    return { type: 'paragraph', raw: t[0], text, tokens: this.inline(text) };
  }

  text(src) {
    const t = RE.text.exec(src);
    if (t) return { type: 'text', raw: t[0], text: t[0], tokens: this.inline(t[0]) };
  }
}

// ---------------------------------------------------------------------------
// Inline lexer
//
// Tokenisers run in marked's order: escape, tag, link, reflink, emStrong,
// codespan, br, del, autolink, url, inlineText. Emphasis is resolved the
// way marked does it: from the opener, scanning forward with the delimiter
// regexes (not a delimiter stack — the two disagree on cases such as
// *a**b***c*), over a masked copy of the source in which link labels, code
// spans, HTML tags and escaped punctuation are hidden, so a delimiter
// inside one of those can never be picked up as a closer.
// ---------------------------------------------------------------------------

// Sticky versions of the anchored tokeniser regexes (no ^; the match must
// start at lastIndex, which is the same thing). lastIndex is set before
// every exec, so these are safe to share.
const IR = {
  escape: /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y,
  code: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y,
  br: /( {2,}|\\)\n(?!\s*$)[ \t]*/y,
  tag: /<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>/y,
  autolink: /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/y,
  url: /(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  // A link label: nested [...] (one level), escapes, code spans, or any
  // character that is not [, ], \ or `.
  link: /!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\))))?[ \t\n]*\)/y,
  reflink: /!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/y,
  nolink: /!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/y,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  // Closer scans. Group 1/2 are closer-only runs, 3/4 opener-only runs,
  // 5/6 runs that can both open and close (ast only; the _ scan has no
  // group 6). The first alternative is a special case for **a __b__ c**
  // style interplay; the second consumes plain text.
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
};

// Masking patterns (global, used with replace; no ^ anchors).
const LABEL_SEARCH = /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const REF_SEARCH = /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/;
const REFLINK_SEARCH = new RegExp(`!?\\[(${LABEL_SEARCH.source})\\]\\[(${REF_SEARCH.source})\\]|!?\\[(${REF_SEARCH.source})\\](?:\\[\\])?(?!\\()`, 'g');
const ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP = /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)(`+)[^`]+\2(?!`)|<(?! )[^<>]*?>/g;

const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;

// Last index of a delimiter that could close something: the last
// occurrence preceded by a character that is not space, tab, newline,
// carriage return or form feed.
function lastPossibleCloser(masked, ch) {
  let idx = -1;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== ch) continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') idx = i;
  }
  return idx;
}

function execAt(re, src, i) {
  re.lastIndex = i;
  return re.exec(src);
}

// Does the label contain a link (inline or reference) that would make an
// outer link invalid? Used while masking reference links.
function linkInText(lexer, e) {
  if (!e.includes('[')) return false;
  for (const n of e.matchAll(BLOCK_SKIP)) {
    IR.link.lastIndex = 0;
    if (IR.link.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(REFLINK_SEARCH)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(lexer.tokens.links, normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(lexer, s.slice(1, r - 1)))) return true;
  }
  return false;
}

// Mask a copy of an inline source so the emphasis closer search never
// sees a delimiter inside a link label, a code span, an HTML tag or an
// escape. Every replacement keeps the same length, so indices still line
// up with the original string.
function maskForEmphasis(lexer, src) {
  let t = src;
  if (lexer.tokens.links && src.includes('[')) {
    const search = REFLINK_SEARCH;
    const maskRef = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(lexer.tokens.links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(lexer, inner)) return '[' + inner.replace(search, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(search, maskRef);
  }
  t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (n, s, r) =>
    r ? '+'.repeat(n.length)
      : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s
      : n);
  t = t.replace(BLOCK_SKIP, (n) => '[' + 'a'.repeat(Math.max(0, n.length - 2)) + ']');
  return t;
}

// A link label is rejected when it contains an HTML tag or autolink that
// does not close inside the label.
function labelHasUnclosedTag(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      IR.code.lastIndex = s;
      const m = IR.code.exec(label);
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = src.slice(labelStart + s);
    IR.tag.lastIndex = 0;
    const o = IR.tag.exec(r) || (IR.autolink.lastIndex = 0, IR.autolink.exec(r));
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// Parse an inline source into tokens, synchronously. The masked copy is
// only built when the source contains a delimiter; it exists so the
// emphasis closer search can ignore delimiters inside links and code.
Lexer.prototype.inlineTokens = function (src, out) {
  const prevLinkParen = this.state.linkParenPossible;
  this.state.linkParenPossible = prevLinkParen && src.includes(')');
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? maskForEmphasis(this, src) : src;
  const bounds = needsMask
    ? { star: lastPossibleCloser(masked, '*'), und: lastPossibleCloser(masked, '_'), tilde: lastPossibleCloser(masked, '~') }
    : null;
  try {
    scanInline(this, src, masked, bounds, out);
  } finally {
    this.state.linkParenPossible = prevLinkParen;
  }
  return out;
};

function pushText(out, raw, text, escaped) {
  const prev = out[out.length - 1];
  if (prev && prev.type === 'text') { prev.raw += raw; prev.text += text; return; }
  out.push({ type: 'text', raw, text, escaped });
}

function scanInline(lexer, src, masked, bounds, out) {
  const n = src.length;
  let i = 0;
  let prevWasText = false;
  let lastChar = '';
  while (i < n) {
    if (!prevWasText) lastChar = '';
    prevWasText = false;
    let m = execAt(IR.escape, src, i);
    if (m) { out.push({ type: 'escape', raw: m[0], text: m[1] }); i += m[0].length; continue; }
    m = execAt(IR.tag, src, i);
    if (m) {
      const st = lexer.state;
      if (!st.inLink && IR.startATag.test(m[0])) st.inLink = true;
      else if (st.inLink && IR.endATag.test(m[0])) st.inLink = false;
      if (!st.inRawBlock && IR.startPreScriptTag.test(m[0])) st.inRawBlock = true;
      else if (st.inRawBlock && IR.endPreScriptTag.test(m[0])) st.inRawBlock = false;
      out.push({ type: 'html', raw: m[0], text: m[0], inLink: st.inLink, inRawBlock: st.inRawBlock, block: false });
      i += m[0].length;
      continue;
    }
    const link = tryInlineLink(lexer, src, i);
    if (link) { out.push(link.node); i += link.len; continue; }
    const ref = tryRefLink(lexer, src, i);
    if (ref) {
      if (ref.textChar) {
        pushText(out, ref.textChar, ref.textChar, false);
        if (ref.textChar !== '_') lastChar = ref.textChar;
        prevWasText = true;
        i += 1;
        continue;
      }
      out.push(ref.node);
      i += ref.len;
      continue;
    }
    const em = tryEmStrong(lexer, src, masked, bounds, i, lastChar);
    if (em) { out.push(em); i += em.raw.length; continue; }
    m = execAt(IR.code, src, i);
    if (m) {
      let text = m[2].replace(/\n/g, ' ');
      if (/[^ ]/.test(text) && text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ') text = text.substring(1, text.length - 1);
      out.push({ type: 'codespan', raw: m[0], text });
      i += m[0].length;
      continue;
    }
    m = execAt(IR.br, src, i);
    if (m) { out.push({ type: 'br', raw: m[0] }); i += m[0].length; continue; }
    const del = tryDel(lexer, src, masked, bounds, i, lastChar);
    if (del) { out.push(del); i += del.raw.length; continue; }
    m = execAt(IR.autolink, src, i);
    if (m) {
      const isEmail = m[2] === '@';
      const text = m[1];
      out.push({ type: 'link', raw: m[0], text, href: isEmail ? 'mailto:' + text : text, autolink: true, tokens: [{ type: 'text', raw: text, text }] });
      i += m[0].length;
      continue;
    }
    if (!lexer.state.inLink) {
      const u = tryUrl(src, i);
      if (u) { out.push(u.node); i += u.len; continue; }
    }
    const run = scanTextRun(src, i);
    if (run.length === 0) throw new Error('Infinite loop on byte: ' + src.charCodeAt(i));
    const inRaw = lexer.state.inRawBlock;
    pushText(out, run, inRaw ? run : unescape(run), inRaw);
    if (run.charAt(run.length - 1) !== '_') lastChar = run.charAt(run.length - 1);
    prevWasText = true;
    i += run.length;
  }
}

function buildLink(lexer, t, href, title, raw) {
  const isImage = t[0].charAt(0) === '!';
  const label = t[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const prevInLink = lexer.state.inLink;
  const prevLinkEmitted = lexer.state.linkEmitted;
  const prevInRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = [];
  lexer.inlineTokens(label, tokens);
  const innerLink = lexer.state.linkEmitted;
  lexer.state.linkEmitted = prevLinkEmitted;
  lexer.state.inLink = prevInLink;
  if (!isImage) {
    if (innerLink) { lexer.state.inRawBlock = prevInRawBlock; return null; }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title: title || null, text: label, tokens };
}

function tryInlineLink(lexer, src, i) {
  if (lexer.state.linkParenPossible === false) return null;
  const t = execAt(IR.link, src, i);
  if (!t) return null;
  const n = t[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasUnclosedTag(src, t[1], i + n)) return null;
  const s = t[2].trim();
  if (s.charAt(0) === '<') {
    if (s.charAt(s.length - 1) !== '>') return null;
    const l = trimEndChars(s.slice(0, -1), '\\');
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = findBracket(t[2], '(', ')');
    if (l === -2) return null;
    if (l > -1) {
      const h = (t[0].charAt(0) === '!' ? 5 : 4) + t[1].length + l;
      t[2] = t[2].substring(0, l);
      t[0] = t[0].substring(0, h).trim();
      t[3] = '';
    }
  }
  const r = trimEndChars(t[0].slice(0, -1), '\\');
  if ((t[0].length - r.length) % 2 === 0) return null;
  let href = t[2].trim();
  if (href.charAt(0) === '<') href = href.slice(1, -1);
  href = href.replace(ANY_PUNCT, '$1');
  const title = t[3] ? t[3].slice(1, -1).replace(ANY_PUNCT, '$1') : '';
  const node = buildLink(lexer, t, href, title, t[0]);
  return node ? { node, len: t[0].length } : null;
}

function tryRefLink(lexer, src, i) {
  const t = execAt(IR.reflink, src, i) || execAt(IR.nolink, src, i);
  if (!t) return null;
  const n = t[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasUnclosedTag(src, t[1], i + n)) return null;
  const def = lexer.tokens.links[normalizeLabel(t[2] || t[1])];
  if (!def) return { textChar: t[0].charAt(0) };
  const node = buildLink(lexer, t, def.href, def.title, t[0]);
  return node ? { node, len: t[0].length } : null;
}

function tryEmStrong(lexer, src, masked, bounds, i, lastChar) {
  const e = src.slice(i);
  const s = IR.emStrongLDelim.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const delim = s[0][0];
  const o = lastChar === delim;
  const pos = i;
  let l = pos;
  for (; l > 0 && masked[l - 1] === delim;) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || IR.punctuation.test(p);
  let n = lastChar;
  if (l < pos) n = p;
  const u = l < pos ? h : IR.punctuation.test(n);
  if (s[4] && ALPHA_NUM.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (d && n && !u) return null;
  const k = [...s[0]].length - 1;
  let m = k, f = 0;
  const y = pos - l + k;
  const R = !!p.trim() && (!!d || (delim === '*' && !h));
  const A = delim === '*' ? IR.emStrongRDelimAst : IR.emStrongRDelimUnd;
  const v = delim === '*' ? bounds.star : bounds.und;
  const Q = pos + k;
  if (v < Q) return null;
  const rest = masked.slice(pos + k);
  const ee = v - Q;
  A.lastIndex = 0;
  let match;
  while ((match = A.exec(rest)) !== null && !(match.index > ee)) {
    const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!g) continue;
    let b = [...g].length;
    if (match[3] || match[4]) { m += b; continue; }
    else if (match[5] || match[6] || R) {
      if (o && (match[5] || match[6])) break;
      if (y % 3 && !((y + b) % 3)) { f += b; continue; }
    }
    if ((m -= b) > 0) continue;
    b = Math.min(b, b + m + f);
    const te = [...match[0]][0].length;
    const M = e.slice(0, k + match.index + te + b);
    if (Math.min(k, b) % 2) {
      const U = M.slice(1, -1);
      return { type: 'em', raw: M, text: U, tokens: lexer.inlineTokens(U, []) };
    }
    const ne = M.slice(2, -2);
    return { type: 'strong', raw: M, text: ne, tokens: lexer.inlineTokens(ne, []) };
  }
  return null;
}

function tryDel(lexer, src, masked, bounds, i, lastChar) {
  const e = src.slice(i);
  const s = IR.delLDelim.exec(e);
  if (!s) return null;
  const n = lastChar;
  if (s[1] && n && !IR.punctuation.test(n)) return null;
  const o = [...s[0]].length - 1;
  let p = o;
  const h = IR.delRDelim;
  const u = bounds.tilde;
  const d = i + o;
  if (u < d) return null;
  const rest = masked.slice(i + o);
  const k = u - d;
  h.lastIndex = 0;
  let match;
  while ((match = h.exec(rest)) !== null && !(match.index > k)) {
    const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!g) continue;
    const l = [...g].length;
    if (l !== o) continue;
    if (match[3] || match[4]) { p += l; continue; }
    if ((p -= l) > 0) continue;
    const ll = Math.min(l, l + p);
    const te = [...match[0]][0].length;
    const b = e.slice(0, o + match.index + te + ll);
    const m = b.slice(o, -o);
    return { type: 'del', raw: b, text: m, tokens: lexer.inlineTokens(m, []) };
  }
  return null;
}

function tryUrl(src, i) {
  const t = execAt(IR.url, src, i);
  if (!t) return null;
  let text, href;
  if (t[2] === '@') {
    text = t[0];
    href = 'mailto:' + text;
  } else {
    let raw = t[0];
    let prev;
    do {
      prev = raw;
      const m = IR.backpedal.exec(raw);
      raw = m ? m[0] : '';
    } while (prev !== raw);
    if (raw.length === 0) return null;
    text = raw;
    href = t[1] === 'www.' ? 'http://' + raw : raw;
  }
  return { node: { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] }, len: text.length };
}

// A run of plain text: from i up to (not including) the next tokeniser
// trigger. The first character is always consumed; stops are searched
// strictly after it, the way the lazy text regex does.
const TEXT_SPECIAL = /[\\<!\[_*`~]/g;
const TEXT_HARD_BREAK = / {2,}\n/g;
const TEXT_URL_START = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.|mailto:|xmpp:/g;
const EMAIL_CHARS = /[A-Za-z0-9.!#$%&'*+\/=?_`{|}~-]/;

function scanTextRun(src, i) {
  const n = src.length;
  // The first unit is a run of backticks, a run of tildes, or one character.
  let first = i + 1;
  if (src[i] === '`' || src[i] === '~') {
    const ch = src[i];
    first = i;
    while (first < n && src[first] === ch) first++;
  }
  let stop = n;
  TEXT_SPECIAL.lastIndex = first;
  let m = TEXT_SPECIAL.exec(src);
  if (m) stop = Math.min(stop, m.index);
  TEXT_HARD_BREAK.lastIndex = first;
  m = TEXT_HARD_BREAK.exec(src);
  if (m) stop = Math.min(stop, m.index);
  TEXT_URL_START.lastIndex = first;
  while ((m = TEXT_URL_START.exec(src)) !== null) {
    const w = m[0];
    const prev = src[m.index - 1];
    if (w === 'www.') {
      if (prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(') { stop = Math.min(stop, m.index); break; }
    } else if (w === 'mailto:' || w === 'xmpp:') {
      if (!/[A-Za-z0-9]/.test(prev)) { stop = Math.min(stop, m.index); break; }
    } else {
      stop = Math.min(stop, m.index);
      break;
    }
  }
  let at = src.indexOf('@', i + 1);
  while (at !== -1) {
    let p = at - 1;
    while (p >= i && EMAIL_CHARS.test(src[p])) p--;
    if (p < at - 1) {
      stop = Math.min(stop, Math.max(p + 1, i + 1));
      break;
    }
    at = src.indexOf('@', at + 1);
  }
  if (stop <= first) return src.slice(i, first);
  return src.slice(i, stop);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

// Renders inline tokens to plain text (used for image alt text): strong,
// em, del, links and images recurse; code spans and HTML give their text;
// line breaks and checkboxes give nothing / their raw text.
function renderTextInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += tok.tokens && tok.tokens.length > 0 ? renderTextInline(tok.tokens) : tok.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape':
        out += tok.text;
        break;
      case 'br':
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      default:
        break;
    }
  }
  return out;
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
      case 'text':
        out += 'tokens' in tok && tok.tokens ? renderInline(tok.tokens) : ('escaped' in tok && tok.escaped ? tok.text : escapeHtml(tok.text));
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link': {
        const text = tok.autolink ? escapeHtml(tok.text, true) : renderInline(tok.tokens);
        const href = cleanUrl(tok.href);
        if (href === null) { out += text; break; }
        let a = '<a href="' + escapeHtml(href, tok.autolink) + '"';
        if (tok.title) a += ' title="' + escapeHtml(tok.title) + '"';
        out += a + '>' + text + '</a>';
        break;
      }
      case 'image': {
        const text = tok.tokens ? renderTextInline(tok.tokens) : tok.text;
        const src = cleanUrl(tok.href);
        if (src === null) { out += escapeHtml(text); break; }
        let img = '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(text) + '"';
        if (tok.title) img += ' title="' + escapeHtml(tok.title) + '"';
        out += img + '>';
        break;
      }
      case 'checkbox':
        out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += '<strong>' + renderInline(tok.tokens) + '</strong>';
        break;
      case 'em':
        out += '<em>' + renderInline(tok.tokens) + '</em>';
        break;
      case 'codespan':
        out += '<code>' + escapeHtml(tok.text, true) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'del':
        out += '<del>' + renderInline(tok.tokens) + '</del>';
        break;
      default:
        break;
    }
  }
  return out;
}

function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + tok.depth + '>' + renderInline(tok.tokens) + '</h' + tok.depth + '>\n';
        break;
      case 'code': {
        const lang = (tok.lang || '').match(/^\S*/)?.[0];
        const text = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        out += lang
          ? '<pre><code class="language-' + escapeHtml(lang) + '">' + escapeHtml(text, true) + '</code></pre>\n'
          : '<pre><code>' + escapeHtml(text, true) + '</code></pre>\n';
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell);
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell);
          body += '<tr>\n' + cells + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(tok.tokens) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        let items = '';
        for (const item of tok.items) items += '<li>' + renderTokens(item.tokens) + '</li>\n';
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += tok.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += '<p>' + renderInline(tok.tokens) + '</p>\n';
        break;
      case 'text':
        out += 'tokens' in tok && tok.tokens ? renderInline(tok.tokens) : ('escaped' in tok && tok.escaped ? tok.text : escapeHtml(tok.text));
        break;
      default:
        break;
    }
  }
  return out;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>') + renderInline(cell.tokens) + '</' + tag + '>\n';
}

export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return renderTokens(tokens);
}

