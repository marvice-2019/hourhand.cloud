// The importer's messages (src/lib/import/messages.ts) and their host catalogue lines.
import { describe, expect, it } from "vitest";
import { clampBuffer, clampDuration } from "../../import/http";
import { IMPORT_MESSAGES, IMPORT_MESSAGE_KEYS, sayImportMessage } from "../../import/messages";
import { planImport } from "../../import/plan";
import { question } from "../../import/questions";
import type { ImportedEventType } from "../../import/types";
import { HOST_CATALOGS, type HostKey } from "./index";
import { decode, fillTemplate } from "./lib-messages";

// A stand-in for the host's t(): marks the line it was given, so the test sees which key was picked.
const t = (key: HostKey, vars?: Record<string, string | number>) => `[${key}]${fillTemplate(HOST_CATALOGS.en[key], vars)}`;

const eventType = (over: Partial<ImportedEventType> = {}): ImportedEventType => ({
  sourceId: "x", name: "Coaching", slug: "coaching", description: null, durationMinutes: 30, durationOptions: [], minNoticeMinutes: null,
  startIncrementMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, hidden: false, seatLimit: null,
  location: null, questions: [], notes: [], ...over,
});

describe("import messages", () => {
  it("has a host line for every code, with the same English", () => {
    for (const code of Object.keys(IMPORT_MESSAGES) as (keyof typeof IMPORT_MESSAGES)[]) {
      expect(HOST_CATALOGS.en[IMPORT_MESSAGE_KEYS[code]], code).toBe(IMPORT_MESSAGES[code]);
    }
  });

  it("decodes each template back to its own code", () => {
    for (const [code, template] of Object.entries(IMPORT_MESSAGES)) {
      const filled = fillTemplate(template, { label: "Cal.com", status: 502, user: "priya", max: 20, options: "30, 60", n: 30,
        from: 7, to: 5, min: 5, kind: "skype", });
      expect(decode(IMPORT_MESSAGES, filled)?.code, code).toBe(code);
    }
  });

  it("decodes real notes from the importer", () => {
    const notes: string[] = [];
    clampDuration(2000, notes);
    clampBuffer(-5, "after", notes);
    question("Pick one", "single_select", false, ["Only"], notes);
    question("Topics", "multi_select", false, ["a", "b"], notes, "checkboxGroup");
    expect(notes.map((n) => decode(IMPORT_MESSAGES, n))).toEqual([
      { code: "lengthChanged", vars: { from: "2000", to: "720", min: "5", max: "720" } },
      { code: "bufferAfterChanged", vars: { from: "-5", to: "0" } },
      { code: "fewChoices", vars: { label: "Pick one" } },
      { code: "nowMultiSelect", vars: { label: "Topics", from: "checkboxGroup" } },
    ]);
    const [moved] = planImport([eventType()], ["coaching"]);
    expect(moved.ok && moved.notes.map((n) => decode(IMPORT_MESSAGES, n))).toEqual([{ code: "slugMoved", vars: { from: "coaching", to: "coaching-2" } }]);
  });

  it("shows a failed check's joined editor messages line by line", () => {
    const [failed] = planImport([eventType({ durationMinutes: 1, bufferBeforeMinutes: 9999 })], []);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toBe("Pick a length between 5 and 720 minutes. Enter between 0 and 240 minutes.");
    expect(sayImportMessage(t, failed.error))
      .toBe("[eventTypes.errDurationRange]Pick a length between 5 and 720 minutes. [eventTypes.errBufferRange]Enter between 0 and 240 minutes.");
  });

  it("shows importer messages through their keys and leaves anything else as it came", () => {
    expect(sayImportMessage(t, IMPORT_MESSAGES.tickOne)).toBe(`[eventTypes.importMsgTickOne]${IMPORT_MESSAGES.tickOne}`);
    expect(sayImportMessage(t, "Calendly took too long to answer. Try again in a minute."))
      .toBe("[eventTypes.importMsgTimeout]Calendly took too long to answer. Try again in a minute.");
    expect(sayImportMessage(t, "Something new.")).toBe("Something new.");
  });
});
