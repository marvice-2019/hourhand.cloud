// Finds words a host can read that are typed straight into dashboard code instead of coming from the host catalogue.
// Used by scan.test.ts; run it on its own with `npx vitest run src/lib/i18n/host`. See docs/i18n-host.md.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export interface Finding { file: string; line: number; text: string }

/** Names and product terms that read the same in every language; a string that is exactly one of these is fine. */
export const SAME_IN_EVERY_LANGUAGE = new Set([
  "Hourhand", "Google", "Google Calendar", "Google Meet", "Zoom", "Microsoft Teams", "Outlook", "Microsoft Outlook", "iCloud", "Apple",
  "WhatsApp", "Razorpay", "Stripe", "GST", "UPI", "Calendly", "Cal.com", "GSTIN", "PAN", "IST", "CSV", "PDF", "HSN", "SAC", "QR",
  "English", "हिन्दी", "தமிழ்", "తెలుగు", "ಕನ್ನಡ",
]);

/** JSX attributes whose value a person reads or hears. */
const COPY_ATTRS = new Set(["aria-label", "aria-description", "aria-valuetext", "placeholder", "title", "alt", "label", "heading", "description", "hint", "summary", "legend", "confirm", "confirmText", "emptyText", "message", "text", "caption", "submitLabel", "pendingLabel", "successText"]);
/** JSX attributes that never hold copy, whatever they look like. */
const CODE_ATTRS = new Set(["className", "href", "id", "name", "type", "htmlFor", "key", "variant", "size", "method", "action", "inputMode", "autoComplete", "rel", "target", "role", "lang", "pattern", "step", "min", "max", "accept", "src", "d", "viewBox", "fill", "stroke", "form", "enterKeyHint", "dir", "translate", "aria-controls", "aria-describedby", "aria-labelledby", "aria-current", "aria-live", "aria-haspopup", "data-testid"]);
/** Object properties whose value is copy (a label in a list of options, an error message returned to a form). */
const COPY_PROPS = new Set(["label", "title", "heading", "description", "hint", "message", "error", "text", "needs", "placeholder", "summary", "help", "body", "intro", "note", "cta", "subject", "legend", "caption", "empty"]);
/** Calls whose string arguments are never shown to a host as written. */
const QUIET_CALLS = /^(t|ht|htNodes|tNodes|i18n\.t|i18n\.tNodes|redirect|permanentRedirect|revalidatePath|revalidateTag|console\.\w+|require|import|cookies|headers|get|getAll|has|set|delete|append|query|pool\.query|db\.query|client\.query|searchParams\.get|form\.get|form\.getAll|field|fetch|encodeURIComponent|URL|Date|RegExp|startsWith|endsWith|includes|split|replace|replaceAll|join|match|test|padStart|toLocaleString|Intl\.\w+|isNamedError)$/;

