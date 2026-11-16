"use client";

import Link from "next/link";
import { currencyLabel } from "@/lib/money";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { deleteEventType, saveEventType } from "@/app/dashboard/event-types/actions";
import type { CustomQuestion, LocationKind, QuestionDraft } from "@/lib/data/types";
import type { ZoomSetup } from "@/lib/zoom/connection";
import { ZoomHint } from "./ZoomHint";
import { START_INCREMENTS, slugify, type EventTypeErrors, type EventTypeForm, type QuestionErrors } from "@/lib/event-types";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { focusRing } from "./ui/focus";
import { Input, Label } from "./ui/Input";
import { useHostI18n } from "./HostI18nProvider";
import type { HostKey } from "@/lib/i18n/host";

const TABS = [
  { id: "details", label: "eventTypes.tabDetails" },
  { id: "rules", label: "eventTypes.tabRules" },
  { id: "form", label: "eventTypes.tabForm" },
] as const satisfies readonly { id: string; label: HostKey }[];
type TabId = (typeof TABS)[number]["id"];

const DETAIL_FIELDS: (keyof EventTypeForm)[] = ["name", "slug", "durationMinutes", "price", "deposit", "description", "locationKind", "locationValue"];
const PRESET_DURATIONS = [15, 30, 45, 60];

const LOCATIONS: { kind: LocationKind | ""; label: HostKey }[] = [
  { kind: "google_meet", label: "eventTypes.locGoogleMeet" },
  { kind: "zoom", label: "eventTypes.locZoom" },
  { kind: "teams", label: "eventTypes.locTeams" },
  { kind: "phone_host_calls", label: "eventTypes.locPhoneHostCalls" },
  { kind: "phone_guest_calls", label: "eventTypes.locPhoneGuestCalls" },
  { kind: "in_person", label: "eventTypes.locInPerson" },
  { kind: "custom", label: "eventTypes.locCustom" },
  { kind: "ask_guest", label: "eventTypes.locAskGuest" },
  { kind: "", label: "eventTypes.locLater" },
];

/** The label for the value a location needs (an address, a phone number); same kinds as LOCATION_VALUE_LABEL. */
const LOCATION_VALUE_KEY: Partial<Record<LocationKind, HostKey>> = {
  in_person: "eventTypes.valueAddress",
  phone_guest_calls: "eventTypes.valuePhone",
  custom: "eventTypes.valueDetails",
};

const QUESTION_KINDS: { kind: CustomQuestion["kind"]; label: HostKey }[] = [
  { kind: "short_text", label: "eventTypes.kindShort" },
  { kind: "long_text", label: "eventTypes.kindLong" },
  { kind: "single_select", label: "eventTypes.kindSelect" },
];

const fieldClasses = (invalid: boolean) =>
  `mt-1 block w-full rounded-md border bg-card px-3 text-base text-text ${invalid ? "border-danger" : "border-border-input"} ${focusRing}`;

type EditableQuestion = QuestionDraft & { key: string };

export interface EventTypeEditorProps {
  id: string | null;
  userSlug: string;
  initial: EventTypeForm;
  initialQuestions: QuestionDraft[];
  /** Shows "Saved" on arrival, after creating a new event type. */
  justSaved?: boolean;
  /** The currency prices are saved in (the host's payment provider's), and which provider takes them. */
  currency?: string;
  provider?: "razorpay" | "stripe" | null;
  /** Whether choosing Zoom gets bookings a link. */
  zoomSetup?: ZoomSetup;
}

