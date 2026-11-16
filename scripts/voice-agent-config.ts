// Writes the phone receptionist's ElevenLabs configuration to docs/voice/ for review and setup: the four server tools
// and an example agent. Ids are placeholders that docs/voice-receptionist.md tells you how to fill.
// Usage: node scripts/voice-agent-config.ts [base url, default https://hourhand.cloud]
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { agentConfig, toolConfigs } from "../src/lib/voice/agent-config.ts";

const OUT = fileURLToPath(new URL("../docs/voice/", import.meta.url));

/** The files, by name, as they are committed. */
export function voiceConfigFiles(baseUrl = "https://hourhand.cloud"): Record<string, string> {
  const files: Record<string, string> = {};
  for (const t of toolConfigs(baseUrl)) files[`tool.${t.tool_config.name}.json`] = `${JSON.stringify(t, null, 2)}\n`;
  files["agent.example.json"] = `${JSON.stringify(agentConfig({ hostName: "Dr Meera Rao", hostSlug: "meera", recordingEnabled: false }), null, 2)}\n`;
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(OUT, { recursive: true });
  for (const [name, text] of Object.entries(voiceConfigFiles(process.argv[2]))) await writeFile(OUT + name, text);
  console.log(`Wrote ${Object.keys(voiceConfigFiles()).length} files to docs/voice/`);
}
