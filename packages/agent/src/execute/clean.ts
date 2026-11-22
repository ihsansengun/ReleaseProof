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
 *     kept only if it reads as an ordinary name of letters (one short name
 *     with a digit, such as "v2", is kept once in a path; no other digit),
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

/**
 * Words that say that what follows is a credential or a link meant for one person. The long ones count wherever
 * in a name they stand, so a plural, a longer form or a joined word counts ("verification", "pwreset").
 */
const NAME_HOLDS = ["token", "secret", "passw", "passphrase", "passcode", "pwd", "credential", "signature", "csrf", "xsrf", "cookie", "session", "bearer", "jwt", "oauth", "apikey", "reset", "verif", "confirm", "activat", "invit", "magic", "unsubscrib", "recover", "licen", "voucher", "coupon", "redeem", "nonce", "authent", "authoriz"];
/**
 * The short ones count at the start or the end of a part of a name ("otpcode", "accesskey", "pins"), since that
 * is how they are joined to another word. A word that only happens to start or end so ("pink", "monkey") is
 * taken for a name too: what follows it is lost, and nothing is kept that should not be.
 */
const NAME_ENDS = ["auth", "otp", "pin", "key", "pass", "code", "mfa", "tfa", "sso", "grant", "salt", "serial", "cvv", "cvc", "ssn"];
/** Two letters are too few to look for inside a word: these count only as a whole part. */
const NAME_PARTS = new Set(["pw", "fa", "sig", "sid"]);

/**
 * Whether a name is, or holds, the name of a credential. The name is read a part at a time: its letters, split
 * where anything that is not a letter stands and where a capital begins a word, in lower case.
 */
export function namesCredential(name: string): boolean {
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((part) => part !== "");
  if (parts.length === 0) return false;
  const whole = parts.join("");
  if (NAME_HOLDS.some((word) => whole.includes(word))) return true;
  const plural = (part: string) => (part.endsWith("es") ? [part, part.slice(0, -1), part.slice(0, -2)] : part.endsWith("s") ? [part, part.slice(0, -1)] : [part]);
  return [...parts, whole].some((part) => plural(part).some((form) => NAME_PARTS.has(form) || NAME_ENDS.some((word) => form.startsWith(word) || form.endsWith(word))));
}

/** A part of a path segment that reads as an ordinary name or a short number. */
function ordinaryPart(part: string): boolean {
  if (part === "" || part === REDACTED) return true;
  const { letters, digits, others } = made(part);
  if (others > 0) return false;
  if (digits === 0) return letters <= 24;
  // A number is an id, a code or a count, and which cannot be told: it is not kept.
  return false;
}

/** The endings of the files a web application serves. Any other ending is not one: ".example" is the end of a host's name. */
const ENDINGS = new Set(["js", "mjs", "cjs", "css", "map", "json", "html", "htm", "xml", "txt", "csv", "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "woff", "ttf", "otf", "webm", "wasm", "ts", "tsx", "jsx", "vue"]);

/** One segment, already decoded: itself if it reads as ordinary, a file name with what is ordinary of it, or replaced. */
function cleanSegment(segment: string): string {
  if (segment === REDACTED) return segment;
  if (segment.length > 60 || !/^[\x21-\x7e]+$/.test(segment)) return REDACTED;
  // Anything with an @ in it is an address or a name at a host: nothing of it is kept.
  if (segment.includes("@")) return REDACTED;
  const read = segment;
  // A file name: its ending is kept, and each part of its name is judged by itself.
  const dot = read.lastIndexOf(".");
  const ending = dot > 0 && ENDINGS.has(read.slice(dot + 1).toLowerCase()) ? read.slice(dot) : "";
  const name = ending === "" ? read : read.slice(0, dot);
  const gone = ending === "" ? REDACTED : `${REDACTED}${ending}`;
  // Letters, digits and the signs that join words. A dot inside a name is how a host or an address is written.
  if (!/^[A-Za-z0-9_~-]+$/.test(name.split(REDACTED).join("x"))) return gone;
  const parts = name.split(/[-_~]/);
  // Many short groups is how a key is often written. Words are few.
  if (parts.length > 6) return gone;
  if (ending === "" && !parts.every(ordinaryPart)) return REDACTED;
  let rebuilt = "";
  let position = 0;
  for (const part of parts) {
    rebuilt += ordinaryPart(part) ? part : REDACTED;
    position += part.length;
    if (position < name.length) rebuilt += name[position];
    position += 1;
  }
  if (rebuilt.length + ending.length > 60) return gone;
  return `${rebuilt}${ending}`;
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
  // A path longer than is read is not read in part: a cut can go through a secret and leave most of it.
  if (pathname.length > PATH_READ * 4) return `/${REDACTED}`;
  // A value the caller knows, anywhere in what was given, before anything is cut off it: such a value may itself
  // hold one of the signs that end a path.
  const given = decoded(pathname) ?? pathname;
  if (scrub(pathname) !== pathname || scrub(given) !== given) return `/${REDACTED}`;
  // Nothing after the first sign that ends a path: a query, a fragment, or parameters.
  const end = pathname.slice(0, PATH_READ + 1).search(/[?#;]/);
  const read = end === -1 ? pathname : pathname.slice(0, end);
  if (read.length > PATH_READ) return `/${REDACTED}`;
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
  let versioned = false;
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
      // What cannot be read as one segment may still name a credential, or hide one: nothing after it is kept.
      afterCredential = true;
      out.push(REDACTED);
      continue;
    }
    // One short name of letters with one or two digits after them ("v2", "sha1", "md5"), once in a path: more of
    // them, or longer ones, are how a key is written in groups.
    if (!versioned && /^[A-Za-z]{1,3}\d{1,2}$/.test(segment) && !namesCredential(segment)) {
      versioned = true;
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
 * number or amount: digits, with a sign, commas between groups of three, one
 * fraction, a currency sign or a percent sign, and no space inside. Undefined for anything else: words are free text, and free
 * text is not kept.
 */
export function plainAmount(value: unknown): string | undefined {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : undefined;
  if (text === undefined || text.length === 0 || text.length > 24) return undefined;
  // Digits in one run, or in groups of three with commas; then at most one fraction; nothing else between.
  if (!/^[-+]?[$€£¥]?(?:\d{1,12}|\d{1,3}(?:,\d{3}){1,3})(?:[.,]\d{1,4})?%?$/.test(text)) return undefined;
  // A long run of digits is an account or a card, not an amount.
  if (text.replace(/\D/g, "").length > 12) return undefined;
  return text;
}
