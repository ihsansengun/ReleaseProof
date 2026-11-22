/**
 * Makes what a browser said fit to leave the machine.
 *
 * This is not a set of patterns run over a whole text. Patterns of that kind
 * were tried here three times: one took time that grew with the square of the
 * text, the next with its cube, and each fix let through something the one
 * before it had caught. Instead a text is cut to a length, split into words,
 * and each word is looked at once by rules that read it from left to right.
 * The time taken grows with the length of the text and no faster, whatever
 * the text is.
 *
 * It is closed by default where it can be: a path segment is kept only if it
 * looks like an ordinary name or a short number, and anything else in it is
 * replaced. A text cannot be closed by default (an error message must stay
 * readable), so there the rules name what is removed, and the documentation
 * says what they do not catch.
 *
 * The rules, for a word of a text:
 *   - an address is reduced to its cleaned path;
 *   - an e-mail address is replaced;
 *   - after a credential's name (or Bearer, Basic, Digest, Negotiate or
 *     Token), if anything follows it, the rest of the text is replaced:
 *     neither where a value begins nor where it ends can be told;
 *   - a long word of letters and digits mixed, a very long word of any kind,
 *     and a long run of digits are replaced.
 * Secret values the caller knows are replaced first, by the caller's own
 * function, and the placeholder it leaves ({{secret:…}}) stands untouched.
 */

/** Characters of a text that are looked at. The rest is dropped before anything else is done. */
export const TEXT_READ = 4_000;
/** Characters of a cleaned text. */
export const TEXT_KEPT = 300;
/** Characters of a path that are looked at, and of a cleaned path. */
const PATH_READ = 1_000;
const PATH_KEPT = 200;

const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F­​-‏‪-‮⁠-⁤﻿]/g;
const PLACEHOLDER = /^\{\{secret:[A-Za-z0-9_.-]{1,48}\}\}$/;
const REDACTED = new Set(["[redacted]", "[redacted-e-mail]"]);

/** Further characters that are not shown, or that turn the reading of a line around; and halves of a character with no other half. */
const UNSHOWN = new RegExp("[\\u0080-\\u009F\\u2028\\u2029\\u2066-\\u2069\\uFFF9-\\uFFFB\\uE000\\uE001\\u061C\\u180E\\u2065\\u206A-\\u206F\\uFE00-\\uFE0F]|\\uDB40[\\uDC00-\\uDC7F]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]", "g");
/** A text with nothing in it that is not shown. */
const shown = (text: string) => text.replace(INVISIBLE, "").replace(UNSHOWN, "");
/** Spaces of other kinds, read as the space they look like. */
const SPACES = new RegExp("[\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]", "g");

const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code > 127;
const isDigit = (code: number) => code >= 48 && code <= 57;

/** What a string is made of, found in one pass. */
function made(text: string): { letters: number; digits: number; others: number } {
  let letters = 0;
  let digits = 0;
  let others = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isLetter(code)) letters += 1;
    else if (isDigit(code)) digits += 1;
    else others += 1;
  }
  return { letters, digits, others };
}

/** Whether a name, as written before `=` or `:`, is the name of a credential. */
export function namesCredential(name: string): boolean {
  // The start and the end of a long name: what it names is said in one or the other.
  const looked = name.length > 160 ? `${name.slice(0, 80)}${name.slice(-80)}` : name;
  let plain = "";
  for (let i = 0; i < looked.length; i++) {
    const code = looked.charCodeAt(i);
    if (isLetter(code) && code < 128) plain += looked[i]!.toLowerCase();
  }
  if (plain === "") return false;
  if (["auth", "sid", "otp", "pin", "key", "sig", "pass", "pw"].includes(plain) || plain.endsWith("auth") || plain.endsWith("authorization") || plain.endsWith("pass") || plain.endsWith("pw") || (plain.startsWith("auth") && !plain.startsWith("author"))) return true;
  return ["token", "secret", "passw", "passphrase", "passcode", "pwd", "credential", "apikey", "privatekey", "accesskey", "secretkey", "authkey", "signature", "csrf", "xsrf", "cookie", "session", "bearer", "jwt", "clientkey", "apisecret"].some((word) => plain.includes(word));
}

