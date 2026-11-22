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
 *   - `name=value` or `name: value` whose name is a credential's is kept as a
 *     name and loses its value, also when the value is the next word;
 *   - the word after Bearer, Basic or Token (so written) is replaced;
 *   - a value in quotes or brackets is replaced whole, and the values after
 *     Cookie up to the end of its list;
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
const PLACEHOLDER = /^\{\{secret:[^{}\s]{1,80}\}\}$/;
const REDACTED = new Set(["[redacted]", "[redacted-e-mail]"]);

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
  let plain = "";
  for (let i = 0; i < name.length && plain.length < 64; i++) {
    const code = name.charCodeAt(i);
    if (isLetter(code) && code < 128) plain += name[i]!.toLowerCase();
  }
  if (plain === "") return false;
  if (["auth", "authorization", "sid", "otp", "pin", "key", "sig", "pass", "pw"].includes(plain) || plain.endsWith("auth")) return true;
  return ["token", "secret", "passw", "passphrase", "passcode", "pwd", "credential", "apikey", "privatekey", "accesskey", "secretkey", "authkey", "signature", "csrf", "xsrf", "cookie", "session", "bearer"].some((word) => plain.includes(word));
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
  const read = pathname.length > PATH_READ ? pathname.slice(0, PATH_READ) : pathname;
  const semicolon = read.indexOf(";");
  const scrubbed = scrub(semicolon === -1 ? read : read.slice(0, semicolon)).replace(INVISIBLE, "");
  const out: string[] = [];
  for (const raw of scrubbed.split("/")) {
    if (raw === "" || raw === "." || raw === "..") continue;
    if (PLACEHOLDER.test(raw) || REDACTED.has(raw)) {
      out.push(raw);
      continue;
    }
    let segment = raw;
    try {
      // Known secrets are looked for again in what the segment says once decoded.
      segment = scrub(decodeURIComponent(raw));
    } catch {
      // Looked at as it is written.
    }
    out.push(PLACEHOLDER.test(segment) ? segment : cleanSegment(segment));
  }
  const joined = `/${out.join("/")}`;
  return joined.length > PATH_KEPT ? joined.slice(0, PATH_KEPT) : joined;
}

