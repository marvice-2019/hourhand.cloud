import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCommit } from "./build-info";

const A = "146a6fa0123456789abcdef0123456789abcdef0";
const B = "7eb17c50123456789abcdef0123456789abcdef0";
const dirs: string[] = [];
const repo = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "hh-build-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, ".git", path, ".."), { recursive: true });
    writeFileSync(join(root, ".git", path), text);
  }
  return root;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("buildCommit", () => {
  it("prefers SOURCE_COMMIT and ignores anything that isn't a full sha", () => {
    expect(buildCommit({ SOURCE_COMMIT: A.toUpperCase() }, "/nowhere")).toBe(A);
    expect(buildCommit({ SOURCE_COMMIT: "main" }, repo({ HEAD: `${B}\n` }))).toBe(B);
  });
  it("reads a detached HEAD, a loose branch ref, or packed-refs", () => {
    expect(buildCommit({}, repo({ HEAD: `${A}\n` }))).toBe(A);
    expect(buildCommit({}, repo({ HEAD: "ref: refs/heads/main\n", "refs/heads/main": `${A}\n` }))).toBe(A);
    expect(buildCommit({}, repo({ HEAD: "ref: refs/heads/main\n", "packed-refs": `# pack-refs\n${B} refs/heads/main\n` }))).toBe(B);
  });
  it("returns null with no .git, and never follows a ref outside .git", () => {
    expect(buildCommit({}, "/nowhere")).toBeNull();
    expect(buildCommit({}, repo({ HEAD: "ref: ../../etc/passwd\n" }))).toBeNull();
  });
});
