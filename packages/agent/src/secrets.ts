/**
 * Keeps credential values away from the model and out of stored output.
 *
 * The model is shown a placeholder such as {{secret:account.password}}. Tools
 * swap the real value in at the moment of use, and everything that comes back
 * is scrubbed before it is returned, logged or written to a report.
 */
const SECRET_FIELD = /pass(word|phrase)?|secret|token|api[-_]?key|credential/i;

export class SecretVault {
  private byName = new Map<string, string>();

  private register(name: string, value: string): string {
    this.byName.set(name, value);
    return `{{secret:${name}}}`;
  }

  /** Returns a copy of fixture data with secret fields replaced by placeholders. */
  maskFixtures(
    fixtures: Record<string, unknown>,
    extraFields: Record<string, string[]> = {},
  ): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [alias, data] of Object.entries(fixtures)) {
      if (data === null || typeof data !== "object") {
        masked[alias] = data;
        continue;
      }
      const extra = extraFields[alias] ?? [];
      masked[alias] = Object.fromEntries(
        Object.entries(data).map(([field, value]) =>
          typeof value === "string" && value !== "" && (SECRET_FIELD.test(field) || extra.includes(field))
            ? [field, this.register(`${alias}.${field}`, value)]
            : [field, value],
        ),
      );
    }
    return masked;
  }

  /** Replaces placeholders with real values, anywhere inside a JSON-like value. */
  resolve<T>(value: T): T {
    if (typeof value === "string") {
      return value.replace(/\{\{secret:([^}]+)\}\}/g, (whole, name) => this.byName.get(name) ?? whole) as T;
    }
    if (Array.isArray(value)) return value.map((v) => this.resolve(v)) as T;
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.resolve(v)])) as T;
    }
    return value;
  }

  /** Replaces real values with their placeholders in text about to leave the process. */
  scrub(text: string): string {
    let out = text;
    // Longest first, so a secret that contains another is replaced whole.
    const entries = [...this.byName].sort((a, b) => b[1].length - a[1].length);
    for (const [name, value] of entries) out = out.split(value).join(`{{secret:${name}}}`);
    return out;
  }
}