/** "bookings.title": a key into the host catalogue, not words. */
const CATALOGUE_KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
const words = (s: string) => /\p{L}{2,}/u.test(s);
const looksLikeClasses = (s: string) => s.trim().split(/\s+/).every((w) => /^[a-z0-9:\-[\]/().%_!&>*~#=@,'"+]*$/.test(w));

/** A sentence, a phrase or a capitalised label, as opposed to an identifier, a class list, a path or SQL. */
export function looksLikeCopy(s: string): boolean {
  const text = s.trim();
  if (!words(text) || SAME_IN_EVERY_LANGUAGE.has(text)) return false;
  if (/^(https?:|mailto:|tel:|\/|\.\/|#|@\/)/.test(text)) return false;
  if (looksLikeClasses(text)) return false;
  if (/[\p{L}]/u.test(text) && /[^\x00-\x7F]/.test(text) && !/^[\s\p{P}\p{S}\d]*$/u.test(text)) return true; // any non-Latin script word
  if (/\s/.test(text)) return /\b[A-Z][a-z]|[.!?:…]$|\b(you|your|the|a|an|to|of|for|and|or|in|on|is|are|isn't|can't|don't)\b/.test(text);
  return /^[A-Z][a-z]+[a-z'’]*[.!?…]?$/.test(text) || /[.!?…]$/.test(text);
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return ts.isIdentifier(e.expression) ? `${e.expression.text}.${e.name.text}` : e.name.text;
  return "";
}

function attrName(a: ts.JsxAttribute): string {
  return ts.isIdentifier(a.name) ? a.name.text : a.name.getText();
}

/** Every hard-coded string a host could read in one file. */
export function scanSource(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = source.split("\n");
  const ignored = (pos: number) => {
    const line = sf.getLineAndCharacterOfPosition(pos).line;
    return /i18n-ignore/.test(lines[line] ?? "") || /i18n-ignore/.test(lines[line - 1] ?? "");
  };
  const out: Finding[] = [];
  const report = (node: ts.Node, text: string) => {
    if (ignored(node.getStart(sf))) return;
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.trim().replace(/\s+/g, " ").slice(0, 90) });
  };

  const inQuietPlace = (node: ts.Node): boolean => {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isTypeNode(p)) return true;
      if (ts.isCallExpression(p) && QUIET_CALLS.test(calleeName(p))) return true;
      if (ts.isNewExpression(p) && /Error$|^(URL|Date|RegExp|Map|Set|URLSearchParams)$/.test(calleeName(p))) return true;
      if (ts.isThrowStatement(p)) return true;
      if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
      if (ts.isCaseClause(p) && p.expression === node) return true;
      if (ts.isElementAccessExpression(p)) return true;
      if (ts.isJsxAttribute(p) || ts.isPropertyAssignment(p) || ts.isStatement(p)) return false;
    }
    return false;
  };

  const check = (node: ts.Node, text: string) => {
    if (inQuietPlace(node) || CATALOGUE_KEY.test(text)) return;
    const parent = node.parent;
    const holder = ts.isJsxExpression(parent) ? parent.parent : parent;
    if (ts.isJsxAttribute(holder)) {
      const name = attrName(holder);
      if (CODE_ATTRS.has(name)) return;
      if (COPY_ATTRS.has(name) ? words(text) && !SAME_IN_EVERY_LANGUAGE.has(text.trim()) : looksLikeCopy(text)) report(node, text);
      return;
    }
    if (ts.isJsxExpression(parent) && (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))) {
      if (words(text) && !SAME_IN_EVERY_LANGUAGE.has(text.trim())) report(node, text);
      return;
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
      const prop = parent.name.getText(sf).replace(/["']/g, "");
      if (COPY_PROPS.has(prop) ? words(text) && !SAME_IN_EVERY_LANGUAGE.has(text.trim()) : looksLikeCopy(text)) report(node, text);
      return;
    }
    if (looksLikeCopy(text)) report(node, text);
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText(sf);
      if (/\p{L}/u.test(text) && !SAME_IN_EVERY_LANGUAGE.has(text.trim().replace(/&apos;/g, "'"))) report(node, text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) check(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      const text = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" {} ");
      check(node, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const SRC = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
  return null;
}

/**
 * The files that make up the host's dashboard: everything under src/app/dashboard (pages, layouts, server actions)
 * and every component under src/components they use, directly or through another component.
 */
export function dashboardFiles(): string[] {
  const pages = walk(join(SRC, "app/dashboard")).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  const components = new Set<string>();
  const queue = [...pages];
  while (queue.length) {
    const file = queue.pop() as string;
    for (const m of readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)) {
      const target = resolveImport(file, m[1]);
      if (target && target.startsWith(join(SRC, "components")) && !components.has(target)) {
        components.add(target);
        queue.push(target);
      }
    }
  }
  return [...pages, ...components].map((f) => relative(join(SRC, ".."), f)).sort();
}

export const readRepoFile = (file: string) => readFileSync(join(SRC, "..", file), "utf8");
