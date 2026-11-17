/**
 * Tiny arithmetic evaluator for expected values such as
 * `100 + floor(firstSubtotal)`. Numbers, named variables, + - * /,
 * parentheses and a fixed set of functions. Nothing else is reachable, so a
 * formula written by a model can compute but cannot execute.
 */
const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
};

type Token = { type: "num" | "id" | "op"; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/(),]))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`Unexpected character in formula at position ${pos}: "${src.slice(pos, pos + 10)}"`);
    if (m[1] !== undefined) tokens.push({ type: "num", value: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: "id", value: m[2] });
    else tokens.push({ type: "op", value: m[3]! });
    pos = re.lastIndex;
  }
  return tokens;
}

/** Names a formula needs, excluding function names. */
export function formulaVariables(src: string): string[] {
  const tokens = tokenize(src);
  const names = tokens
    .filter((t, i) => t.type === "id" && !(tokens[i + 1]?.value === "(" && t.value in FUNCTIONS))
    .map((t) => t.value);
  return [...new Set(names)];
}

export function evaluateFormula(src: string, variables: Record<string, number>): number {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const take = (value?: string) => {
    const t = tokens[i];
    if (!t || (value !== undefined && t.value !== value)) {
      throw new Error(`Formula syntax error near token ${i}${value ? `, expected "${value}"` : ""}`);
    }
    i++;
    return t;
  };

  const expr = (): number => {
    let left = term();
    while (peek()?.value === "+" || peek()?.value === "-") {
      left = take().value === "+" ? left + term() : left - term();
    }
    return left;
  };
  const term = (): number => {
    let left = unary();
    while (peek()?.value === "*" || peek()?.value === "/") {
      left = take().value === "*" ? left * unary() : left / unary();
    }
    return left;
  };
  const unary = (): number => {
    if (peek()?.value === "-") {
      take();
      return -unary();
    }
    return primary();
  };
  const primary = (): number => {
    const t = take();
    if (t.type === "num") return Number(t.value);
    if (t.value === "(") {
      const v = expr();
      take(")");
      return v;
    }
    if (t.type === "id") {
      if (peek()?.value === "(") {
        const fn = FUNCTIONS[t.value];
        if (!fn) throw new Error(`Unknown function "${t.value}"`);
        take("(");
        const args = [expr()];
        while (peek()?.value === ",") {
          take();
          args.push(expr());
        }
        take(")");
        return fn(...args);
      }
      if (!Object.hasOwn(variables, t.value)) throw new Error(`Missing observation "${t.value}"`);
      return variables[t.value]!;
    }
    throw new Error(`Formula syntax error at "${t.value}"`);
  };

  const result = expr();
  if (i !== tokens.length) throw new Error(`Formula syntax error: unexpected "${tokens[i]!.value}"`);
  if (!Number.isFinite(result)) throw new Error("Formula did not produce a finite number");
  return result;
}
