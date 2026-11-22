/**
 * What may leave the machine of what a browser said, and in what form.
 *
 * No free text does. A console message, an exception's text, the words of a
 * locator and a value read from a page are written by the application under
 * test, in no known form, and nine attempts at cleaning such text by rules
 * each let something through that the one before had caught. So a text of
 * that kind is not cleaned here: it is not kept at all.
 *
 * What is kept is of two kinds, each with a form that can be checked:
 *
 *   - a path, cleaned segment by segment and closed by default: a segment is
 *     kept only if it reads as an ordinary name or a short number, and
 *     nothing after a segment that names a credential is kept;
 *   - a value that is a plain number or amount.
 *
 * Anything that does not fit its form is replaced or left out. Nothing here
 * guesses.
 */

/** Characters of a path that are looked at, and of a cleaned path. */
const PATH_READ = 1_000;
const PATH_KEPT = 200;
/** Segments of a path that are kept. */
const SEGMENTS = 20;

/** The engine's own placeholder for a secret the executor was given. */
const PLACEHOLDER = /^\{\{secret:[A-Za-z0-9_.-]{1,48}\}\}$/;
const REDACTED = "[redacted]";

const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
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

/** Whether a name is, or holds, the name of a credential. Only its letters are read, in lower case. */
export function namesCredential(name: string): boolean {
  let plain = "";
  for (let i = 0; i < name.length && i < 200; i++) {
    if (isLetter(name.charCodeAt(i))) plain += name[i]!.toLowerCase();
  }
  if (plain === "") return false;
  if (["auth", "sid", "otp", "pin", "key", "sig", "pass", "pw", "code", "reset", "verify", "magic", "invite", "confirm", "activate", "unsubscribe"].includes(plain)) return true;
  if (plain.endsWith("auth") || plain.endsWith("pass") || plain.endsWith("pw") || plain.endsWith("otp") || (plain.startsWith("auth") && !plain.startsWith("author"))) return true;
  return ["token", "secret", "passw", "passphrase", "passcode", "pwd", "credential", "signature", "csrf", "xsrf", "cookie", "session", "bearer", "jwt", "oauth", "apikey", "accesskey", "privatekey", "secretkey", "authkey"].some((word) => plain.includes(word));
}

/** Whether a word, by its own look, is a key or a token and not a name. */
function opaque(word: string): boolean {
  if (word.length > 40) return true;
  const { letters, digits } = made(word);
  if (word.length >= 16 && letters > 0 && digits > 0) return true;
  return letters === 0 && digits > 12;
}

/** A part of a path segment that reads as an ordinary name or a short number. */
function ordinaryPart(part: string): boolean {
  if (part === "" || part === REDACTED) return true;
  const { letters, digits, others } = made(part);
  if (others > 0) return false;
  if (digits === 0) return letters <= 24;
  if (letters === 0) return digits <= 12;
  // Letters and digits mixed: "v2", "sha1" and "oauth2" are names; a longer mix may be a password.
  return part.length <= 6;
}

