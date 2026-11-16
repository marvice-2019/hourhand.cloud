// Messages written by shared library code (validators, importers, DNS checks) reach the dashboard as English text,
// because other callers and tests rely on that English. Each library file keeps its messages in a table of
// code -> English template ("Block up to {n} days at a time."). The dashboard turns a message back into its code and
// values here, then shows the host catalogue line for that code. lib-messages.test.ts checks the host English matches.
import type { HostI18n } from "./format";
import type { HostKey } from "./index";

export type MessageTable = Readonly<Record<string, string>>;

/** "{name}" in a template, with everything else matched literally. */
function pattern(template: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const body = template.split(/(\{\w+\})/).map((part) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (!name) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    names.push(name);
    return "([\\s\\S]*?)";
  }).join("");
  return { re: new RegExp(`^${body}$`), names };
}

/** Fills a template the way the library does. */
export const fillTemplate = (template: string, vars: Record<string, string | number> = {}) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** The code and values behind an English message from `table`, or null when it isn't one of them. */
export function decode<T extends MessageTable>(table: T, english: string): { code: keyof T & string; vars: Record<string, string> } | null {
  for (const [code, template] of Object.entries(table)) {
    const { re, names } = pattern(template);
    const m = re.exec(english);
    if (m) return { code, vars: Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) };
  }
  return null;
}

/**
 * Shows a library message in the host's language: `keys` names the host catalogue line for every code in `table`
 * (the compiler insists on all of them). Anything that isn't in the table is shown as it came.
 */
export function translator<T extends MessageTable>(table: T, keys: Record<keyof T, HostKey>) {
  return (t: HostI18n["t"], english: string): string => {
    const found = decode(table, english);
    return found ? t(keys[found.code], found.vars) : english;
  };
}
