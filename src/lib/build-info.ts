import { readFileSync } from "node:fs";
import { join } from "node:path";

const SHA = /^[0-9a-f]{40}$/;

/**
 * The commit being built, so /api/health can say which version is live. Prefers SOURCE_COMMIT (Coolify passes it
 * when "include source commit" is on), else reads .git directly: the slim build image has no git binary.
 */
export function buildCommit(env: Record<string, string | undefined> = process.env, root = process.cwd()): string | null {
  const fromEnv = env.SOURCE_COMMIT?.trim().toLowerCase();
  if (fromEnv && SHA.test(fromEnv)) return fromEnv;
  try {
    const gitDir = join(root, ".git");
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (SHA.test(head)) return head; // detached, as a deploy checkout usually is
    const ref = head.startsWith("ref: ") ? head.slice(5) : null;
    if (!ref || ref.includes("..")) return null;
    try {
      const loose = readFileSync(join(gitDir, ref), "utf8").trim();
      if (SHA.test(loose)) return loose;
    } catch {
      // not a loose ref: look in packed-refs below
    }
    for (const line of readFileSync(join(gitDir, "packed-refs"), "utf8").split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref && SHA.test(sha)) return sha;
    }
  } catch {
    // no .git in the build context
  }
  return null;
}