/** A part of a path segment that reads as an ordinary name or a short number. */
function ordinaryPart(part: string): boolean {
  if (part === "" || REDACTED.has(part)) return true;
  const { letters, digits, others } = made(part);
  if (others > 0) return false;
  if (digits === 0) return letters <= 24;
  if (letters === 0) return digits <= 12;
  // Letters and digits mixed: "v2" and "sha1" are names; "1a2b3c4d" is not.
  return part.length < 8;
}

/**
 * A path made fit to leave the machine: no query, fragment, parameters or
 * host, and each segment kept only as far as it reads as ordinary. A segment
 * that does not is replaced whole, except a file name, which keeps the
 * ordinary parts of its name and its ending ("app-[redacted].js").
 */
export function cleanPathWith(scrub: (text: string) => string, pathname: string): string {
  try {
    const out = shown(cleanedPath(scrub, pathname));
    // What comes out is read once more as a whole, decoded: a secret the caller knows that the cleaning itself
    // put together again (by dropping what stood between its parts) is found here.
    let whole = out;
    for (let round = 0; round < 3 && whole.includes("%"); round++) {
      const next = decodeURIComponent(whole);
      if (next === whole) break;
      whole = next;
    }
    return scrub(out) !== out || scrub(whole) !== whole ? "/[redacted]" : out;
  } catch {
    // Nothing a page can put in an address may stop the run: what cannot be read is not kept.
    return "/[redacted]";
  }
}

function cleanedPath(scrub: (text: string) => string, pathname: string): string {
  const read = pathname.length > PATH_READ ? pathname.slice(0, PATH_READ) : pathname;
  const semicolon = read.indexOf(";");
  const scrubbed = shown(scrub(shown(semicolon === -1 ? read : read.slice(0, semicolon))));
  // A secret the caller knows may lie across segments, written in codes. Read as a whole, decoded, it is found.
  let whole = scrubbed;
  for (let round = 0; round < 3 && whole.includes("%"); round++) {
    try {
      const next = decodeURIComponent(whole);
      if (next === whole) break;
      whole = next;
    } catch {
      break;
    }
  }
  if (whole !== scrubbed && scrub(whole) !== whole) return "/[redacted]";
  const out: string[] = [];
  for (const raw of scrubbed.split("/")) {
    if (raw === "" || raw === "." || raw === "..") continue;
    if ((PLACEHOLDER.test(raw) && !opaque(raw.slice(9, -2))) || REDACTED.has(raw)) {
      out.push(raw);
      continue;
    }
    let segment = raw;
    try {
      // Known secrets are looked for again in what the segment says once decoded.
      segment = shown(scrub(shown(decodeURIComponent(raw))));
    } catch {
      // Looked at as it is written.
    }
    const cleaned = PLACEHOLDER.test(segment) && !opaque(segment.slice(9, -2)) ? segment : cleanSegment(segment);
    // What is left of a segment may be nothing, or a step up: neither is a part of a path.
    if (cleaned !== "" && cleaned !== "." && cleaned !== "..") out.push(cleaned);
  }
  const joined = `/${out.join("/")}`;
  return joined.length > PATH_KEPT ? joined.slice(0, PATH_KEPT) : joined;
}

