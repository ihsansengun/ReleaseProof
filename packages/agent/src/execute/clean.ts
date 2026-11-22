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
 *   - the word after Bearer, Basic or Token is replaced;
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
const HOLDS_PLACEHOLDER = /\{\{secret:[^{}\s]{1,80}\}\}/;
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
  if (["auth", "authorization", "sid", "otp", "pin", "key", "sig", "pass", "pw"].includes(plain)) return true;
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
      segment = decodeURIComponent(raw);
    } catch {
      // Looked at as it is written.
    }
    out.push(cleanSegment(segment));
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
const encode = (text: string) => encodeURIComponent(text).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const OPENERS = new Set(['"', "'", "(", "[", "{", "<", "`"]);
const CLOSERS = new Set(['"', "'", ")", "]", "}", ">", "`", ",", ";", ".", ":", "!", "?"]);

/** The word without the punctuation around it, and that punctuation. */
function core(word: string): { before: string; middle: string; after: string } {
  let start = 0;
  let end = word.length;
  while (start < end && OPENERS.has(word[start]!)) start += 1;
  while (end > start && CLOSERS.has(word[end - 1]!)) end -= 1;
  return { before: word.slice(0, start), middle: word.slice(start, end), after: word.slice(end) };
}

/** Whether a word, by its own look, is a key or a token and not a word. */
function opaque(middle: string): boolean {
  if (middle.length > 200) return true;
  if (PLACEHOLDER.test(middle) || middle.startsWith("[redacted")) return false;
  const { letters, digits } = made(middle);
  if (middle.length >= 32 && letters + digits >= middle.length * 0.8) return true;
  if (middle.length >= 16 && letters > 0 && digits > 0 && letters + digits >= middle.length * 0.8) return true;
  if (letters === 0 && digits >= 12) return true;
  if (middle.startsWith("eyJ") && middle.split(".").length >= 3) return true;
  return false;
}

/**
 * A text made fit to leave the machine. `scrub` replaces the secret values the
 * caller knows; everything else is done here.
 */
export function cleanTextWith(scrub: (text: string) => string, text: string): string {
  const read = text.length > TEXT_READ ? text.slice(0, TEXT_READ) : text;
  const words = scrub(read.replace(INVISIBLE, "")).split(/\s+/);
  const out: string[] = [];
  // Set when the word before named a credential and gave no value: the value is this word.
  let valueNext = false;
  // Set when the word before was a credential's name and nothing else.
  let named = false;
  for (const word of words) {
    if (word === "") continue;
    if (out.length >= 120) break;
    const { before, middle, after } = core(word);
    // The engine's own placeholder for a secret, and what is already redacted, stand as they are.
    if (word.length <= 140 && (HOLDS_PLACEHOLDER.test(word) || word.includes("[redacted"))) {
      out.push(word);
      valueNext = false;
      named = false;
      continue;
    }
    // "secret => value", "token = value": the name, a sign by itself, then the value.
    if (named && (word === "=>" || word === "=" || word === ":" || word === "->")) {
      out.push(word);
      valueNext = true;
      named = false;
      continue;
    }
    named = false;
    if (valueNext) {
      valueNext = false;
      const said = middle.toLowerCase();
      // "Authorization: Bearer abc": the kind is not the secret, the word after it is.
      if (said === "bearer" || said === "basic" || said === "token") {
        out.push(word);
        valueNext = true;
      } else {
        out.push(`${before}[redacted]${after}`);
      }
      continue;
    }
    const lower = middle.toLowerCase();
    if (lower === "bearer" || lower === "basic") {
      out.push(word);
      valueNext = true;
      continue;
    }
    // An address, wherever in the word it starts: its cleaned path, and nothing else of it.
    const scheme = middle.indexOf("://");
    if (scheme > 0) {
      let from = scheme;
      while (from > 0 && isLetter(middle.charCodeAt(from - 1)) && middle.charCodeAt(from - 1) < 128 && scheme - from < 8) from -= 1;
      let path = "[address]";
      try {
        const url = new URL(middle.slice(from));
        // A line and a column after a file's name, as an error's trace writes them, are kept.
        const place = /(:\d{1,7}){1,2}$/.exec(middle)?.[0] ?? "";
        path = `${cleanPathWith(scrub, url.pathname.replace(/(:\d{1,7}){1,2}$/, ""))}${place}`;
      } catch {
        // Not an address after all, and nothing of it is kept.
      }
      const lead = middle.slice(0, from);
      out.push(`${before}${lead !== "" && !opaque(lead) && !lead.includes("=") && !lead.includes(":") ? lead : ""}${path}${after}`);
      continue;
    }
    const at = middle.indexOf("@");
    if (at > 0 && middle.indexOf(".", at) > at + 1) {
      out.push(`${before}[redacted e-mail]${after}`);
      continue;
    }
    // name=value, or name: value. The first separator decides.
    let separator = -1;
    for (let i = 0; i < middle.length && i < 80; i++) {
      if (middle[i] === "=" || middle[i] === ":") {
        separator = i;
        break;
      }
    }
    const endsWithColon = separator === -1 && after.startsWith(":");
    if (separator > 0 || endsWithColon) {
      const name = separator > 0 ? middle.slice(0, separator) : middle;
      if (namesCredential(name)) {
        const value = separator > 0 ? middle.slice(separator + 1) : "";
        if (value === "" || value === '"' || value === "'") {
          out.push(`${before}${name}${separator > 0 ? middle[separator] : ""}${after}`);
          valueNext = true;
        } else {
          out.push(`${before}${name}${middle[separator]}[redacted]${after.replace(/[^)\]},;]/g, "")}`);
        }
        continue;
      }
      if (separator > 0 && opaque(middle.slice(separator + 1))) {
        out.push(`${before}${opaque(name) ? "[redacted value]" : name}${middle[separator]}[redacted value]${after}`);
        continue;
      }
    }
    named = separator === -1 && !endsWithColon && namesCredential(middle) && middle.length <= 64;
    out.push(opaque(middle) ? `${before}[redacted value]${after}` : word);
  }
  const flat = out.join(" ");
  return flat.length > TEXT_KEPT ? `${flat.slice(0, TEXT_KEPT - 1)}…` : flat;
}