/** One segment, already decoded: itself if it reads as ordinary, a file name with what is ordinary of it, or replaced. */
function cleanSegment(segment: string): string {
  if (segment === REDACTED) return segment;
  if (segment.length > 60 || !/^[\x21-\x7e]+$/.test(segment)) return REDACTED;
  // A picture's name with its size after an @ ("logo@2x.png").
  const sized = /^([A-Za-z0-9_.-]+)(@[1-4]x)(\.[A-Za-z0-9]{1,5})$/.exec(segment);
  // Anything else with an @ in it is an address or a name at a host: nothing of it is kept.
  if (!sized && segment.includes("@")) return REDACTED;
  const read = sized ? `${sized[1]}${sized[3]}` : segment;
  // A file name: its ending is kept, and each part of its name is judged by itself.
  const dot = read.lastIndexOf(".");
  const ending = dot > 0 && read.length - dot <= 6 && /^[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/.test(read.slice(dot + 1)) ? read.slice(dot) : "";
  const name = ending === "" ? read : read.slice(0, dot);
  const gone = ending === "" ? REDACTED : `${REDACTED}${ending}`;
  if (!/^[A-Za-z0-9_.~-]+$/.test(name.split(REDACTED).join("x"))) return gone;
  const parts = name.split(/[-_.~]/);
  // Many short groups is how a key is often written. Words are few.
  if (parts.length > 6) return gone;
  if (ending === "" && !parts.every(ordinaryPart)) return REDACTED;
  let rebuilt = "";
  let position = 0;
  let whole = true;
  for (const part of parts) {
    if (!ordinaryPart(part)) whole = false;
    rebuilt += ordinaryPart(part) ? part : REDACTED;
    position += part.length;
    if (position < name.length) rebuilt += name[position];
    position += 1;
  }
  if (rebuilt.length + ending.length > 60) return gone;
  return `${rebuilt}${sized && whole ? sized[2] : ""}${ending}`;
}

/** A text with every %-code in it decoded, however many times over it was encoded, up to three. Undefined when it cannot be read. */
function decoded(text: string): string | undefined {
  let plain = text;
  for (let round = 0; round < 3 && plain.includes("%"); round++) {
    let next: string;
    try {
      next = decodeURIComponent(plain);
    } catch {
      return undefined;
    }
    if (next === plain) break;
    plain = next;
  }
  return /%[0-9a-fA-F]{2}/.test(plain) ? undefined : plain;
}

/**
 * A path made fit to leave the machine: no query, fragment, parameters or
 * host, and each segment kept only as far as it reads as ordinary. `scrub`
 * replaces the secret values the caller knows.
 *
 * Closed by default. A segment that cannot be decoded, holds a character that
 * is not plain and printable, or does not read as a name is replaced. A
 * segment that names a credential is kept only if it is a plain word, and
 * every segment after it is replaced: a value follows its name in a path as
 * it does anywhere else ("/reset/token/…"). A path that, read as a whole,
 * holds a secret the caller knows is replaced whole.
 */
export function cleanPathWith(scrub: (text: string) => string, pathname: string): string {
  try {
    const out = cleanedPath(scrub, pathname);
    // What comes out must be a path of plain printable characters with no secret the caller knows in it.
    return scrub(out) === out && /^\/[\x21-\x7e]*$/.test(out) ? out : `/${REDACTED}`;
  } catch {
    // Nothing a page can put in an address may stop the run: what cannot be read is not kept.
    return `/${REDACTED}`;
  }
}

function cleanedPath(scrub: (text: string) => string, pathname: string): string {
  if (typeof pathname !== "string") return `/${REDACTED}`;
  const cut = pathname.length > PATH_READ ? pathname.slice(0, PATH_READ) : pathname;
  // Nothing after the first sign that ends a path: a query, a fragment, or parameters.
  const end = cut.search(/[?#;]/);
  const read = end === -1 ? cut : cut.slice(0, end);
  // A secret the caller knows, anywhere in the whole: as it reads decoded, with what is not shown taken out, and
  // with the empty and dotted segments a reader would skip taken out.
  const whole = decoded(read);
  if (whole === undefined) return `/${REDACTED}`;
  const flat = whole.replace(/[^\x20-\x7e]/g, "");
  const joinedUp = flat.replace(/\/(?:\.{0,2}\/)+/g, "/");
  if (scrub(whole) !== whole || scrub(flat) !== flat || scrub(joinedUp) !== joinedUp) return `/${REDACTED}`;
  // An address inside a path: a host and whatever follows it are not parts of this application's path.
  if (whole.includes("://")) return `/${REDACTED}`;
  const out: string[] = [];
  let afterCredential = false;
  for (const raw of read.split("/")) {
    if (raw === "" || raw === "." || raw === "..") continue;
    if (out.length >= SEGMENTS) {
      out.push(REDACTED);
      break;
    }
    if (afterCredential) {
      out.push(REDACTED);
      continue;
    }
    const segment = decoded(raw);
    if (segment === undefined || segment.includes("/")) {
      out.push(REDACTED);
      continue;
    }
    // The engine's own placeholder, and only when what it names reads as a name.
    if (PLACEHOLDER.test(segment) && !opaque(segment.slice(9, -2))) {
      out.push(segment);
      continue;
    }
    if (namesCredential(segment)) {
      afterCredential = true;
      out.push(/^[A-Za-z]{1,24}$/.test(segment) ? segment : REDACTED);
      continue;
    }
    out.push(cleanSegment(segment));
  }
  let joined = "";
  for (const segment of out) {
    if (joined.length + segment.length + 1 > PATH_KEPT) break;
    joined += `/${segment}`;
  }
  return joined === "" ? "/" : joined;
}

/**
 * A value read from a page or stated by a requirement, if it is a plain
 * number or amount: digits, with a sign, separators, a currency sign or a
 * percent sign. Undefined for anything else: words are free text, and free
 * text is not kept.
 */
export function plainAmount(value: unknown): string | undefined {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : undefined;
  if (text === undefined || text.length === 0 || text.length > 24) return undefined;
  if (!/^[-+]?[$€£¥]?\d{1,3}(?:[,. ]?\d{1,3}){0,5}(?:[.,]\d{1,4})?\s?%?$/.test(text)) return undefined;
  // A long run of digits is an account or a card, not an amount.
  if (text.replace(/\D/g, "").length > 12) return undefined;
  return text;
}