export function EventTypeEditor({ id, userSlug, initial, initialQuestions, justSaved = false, currency = "INR", provider = null, zoomSetup = "not_configured" }: EventTypeEditorProps) {
  const router = useRouter();
  const { t, tNodes } = useHostI18n();
  const [tab, setTab] = useState<TabId>("details");
  const [form, setForm] = useState(initial);
  const [customDuration, setCustomDuration] = useState(!PRESET_DURATIONS.includes(Number(initial.durationMinutes)));
  const [questions, setQuestions] = useState<EditableQuestion[]>(() => initialQuestions.map((q, i) => ({ ...q, key: q.id ?? `new-${i}` })));
  const [errors, setErrors] = useState<EventTypeErrors>({});
  const [questionErrors, setQuestionErrors] = useState<QuestionErrors>([]);
  const [status, setStatus] = useState<"idle" | "saved" | "invalid">(justSaved ? "saved" : "idle");
  const [saving, startSaving] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, startDeleting] = useTransition();
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  const set = (key: Exclude<keyof EventTypeForm, "hidden">) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setStatus("idle");
  };
  const previewSlug = form.slug.trim().toLowerCase() || slugify(form.name) || "your-link";

  const tabHasErrors = (tabId: TabId) =>
    tabId === "form"
      ? questionErrors.some((e) => e.label || e.choices)
      : Object.keys(errors).some((k) => DETAIL_FIELDS.includes(k as keyof EventTypeForm) === (tabId === "details"));

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const i = TABS.findIndex((x) => x.id === tab);
    const next = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i - 1 + TABS.length) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[TABS[next].id]?.focus();
  }

  function updateQuestion(index: number, patch: Partial<QuestionDraft>) {
    setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, ...patch } : q)));
    setStatus("idle");
  }
  function moveQuestion(index: number, by: -1 | 1) {
    setQuestions((qs) => {
      const next = [...qs];
      [next[index], next[index + by]] = [next[index + by], next[index]];
      return next;
    });
    setQuestionErrors([]);
    setStatus("idle");
  }
  function removeQuestion(index: number) {
    setQuestions((qs) => qs.filter((_, i) => i !== index));
    setQuestionErrors((es) => es.filter((_, i) => i !== index));
    setStatus("idle");
  }
  function addQuestion() {
    setQuestions((qs) => [...qs, { key: crypto.randomUUID(), id: null, label: "", kind: "short_text", required: false, choices: [] }]);
    setStatus("idle");
  }

  function save() {
    startSaving(async () => {
      const result = await saveEventType(id, form, questions.map(({ id: qid, label, kind, required, choices }) => ({ id: qid, label, kind, required, choices })));
      if (!result.ok) {
        setErrors(result.errors);
        setQuestionErrors(result.questionErrors);
        setStatus("invalid");
        const keys = Object.keys(result.errors) as (keyof EventTypeForm)[];
        if (keys.some((k) => DETAIL_FIELDS.includes(k))) setTab("details");
        else if (keys.length > 0) setTab("rules");
        else setTab("form");
        return;
      }
      setErrors({});
      setQuestionErrors([]);
      if (!id) {
        router.replace(`/dashboard/event-types/${result.id}?saved=1`);
        return;
      }
      setForm((f) => ({ ...f, slug: result.slug }));
      setStatus("saved");
      router.refresh();
    });
  }

  function remove() {
    if (!id) return;
    startDeleting(async () => {
      const result = await deleteEventType(id);
      if (result.ok) router.push("/dashboard/event-types");
      else setDeleteError(result.error);
    });
  }

  const numberField = (key: Exclude<keyof EventTypeForm, "hidden" | "redirectUrl" | "cancelPolicy">, label: string, unit: string, hint?: string) => (
    <div>
      <Label htmlFor={`f-${key}`}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={`f-${key}`} inputMode="numeric" value={form[key] ?? ""} onChange={(e) => set(key)(e.target.value)} error={errors[key]}
          aria-describedby={hint ? `f-${key}-hint` : undefined} className="max-w-32"
        />
        <span className="mt-1 text-sm text-text-muted">{unit}</span>
      </div>
      {hint && <p id={`f-${key}-hint`} className="mt-1 text-sm text-text-muted">{hint}</p>}
    </div>
  );

  const valueKey = form.locationKind ? LOCATION_VALUE_KEY[form.locationKind] : undefined;
  const valueLabel = valueKey ? t(valueKey) : undefined;

  return (
    <div className="mt-6">
      <div role="tablist" aria-label={t("eventTypes.tabsLabel")} className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((x) => (
          <button
            key={x.id} ref={(el) => { tabRefs.current[x.id] = el; }} type="button" role="tab" id={`tab-${x.id}`}
            aria-selected={tab === x.id} aria-controls={`panel-${x.id}`} tabIndex={tab === x.id ? 0 : -1}
            onClick={() => setTab(x.id)} onKeyDown={onTabKey}
            className={`min-h-11 shrink-0 rounded-t-md px-3 text-sm ${focusRing} ${tab === x.id ? "border-b-2 border-accent font-semibold text-text" : "text-text-muted hover:text-text"}`}
          >
            {t(x.label)}
            {tabHasErrors(x.id) && <span className="ml-1 text-danger">{t("eventTypes.tabCheck")}</span>}
          </button>
        ))}
      </div>

      <Panel id="details" active={tab}>
        <div>
          <Label htmlFor="f-name">{t("eventTypes.name")}</Label>
          <Input id="f-name" value={form.name} onChange={(e) => set("name")(e.target.value)} error={errors.name} placeholder={t("eventTypes.namePlaceholder")} />
        </div>
        <div>
          <Label htmlFor="f-slug">{t("eventTypes.slug")}</Label>
          <Input
            id="f-slug" value={form.slug} onChange={(e) => set("slug")(e.target.value)} error={errors.slug}
            aria-describedby="f-slug-hint" autoCapitalize="none" spellCheck={false} placeholder={slugify(form.name) || "intro-call"}
          />
          <p id="f-slug-hint" className="mt-1 break-all text-sm text-text-muted">
            {tNodes("eventTypes.slugHint", {
              // i18n-ignore: the booking address, not words
              url: <span className="font-mono text-text">{`hourhand.app/${userSlug}/${previewSlug}`}</span>,
            })}
          </p>
        </div>
        <fieldset>
          <legend className="text-sm font-semibold text-text">{t("eventTypes.length")}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {PRESET_DURATIONS.map((m) => (
              <Choice key={m} name="duration" checked={!customDuration && form.durationMinutes === String(m)}
                onChange={() => { setCustomDuration(false); set("durationMinutes")(String(m)); }}>{t("common.minutes", { n: m })}</Choice>
            ))}
            <Choice name="duration" checked={customDuration} onChange={() => setCustomDuration(true)}>{t("eventTypes.custom")}</Choice>
          </div>
          {customDuration ? (
            <div className="mt-3">{numberField("durationMinutes", t("eventTypes.customLength"), t("eventTypes.unitMinutes"), t("eventTypes.customLengthHint"))}</div>
          ) : errors.durationMinutes && <p className="mt-1 text-sm text-danger">{errors.durationMinutes}</p>}
        </fieldset>
        <div>
          <Label htmlFor="f-price">{t("eventTypes.price", { currency: currencyLabel(currency) })}</Label>
          <Input
            id="f-price" inputMode="decimal" value={form.price} onChange={(e) => set("price")(e.target.value)} error={errors.price}
            aria-describedby="f-price-hint" className="max-w-32" placeholder={t("eventTypes.pricePlaceholder")}
          />
          <p id="f-price-hint" className="mt-1 text-sm text-text-muted">{t("eventTypes.priceHint", { provider: provider === "stripe" ? "Stripe" : "Razorpay" })}</p>
          {errors.price && (
            <div className="flex flex-wrap gap-x-4">
              <Link href="/dashboard/plan" className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("eventTypes.seePlans")}</Link>
              <Link href="/dashboard/integrations" className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("eventTypes.connectPayments")}</Link>
            </div>
          )}
        </div>
        <div>
          <Label htmlFor="f-deposit">{t("eventTypes.deposit", { currency: currencyLabel(currency) })}</Label>
          <Input
            id="f-deposit" inputMode="decimal" value={form.deposit} onChange={(e) => set("deposit")(e.target.value)} error={errors.deposit}
            aria-describedby="f-deposit-hint" className="max-w-32" placeholder={t("eventTypes.depositPlaceholder")}
          />
          <p id="f-deposit-hint" className="mt-1 text-sm text-text-muted">
            {t("eventTypes.depositHint")}
          </p>
        </div>
        <div>
          <label className="flex min-h-11 items-start gap-3">
            <input
              type="checkbox" checked={form.hidden} aria-describedby="f-hidden-hint" className="mt-1 size-5 accent-accent"
              onChange={(e) => { const hidden = e.target.checked; setForm((f) => ({ ...f, hidden })); setStatus("idle"); }}
            />
            <span className="font-semibold text-text">{t("eventTypes.hidden")}</span>
          </label>
          <p id="f-hidden-hint" className="mt-1 text-sm text-text-muted">{t("eventTypes.hiddenHint")}</p>
        </div>
        <div>
          <Label htmlFor="f-location">{t("eventTypes.location")}</Label>
          <select id="f-location" aria-describedby={form.locationKind === "teams" || form.locationKind === "zoom" ? "f-location-hint" : undefined} value={form.locationKind} onChange={(e) => set("locationKind")(e.target.value)} className={`h-11 ${fieldClasses(false)}`}>
            {LOCATIONS.map((l) => <option key={l.kind} value={l.kind}>{t(l.label)}</option>)}
          </select>
          {form.locationKind === "teams" && (
            <p id="f-location-hint" className="mt-1 text-sm text-text-muted">{t("eventTypes.teamsHint")}</p>
          )}
          {form.locationKind === "zoom" && <ZoomHint setup={zoomSetup} id="f-location-hint" />}
        </div>
        {valueLabel && (
          <div>
            <Label htmlFor="f-locationValue">{valueLabel}</Label>
            <Input id="f-locationValue" value={form.locationValue} onChange={(e) => set("locationValue")(e.target.value)} error={errors.locationValue} />
          </div>
        )}
        <div>
          <Label htmlFor="f-description">{t("eventTypes.description")}</Label>
          <textarea
            id="f-description" rows={4} value={form.description} onChange={(e) => set("description")(e.target.value)}
            aria-describedby="f-description-hint" className={`py-2 ${fieldClasses(false)}`}
          />
          <p id="f-description-hint" className="mt-1 text-sm text-text-muted">{t("eventTypes.descriptionHint")}</p>
        </div>
        <div>
          <Label htmlFor="f-redirectUrl">{t("eventTypes.redirect")}</Label>
          <Input
            id="f-redirectUrl" inputMode="url" value={form.redirectUrl ?? ""} onChange={(e) => set("redirectUrl")(e.target.value)} error={errors.redirectUrl}
            // i18n-ignore
            placeholder="https://yoursite.com/thank-you" aria-describedby="f-redirectUrl-hint"
          />
          <p id="f-redirectUrl-hint" className="mt-1 text-sm text-text-muted">{t("eventTypes.redirectHint")}</p>
        </div>
      </Panel>

      <Panel id="rules" active={tab}>
        {numberField("minNoticeMinutes", t("eventTypes.minNotice"), t("eventTypes.unitMinutes"), t("eventTypes.minNoticeHint"))}
        {numberField("bookingWindowDays", t("eventTypes.bookingWindow"), t("eventTypes.unitDays"), t("eventTypes.bookingWindowHint"))}
        <div>
          <Label htmlFor="f-startIncrementMinutes">{t("eventTypes.startIncrement")}</Label>
          <select
            id="f-startIncrementMinutes" value={form.startIncrementMinutes} onChange={(e) => set("startIncrementMinutes")(e.target.value)}
            aria-invalid={errors.startIncrementMinutes ? true : undefined}
            aria-describedby={errors.startIncrementMinutes ? "f-startIncrementMinutes-error" : undefined}
            className={`h-11 max-w-48 ${fieldClasses(Boolean(errors.startIncrementMinutes))}`}
          >
            {START_INCREMENTS.map((m) => <option key={m} value={String(m)}>{t("eventTypes.minutesOption", { n: m })}</option>)}
          </select>
          {errors.startIncrementMinutes && <p id="f-startIncrementMinutes-error" className="mt-1 text-sm text-danger">{errors.startIncrementMinutes}</p>}
        </div>
        {numberField("bufferBeforeMinutes", t("eventTypes.bufferBefore"), t("eventTypes.unitMinutes"), t("eventTypes.bufferBeforeHint"))}
        {numberField("bufferAfterMinutes", t("eventTypes.bufferAfter"), t("eventTypes.unitMinutes"), t("eventTypes.bufferAfterHint"))}
        {numberField("dailyLimit", t("eventTypes.dailyLimit"), t("eventTypes.unitBookings"), t("eventTypes.dailyLimitHint"))}
        {numberField("weeklyLimit", t("eventTypes.weeklyLimit"), t("eventTypes.unitBookings"), t("eventTypes.weeklyLimitHint"))}
        {numberField("cancelCutoffMinutes", t("eventTypes.cancelCutoff"), t("eventTypes.unitMinutesBefore"), t("eventTypes.cancelCutoffHint"))}
        <div>
          <Label htmlFor="f-cancelPolicy">{t("eventTypes.cancelPolicy")}</Label>
          <textarea
            id="f-cancelPolicy" rows={3} maxLength={1000} value={form.cancelPolicy ?? ""} onChange={(e) => set("cancelPolicy")(e.target.value)}
            aria-describedby="f-cancelPolicy-hint" aria-invalid={errors.cancelPolicy ? true : undefined} className={`py-2 ${fieldClasses(Boolean(errors.cancelPolicy))}`}
            placeholder={t("eventTypes.cancelPolicyPlaceholder")}
          />
          <p id="f-cancelPolicy-hint" className="mt-1 text-sm text-text-muted">{errors.cancelPolicy ?? t("eventTypes.cancelPolicyHint")}</p>
        </div>
        {numberField("maxRepeats", t("eventTypes.maxRepeats"), t("eventTypes.unitWeeksAtMost"), t("eventTypes.maxRepeatsHint"))}
        {numberField("seats", t("eventTypes.seats"), t("eventTypes.unitGuests"), t("eventTypes.seatsHint"))}
      </Panel>

      <Panel id="form" active={tab}>
        <p className="text-sm text-text-muted">{t("eventTypes.formIntro")}</p>
        {questions.length === 0 && <p className="text-text-muted">{t("eventTypes.noQuestions")}</p>}
        <ol className="grid gap-4">
          {questions.map((q, i) => {
            const e = questionErrors[i] ?? {};
            const name = q.label.trim() || t("eventTypes.questionN", { n: i + 1 });
            return (
              <li key={q.key}>
                <Card className="grid gap-3">
                  <div>
                    <Label htmlFor={`q-${q.key}-label`}>{t("eventTypes.questionN", { n: i + 1 })}</Label>
                    <Input id={`q-${q.key}-label`} value={q.label} onChange={(ev) => updateQuestion(i, { label: ev.target.value })} error={e.label} />
                  </div>
                  <div>
                    <Label htmlFor={`q-${q.key}-kind`}>{t("eventTypes.answerType")}</Label>
                    <select
                      id={`q-${q.key}-kind`} value={q.kind} onChange={(ev) => updateQuestion(i, { kind: ev.target.value as CustomQuestion["kind"] })}
                      className={`h-11 ${fieldClasses(false)}`}
                    >
                      {QUESTION_KINDS.map((k) => <option key={k.kind} value={k.kind}>{t(k.label)}</option>)}
                      {!QUESTION_KINDS.some((k) => k.kind === q.kind) && <option value={q.kind}>{q.kind.replace("_", " ")}</option>}
                    </select>
                  </div>
                  {q.kind === "single_select" && (
                    <div>
                      <Label htmlFor={`q-${q.key}-choices`}>{t("eventTypes.choices")}</Label>
                      <textarea
                        id={`q-${q.key}-choices`} rows={3} value={q.choices.join("\n")}
                        onChange={(ev) => updateQuestion(i, { choices: ev.target.value.split("\n") })}
                        aria-invalid={e.choices ? true : undefined} aria-describedby={e.choices ? `q-${q.key}-choices-error` : undefined}
                        className={`py-2 ${fieldClasses(Boolean(e.choices))}`}
                      />
                      {e.choices && <p id={`q-${q.key}-choices-error`} className="mt-1 text-sm text-danger">{e.choices}</p>}
                    </div>
                  )}
                  <label className="inline-flex min-h-11 items-center gap-2 text-sm text-text">
                    <input type="checkbox" checked={q.required} onChange={(ev) => updateQuestion(i, { required: ev.target.checked })} className={`size-5 accent-accent ${focusRing}`} />
                    {t("eventTypes.required")}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" disabled={i === 0} onClick={() => moveQuestion(i, -1)} aria-label={t("eventTypes.moveUpLabel", { name })}>{t("eventTypes.moveUp")}</Button>
                    <Button variant="secondary" size="sm" disabled={i === questions.length - 1} onClick={() => moveQuestion(i, 1)} aria-label={t("eventTypes.moveDownLabel", { name })}>{t("eventTypes.moveDown")}</Button>
                    <Button variant="ghost" size="sm" onClick={() => removeQuestion(i)} aria-label={t("eventTypes.removeLabel", { name })}>{t("common.remove")}</Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ol>
        <div><Button variant="secondary" onClick={addQuestion}>{t("eventTypes.addQuestion")}</Button></div>
      </Panel>

      <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-border pt-4">
        <Button onClick={save} loading={saving}>{id ? t("eventTypes.saveChanges") : t("eventTypes.create")}</Button>
        <p role="status" className={`text-sm ${status === "invalid" ? "text-danger" : "text-text-muted"}`}>
          {status === "saved" ? t("eventTypes.saved") : status === "invalid" ? t("eventTypes.invalid") : ""}
        </p>
      </div>

      {id && (
        <div className="mt-8 border-t border-border pt-4">
          {!confirmDelete ? (
            <Button variant="ghost" onClick={() => { setConfirmDelete(true); setDeleteError(null); }}>{t("eventTypes.delete")}</Button>
          ) : (
            <div className="grid gap-3">
              <p className="text-text">{t("eventTypes.deleteConfirm")}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" onClick={remove} loading={deleting}>{t("eventTypes.deleteYes")}</Button>
                <Button variant="secondary" onClick={() => { setConfirmDelete(false); setDeleteError(null); }}>{t("eventTypes.deleteKeep")}</Button>
              </div>
            </div>
          )}
          {deleteError && <p role="alert" className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">{deleteError}</p>}
        </div>
      )}
    </div>
  );
}

function Panel({ id, active, children }: { id: TabId; active: TabId; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={active !== id} className="mt-6 grid max-w-xl gap-5">
      {children}
    </div>
  );
}

function Choice({ name, checked, onChange, children }: { name: string; checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus ${checked ? "border-accent bg-surface font-semibold text-text" : "border-border-input bg-card text-text"}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="accent-accent" />
      {children}
    </label>
  );
}