function cleanSegment(segment: string): string {
  if (segment.length > 80) return "[redacted]";
  const at = segment.indexOf("@");
  if (at > 0 && segment.indexOf(".", at) > at + 1) return "[redacted-e-mail]";
  // name=value inside a segment: the name stays if it is ordinary, the value never does when the name is a credential's.
  const equals = segment.indexOf("=");
  if (equals > 0) {
    const name = segment.slice(0, equals);
    if (namesCredential(name) || !ordinaryPart(name)) return "[redacted]";
    const value = cleanSegment(segment.slice(equals + 1));
    return `${encodeURIComponent(name)}=${value}`;
  }
  // A file name: its ending is kept, and each part of its name is judged by itself.
  const dot = segment.lastIndexOf(".");
  const ending = dot > 0 && segment.length - dot <= 6 && made(segment.slice(dot + 1)).others === 0 && made(segment.slice(dot + 1)).letters > 0 ? segment.slice(dot) : "";
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
  return `${rebuilt}${ending}`;
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
const CLOSES: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
/** Marks, in a text being cleaned, where something that is already clean stands. Private-use characters, removed from every input first. */
const HELD_OPEN = "";
const HELD_CLOSE = "";
const HELD = /(\d{1,4})/g;
/** What is already clean, and stands as it is: the engine's placeholder for a secret, and the marks this file writes. */
const CLEAN_ALREADY = /\{\{secret:[^{}\s]{1,80}\}\}|\[redacted(?: value| e-mail|-e-mail)?\]|\[address\]/g;

/** Whether a word, by its own look, is a key or a token and not a word. */
function opaque(word: string): boolean {
  if (word.length > 200) return true;
  const { letters, digits } = made(word);
  if (word.length >= 32 && letters + digits >= word.length * 0.8) return true;
  if (word.length >= 16 && letters > 0 && digits > 0 && letters + digits >= word.length * 0.8) return true;
  if (letters === 0 && digits >= 12) return true;
  if (word.startsWith("eyJ") && word.split(".").length >= 3) return true;
  return false;
}

/** Signs and words that stand between a credential's name and its value. */
const JOINS = new Set([":", "=", "=>", "->", ">", "|", "is", "was", "are"]);
/** The word that says what kind of credential follows. The credential is the word after it. */
const isKind = (word: string) => word === "Token" || word.toLowerCase() === "bearer" || word.toLowerCase() === "basic";

/**
 * A text made fit to leave the machine. `scrub` replaces the secret values the
 * caller knows; everything else is done here.
 *
 * The text is read once, a character at a time, into words and the signs
 * between them. A word is judged by itself; a small amount of state carries
 * from one word to the next: whether a credential was just named, and whether
 * its value is being passed over.
 */
export function cleanTextWith(scrub: (text: string) => string, text: string): string {
  // Known secrets are replaced in somewhat more than is kept, so that one lying across the cut is still found whole.
  const known = scrub((text.length > TEXT_READ * 4 ? text.slice(0, TEXT_READ * 4) : text).replace(INVISIBLE, "").replace(/[]/g, ""));
  // What is already clean is set aside, so that no rule below reads it and none is skipped because of it.
  const held: string[] = [];
  const marked = known.replace(CLEAN_ALREADY, (mark) => {
    held.push(mark);
    return `${HELD_OPEN}${held.length - 1}${HELD_CLOSE}`;
  });
  const cut = marked.length > TEXT_READ;
  // Cut after marking, and never through a mark.
  const read = cut ? marked.slice(0, TEXT_READ).replace(/\uE000\d{0,4}$/, "") : marked;

  let out = "";
  let words = 0;
  /** "named": a credential was named and its value has not come yet. "value": the value comes next. */
  const state: { expect: "nothing" | "named" | "value" } = { expect: "nothing" };
  /** While a value in quotes or brackets is passed over: what ends it, and how deep. */
  let until: { close: string; open: string; depth: number; left: number } | undefined;
  /** How many more words belong to a list of values after a name such as Cookie. */
  let list = 0;
  const say = (piece: string) => {
    out += piece;
  };

  let i = 0;
  while (i < read.length && out.length < TEXT_KEPT * 3 && words < 400) {
    const char = read[i]!;
    if (DELIMITERS.has(char)) {
      i += 1;
      if (until) {
        if (char === until.open) until.depth += 1;
        else if (char === until.close) {
          until.depth -= 1;
          if (until.depth === 0) {
            until = undefined;
            say(char);
          }
        }
        continue;
      }
      if (state.expect === "value" && (char === '"' || char === "'" || char === "`")) {
        // A value in quotes is all of it, however many words.
        until = { open: "\u0000", close: char, depth: 1, left: 60 };
        state.expect = "nothing";
        say(`${char}[redacted]`);
        continue;
      }
      if (state.expect === "value" && CLOSES[char]) {
        until = { open: char, close: CLOSES[char]!, depth: 1, left: 60 };
        state.expect = "nothing";
        say(`${char}[redacted]`);
        continue;
      }
      if (state.expect === "named" && (char === ">" || char === "|")) {
        state.expect = "value";
        say(char);
        continue;
      }
      // Any other sign ends a name that was given no value, but not the wait for a value, and not a quote around the name.
      if (state.expect === "named" && char !== " " && char !== "\t" && char !== "\n" && char !== "\r" && char !== '"' && char !== "'" && char !== "`") state.expect = "nothing";
      if (char === "\n" || char === "\r") list = 0;
      say(char === "\t" || char === "\n" || char === "\r" ? " " : char);
      continue;
    }
    let end = i;
    while (end < read.length && !DELIMITERS.has(read[end]!)) end += 1;
    let word = read.slice(i, end);
    let trail = "";
    if (word.includes("://")) {
      // An address runs to the next space or quote: the signs inside its query are part of it, not ends of words.
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
    if (cut && last) break;
    if (until) {
      until.left -= 1;
      if (until.left <= 0) until = undefined;
      continue;
    }
    if (word.includes("%")) {
      try {
        // As it would read once decoded: "token%3Dabc" is a name and a value.
        const decoded = decodeURIComponent(word);
        if (!/[\s"'`{}[\](),;&|<>]/.test(decoded)) word = decoded;
      } catch {
        // Read as it is written.
      }
    }
    if (state.expect === "value" || list > 0) {
      if (list > 0) list -= 1;
      if (state.expect === "value" && isKind(word)) {
        say(word);
        continue;
      }
      state.expect = "nothing";
      say("[redacted]");
      continue;
    }
    if (state.expect === "named" && JOINS.has(word)) {
      state.expect = "value";
      say(word);
      continue;
    }
    if (state.expect === "named" && (word.startsWith("=") || word.startsWith(":")) && word.length > 1) {
      state.expect = "nothing";
      say(`${word[0]}[redacted]`);
      continue;
    }
    state.expect = "nothing";
    HELD.lastIndex = 0;
    if (HELD.test(word) && word.replace(HELD, "") === "") {
      say(word);
      continue;
    }
    say(
      cleanWord(scrub, word, (next, values) => {
        state.expect = next;
        list = values;
      }) + trail,
    );
  }
  const flat = out.replace(/ {2,}/g, " ").trim().replace(HELD, (_mark, index) => held[Number(index)] ?? "[redacted]");
  return flat.length > TEXT_KEPT ? `${flat.slice(0, TEXT_KEPT - 1)}…` : flat;
}

/** One word, judged by itself. `then` says what the next words are, when this one named a credential. */
function cleanWord(scrub: (text: string) => string, word: string, then: (expect: "named" | "value", list: number) => void): string {
  if (isKind(word)) {
    then("value", 0);
    return word;
  }
  // An address, wherever in the word it starts: its cleaned path, and nothing else of it or of the word.
  const scheme = word.indexOf("://");
  if (scheme > 0) {
    let from = scheme;
    while (from > 0 && isLetter(word.charCodeAt(from - 1)) && word.charCodeAt(from - 1) < 128 && scheme - from < 8) from -= 1;
    try {
      const url = new URL(word.slice(from).replace(HELD, "x"));
      // A line and a column after a file's name, as an error's trace writes them, are kept.
      const place = /(:\d{1,7}){1,2}$/.exec(url.pathname)?.[0] ?? "";
      return `${cleanPathWith(scrub, place === "" ? url.pathname : url.pathname.slice(0, -place.length))}${place}`;
    } catch {
      return "[address]";
    }
  }
  // Something on each side of an @: an e-mail address, or a name and a host.
  const at = word.indexOf("@");
  if (at > 0 && at < word.length - 1) return "[redacted e-mail]";
  // name=value, or name:value. The first separator decides.
  let separator = -1;
  for (let i = 0; i < word.length && i < 80; i++) {
    if (word[i] === "=" || word[i] === ":") {
      separator = i;
      break;
    }
  }
  if (separator > 0) {
    const name = word.slice(0, separator);
    const value = word.slice(separator + 1).replace(/^[=>]+/, "");
    if (namesCredential(name)) {
      const kept = `${name}${word[separator]}`;
      if (value === "") {
        then("value", name.toLowerCase().includes("cookie") ? 12 : 0);
        return kept;
      }
      if (isKind(value)) {
        then("value", 0);
        return `${kept}${value}`;
      }
      return `${kept}[redacted]`;
    }
    if (opaque(value)) return `${opaque(name) ? "[redacted value]" : name}${word[separator]}[redacted value]`;
    return opaque(name) ? `[redacted value]${word.slice(separator)}` : word;
  }
  if (separator === 0 && word.length > 1 && opaque(word.slice(1))) return `${word[0]}[redacted value]`;
  if (namesCredential(word) && word.length <= 64) then("named", 0);
  return opaque(word) ? "[redacted value]" : word;
}