function cleanSegment(segment: string): string {
  if (segment.length > 80) return "[redacted]";
  // A picture's name with its size after an @ ("logo@2x.png") is not an address.
  const sized = /^([^@]+)(@[1-4]x)(\.[A-Za-z0-9]{1,5})$/.exec(segment);
  if (sized) {
    const cleaned = cleanSegment(`${sized[1]}${sized[3]}`);
    return cleaned.endsWith(sized[3]!) ? `${cleaned.slice(0, -sized[3]!.length)}${sized[2]}${sized[3]}` : cleaned;
  }
  const at = segment.indexOf("@");
  if (at > 0 && segment.indexOf(".", at) > at + 1) return "[redacted-e-mail]";
  // name=value inside a segment: the name stays if it is ordinary, the value never does when the name is a credential's.
  const equals = segment.indexOf("=");
  if (equals > 0) {
    const name = segment.slice(0, equals);
    if (namesCredential(name) || !ordinaryPart(name)) return "[redacted]";
    const value = cleanSegment(segment.slice(equals + 1));
    return `${encode(name)}=${value}`;
  }
  // A file name: its ending is kept, and each part of its name is judged by itself.
  const dot = segment.lastIndexOf(".");
  const ending = dot > 0 && segment.length - dot <= 6 && /^[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/.test(segment.slice(dot + 1)) ? segment.slice(dot) : "";
  const name = ending === "" ? segment : segment.slice(0, dot);
  const parts = name.split(/[-_.~ +]/);
  // Many short groups is how a key is often written. Words are few.
  if (parts.length > 6) return ending === "" ? "[redacted]" : `[redacted]${ending}`;
  if (ending === "" && !parts.every(ordinaryPart)) return "[redacted]";
  // Rebuilt with the separators it had, each part that is not ordinary replaced.
  let rebuilt = "";
  let position = 0;
  for (const part of parts) {
    rebuilt += REDACTED.has(part) ? part : ordinaryPart(part) ? encode(part) : "[redacted]";
    position += part.length;
    if (position < name.length) rebuilt += name[position] === " " ? "%20" : name[position];
    position += 1;
  }
  // What replacing its parts made longer than a name is, is not kept: the same answer whether it is read now or again.
  return rebuilt.length + ending.length > 60 ? (ending === "" ? "[redacted]" : `[redacted]${ending}`) : `${rebuilt}${ending}`;
}

/** Written so that a path stays plain printable characters, with nothing a reader could take for markup. */
const encode = (text: string) => {
  try {
    return encodeURIComponent(text).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    // Not text that can be written in an address at all.
    return "[redacted]";
  }
};

/** Characters that end a word: space, quotes, brackets, and the signs that join the parts of a list or an address's query. */
const DELIMITERS = new Set([" ", "\t", "\n", "\r", '"', "'", "`", "{", "}", "[", "]", "(", ")", ",", ";", "&", "|", "<", ">"]);
const ADDRESS_ENDS = new Set([" ", "\t", "\n", "\r", '"', "'", "`", "<", ">"]);
/** Marks, in a text being cleaned, where something that is already clean stands. Private-use characters, removed from every input first. */
const HELD_OPEN = "";
const HELD_CLOSE = "";
const HELD = /(\d{1,4})/g;
const HELD_PARTS = /(\uE000\d{1,4}\uE001)/;
/** What is already clean, and stands as it is: the engine's placeholder for a secret, and the marks this file writes. */
const CLEAN_ALREADY = /\{\{secret:[A-Za-z0-9_.-]{1,48}\}\}|\[redacted(?: value| e-mail|-e-mail)?\]|\[address\]/g;

/** Whether a word, by its own look, is a key or a token and not a word. */
function opaque(given: string): boolean {
  // What is already clean in it is not part of how it looks.
  const word = given.includes("\uE000") ? given.replace(HELD, "") : given;
  if (word.length > 200) return true;
  const { letters, digits } = made(word);
  if (word.length >= 32 && letters + digits >= word.length * 0.8) return true;
  if (word.length >= 16 && letters > 0 && digits > 0 && letters + digits >= word.length * 0.8) return true;
  if (letters === 0 && digits >= 12) return true;
  if (word.startsWith("eyJ") && word.split(".").length >= 3) return true;
  return false;
}

/** The word that says what kind of credential follows. */
const isKind = (word: string) => ["Basic", "Digest", "Negotiate", "Token"].includes(word) || /^bearer(?![A-Za-z])/i.test(word);

/**
 * A word as it reads once every %-code in it is decoded, however many times
 * over it was encoded. Undefined when that cannot be done, or when what comes
 * out is not one plain word: then the word is not kept at all.
 */
function decoded(scrub: (text: string) => string, word: string): string | undefined {
  let plain = word;
  for (let round = 0; round < 3; round++) {
    let next: string;
    try {
      next = decodeURIComponent(plain);
    } catch {
      // A code in it that is not one. If others in it are, what it hides cannot be read.
      break;
    }
    if (next === plain) break;
    plain = next;
  }
  if (/%[0-9a-fA-F]{2}/.test(plain)) return undefined;
  if (shown(plain) !== plain || /[\s"'`{}[\](),;&|<>?\uE000\uE001]/.test(plain)) return undefined;
  // A secret the caller knows, written in codes.
  if (scrub(plain) !== plain) return undefined;
  return plain;
}

/**
 * A text made fit to leave the machine. `scrub` replaces the secret values the
 * caller knows; everything else is done here.
 *
 * The text is read once, a character at a time, into words and the signs
 * between them, and each word is judged by itself. Nothing is carried from a
 * word to the next.
 *
 * Where a credential's value begins and ends cannot be told in a text of no
 * known form: after a sign, a verb, a bracket, a quote, other words, or none
 * of them, in any writing. So nothing here tries. When a word is a
 * credential's name and anything but closing quotes, brackets and stops
 * follows it, **the rest of the text is replaced**. A message loses its end.
 */
export function cleanTextWith(scrub: (text: string) => string, text: string): string {
  try {
    const out = shown(cleanedText(scrub, text));
    // A secret the caller knows that the cleaning itself put together is replaced in what comes out.
    return scrub(out) === out ? out : shown(cleanedText(scrub, scrub(out)));
  } catch {
    // Nothing a page can say may stop the run: what cannot be read is not kept.
    return "[redacted]";
  }
}

function cleanedText(scrub: (text: string) => string, text: string): string {
  // Known secrets are replaced in somewhat more than is kept, so that one lying across the cut is still found whole.
  const far = text.length > TEXT_READ * 16;
  let known = scrub(shown((far ? text.slice(0, TEXT_READ * 16) : text).replace(SPACES, " ")).replace(/[]/g, ""));
  // A word the first cut went through is not whole, and may be the half of a secret.
  if (far) {
    const whole = known.search(/\s\S*$/);
    // One word and no more, and that not whole: it is said that something was there.
    known = whole > 0 ? known.slice(0, whole) : "[redacted value]";
  }
  // What is already clean is set aside, so that no rule below reads it and none is skipped because of it.
  const held: string[] = [];
  const marked = known.replace(CLEAN_ALREADY, (mark) => {
    // A placeholder is the engine's only if what it names reads as a name: a key written inside one is a key.
    if (mark.startsWith("{{") && opaque(mark.slice(9, -2))) return mark;
    held.push(mark);
    return `${HELD_OPEN}${held.length - 1}${HELD_CLOSE}`;
  });
  const cut = marked.length > TEXT_READ;
  // Cut after marking, and never through a mark.
  const read = cut ? marked.slice(0, TEXT_READ).replace(/\d{0,4}$/, "") : marked;

  let out = "";
  let words = 0;
  /** Set when a credential's value begins: nothing after this point is kept. */
  let stop = false;

  let i = 0;
  while (!stop && i < read.length && out.length < TEXT_KEPT * 3 && words < 400) {
    const char = read[i]!;
    if (DELIMITERS.has(char)) {
      i += 1;
      const space = char === " " || char === "\t" || char === "\n" || char === "\r";
      const quote = char === '"' || char === "'" || char === "`";
      out += space ? " " : char;
      continue;
    }
    let end = i;
    while (end < read.length && !DELIMITERS.has(read[end]!)) end += 1;
    let word = read.slice(i, end);
    let trail = "";
    // An address runs to the next space or quote: the signs inside its query are part of it, not ends of words.
    if (word.includes("://") || ((word.startsWith("/") || word.includes("?")) && read[end] !== undefined && "&;,|".includes(read[end]!) && word.includes("?"))) {
      while (end < read.length && !ADDRESS_ENDS.has(read[end]!)) end += 1;
      word = read.slice(i, end);
      // A bracket or a stop after it is the sentence's, not the address's.
      let keep = word.length;
      while (keep > 0 && ")]},;.".includes(word[keep - 1]!)) keep -= 1;
      trail = word.slice(keep);
      word = word.slice(0, keep);
    }
    const last = end >= read.length;
    i = end;
    words += 1;
    // A word the cut went through is not whole, and may be the half of a secret.
    if (cut && last) {
      // Not left looking as if nothing was said.
      out += out.trim() === "" ? "[redacted value]" : " [redacted value]";
      break;
    }
    // An address and a path are decoded where they are cleaned, a part at a time.
    if (word.includes("%") && !word.includes("://") && !word.startsWith("/")) {
      // What is already clean in it stands; the parts between are decoded each by itself.
      const parts = word.split(HELD_PARTS).map((part, index) => (index % 2 === 1 ? part : decoded(scrub, part)));
      const plain = parts.includes(undefined) ? undefined : parts.join("");
      if (plain === undefined) {
        out += `[redacted value]${trail}`;
        continue;
      }
      word = plain;
    }
    HELD.lastIndex = 0;
    if (HELD.test(word) && word.replace(HELD, "") === "") {
      out += word;
      continue;
    }
    const cleaned = cleanWord(scrub, word, (index) => held[index] ?? "[redacted]");
    out += cleaned.text + (cleaned.then === undefined ? trail : "");
    if (cleaned.then === "stop") stop = true;
    if (cleaned.then === "named") {
      // A credential has been named. Whether what follows is its value cannot be told from the signs and words
      // between, in whatever writing: so if anything at all follows, none of it is kept.
      const rest = `${trail}${read.slice(i)}`;
      out += /^[\s"'`)\]}.,;!?]*$/.test(rest) ? rest.replace(/\s+/g, " ") : " [redacted]";
      stop = true;
    }
  }
  const flat = out.replace(/ {2,}/g, " ").trim().replace(HELD, (_mark, index) => held[Number(index)] ?? "[redacted]");
  if (flat.length <= TEXT_KEPT) return flat;
  // Never cut through a mark: half of one would be read as text the next time.
  return `${flat.slice(0, TEXT_KEPT - 1).replace(/\[[^\]]{0,20}$/, "").replace(/\{\{[^}]{0,60}\}?$/, "")}…`;
}

/**
 * One word, judged by itself. `then` is "stop" when the word names a
 * credential and its value begins here or next, and "named" when it is a
 * credential's name with nothing after it yet.
 */
function cleanWord(scrub: (text: string) => string, word: string, heldAt: (index: number) => string): { text: string; then?: "stop" | "named" } {
  // The word that says what kind of credential follows: as a credential's name, whatever follows it goes.
  if (isKind(word)) return { text: /^[A-Za-z]{1,9}[.!?]*$/.test(word) ? word : "Bearer", then: "named" };
  // A name further into the word: "Error:password=…", ":password:", "a=password=…". Not in an address, a path or a
  // query, which have rules of their own below.
  if (!word.includes("://") && !word.startsWith("/") && !word.includes("?")) {
    const pieces = word.split(/[=:]/);
    let at = 0;
    for (let k = 0; k < pieces.length; k++) {
      const piece = pieces[k]!;
      if (pieces.length > 1 && (piece.length > 160 || namesCredential(piece) || isKind(piece))) {
        const before = word.slice(0, at);
        const name = /^[A-Za-z0-9_.-]{1,80}$/.test(piece) && !opaque(piece) ? piece : "[redacted value]";
        if (isKind(piece)) return { text: `${before === "" ? "" : "[redacted value] "}Bearer [redacted]`, then: "stop" };
        const kept = /^[A-Za-z0-9_.=:-]{0,60}$/.test(before) && !opaque(before) && before.split(/[=:]/).every((part, index, parts) => !opaque(part) && !opaque(parts.slice(index).join("="))) ? before : "";
        // What stands before it is not kept: then neither is the name, which may be no name at all.
        const shownName = kept === "" && before !== "" ? "[redacted value]" : name;
        // The last part: its value is yet to come. Any other: it begins here.
        if (k === pieces.length - 1) return { text: `${kept}${shownName}`, then: "named" };
        return { text: `${kept}${shownName}${word[at + piece.length]}[redacted]`, then: "stop" };
      }
      at += piece.length + 1;
    }
  }
  // name=value, or name:value. The first separator decides.
  let separator = -1;
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "=" || word[i] === ":") {
      separator = i;
      break;
    }
  }
  // A credential's name before anything else: whatever its value looks like, an address too, nothing of it is kept.
  // In a path, the name is what stands after the last slash before the sign.
  const named = separator > 0 ? (word.startsWith("/") ? word.slice(word.lastIndexOf("/", separator) + 1, separator) : word.slice(0, separator)) : "";
  if (separator > 0 && (separator > 160 || namesCredential(named))) {
    const name = word.slice(0, separator);
    // In a path, what stands before the name is cleaned as a path.
    if (word.startsWith("/")) {
      const above = name.slice(0, name.lastIndexOf("/")).replace(HELD, "[redacted]");
      return { text: `${cleanPathWith(scrub, above).replace(/\/$/, "")}/[redacted]`, then: "stop" };
    }
    // A name is kept only if it reads as one.
    return { text: `${/^[A-Za-z0-9_.-]{1,80}$/.test(name) && !opaque(name) ? name : "[redacted value]"}${word[separator]}[redacted]`, then: "stop" };
  }
  // An address, wherever in the word it starts: its cleaned path, and nothing else of it or of the word.
  const scheme = word.indexOf("://");
  // An address with nothing where its kind should be is not one that can be read.
  if (scheme === 0) return { text: "[address]" };
  if (scheme > 0) {
    let from = scheme;
    while (from > 0 && isLetter(word.charCodeAt(from - 1)) && word.charCodeAt(from - 1) < 128 && scheme - from < 8) from -= 1;
    // A credential's name stuck in front of it, in whatever writing.
    if (from > 0 && namesCredential(word.slice(0, from))) return { text: "[redacted]", then: "stop" };
    try {
      const url = new URL(word.slice(from).replace(HELD, "x"));
      // A line and a column after a file's name, as an error's trace writes them, are kept.
      const place = /(:\d{1,7}){1,2}$/.exec(url.pathname)?.[0] ?? "";
      const cleaned = cleanPathWith(scrub, place === "" ? url.pathname : url.pathname.slice(0, -place.length));
      const last = cleaned.lastIndexOf("/");
      // A credential's name at the end of the path, with a colon after it.
      if (place !== "" && namesCredential(cleaned.slice(last + 1))) return { text: `${cleaned.slice(0, last)}/[redacted]`, then: "stop" };
      return { text: `${cleaned}${place}` };
    } catch {
      return { text: "[address]" };
    }
  }
  const query = word.indexOf("?");
  // A path, with no host: cleaned as a path, and nothing of its query.
  if (word.startsWith("/")) {
    let path = query > 0 ? word.slice(0, query) : word;
    // A stop or a colon after it is the sentence's.
    let after = "";
    while (query <= 0 && path.length > 1 && ".:".includes(path[path.length - 1]!)) {
      after = path[path.length - 1] + after;
      path = path.slice(0, -1);
    }
    const place = /(:\d{1,7}){1,2}$/.exec(path)?.[0] ?? "";
    // What is already clean in it is given to the path's own rules in the one form they keep.
    const plain = (place === "" ? path : path.slice(0, -place.length)).replace(HELD, (_mark, index) => (REDACTED.has(heldAt(Number(index))) || PLACEHOLDER.test(heldAt(Number(index))) ? heldAt(Number(index)) : "[redacted]"));
    const cleaned = cleanPathWith(scrub, plain);
    const last = cleaned.lastIndexOf("/");
    // A credential's name, once the path is read as it is meant, with a colon after it.
    if (`${place}${after}`.startsWith(":") && namesCredential(cleaned.slice(last + 1))) return { text: `${cleaned.slice(0, last)}/[redacted]`, then: "stop" };
    // As it reads once cleaned: a credential's name anywhere before a sign in it.
    const sign = cleaned.search(/[=:]/);
    if (sign > 0 && namesCredential(cleaned.slice(cleaned.lastIndexOf("/", sign) + 1, sign))) {
      const above = cleaned.slice(0, cleaned.lastIndexOf("/", sign));
      return { text: `${above}/[redacted]`, then: "stop" };
    }
    return { text: `${cleaned}${place}${after}` };
  }
  // A query after something that is not a path: what stands before it is judged by itself, and nothing of the query is kept.
  if (query >= 0 && query < word.length - 1 && !/^[.:!?]*$/.test(word.slice(query + 1))) {
    const before: { text: string; then?: "stop" | "named" } = query === 0 ? { text: "" } : cleanWord(scrub, word.slice(0, query), heldAt);
    if (before.then === "stop") return before;
    // A query that is already clean stands as it is.
    const after = /^[.:!?]*$/.test(word.slice(query + 1).replace(HELD, "")) ? word.slice(query + 1) : "[redacted]";
    return { text: `${before.text}?${after}`, ...(before.then === "named" ? { then: "stop" as const } : {}) };
  }
  // Something on each side of an @: an e-mail address, or a name and a host.
  const at = word.indexOf("@", 1);
  if (at > 0 && at < word.length - 1) return { text: "[redacted e-mail]" };
  if (separator > 0) {
    const name = word.slice(0, separator);
    const value = word.slice(separator + 1);
    // The value begins here, or is the next word. Either way nothing after the sign is kept.
    if (opaque(value)) return { text: `${opaque(name) ? "[redacted value]" : name}${word[separator]}[redacted value]` };
    return { text: opaque(name) ? `[redacted value]${word.slice(separator)}` : word };
  }
  if (separator === 0 && word.length > 1 && opaque(word.slice(1))) return { text: `${word[0]}[redacted value]` };
  // A name is looked for before a word is judged by its look: a long name is still a name, and its value follows.
  if (namesCredential(word)) return { text: opaque(word) ? "[redacted value]" : word, then: "named" };
  return { text: opaque(word) ? "[redacted value]" : word };
}
