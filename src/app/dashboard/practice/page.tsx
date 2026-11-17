import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { Input, Label } from "@/components/ui/Input";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { listMembers, pendingPracticeInvite, practiceContext, practitionerCount, practitionerLimit } from "@/lib/clinic/practices";
import { allowed } from "@/lib/clinic/roles";
import { getPool } from "@/lib/data/pg-store";
import { seatFor } from "@/lib/seats";
import { listServices, myServiceLinks } from "@/lib/clinic/services";
import {
  acceptPracticeAction, changeMemberAction, createPracticeAction, createServiceAction, deleteServiceAction, inviteMemberAction, leavePracticeAction,
  linkEventTypeAction, removeMemberAction, updatePracticeAction, updateServiceAction,
} from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  demo: "The demo copy can't set up a practice. Sign in with the database set up.",
  forbidden: "Only the practice's owner or an admin can do that.",
  not_live: "Your practice goes live once you're on the Clinic plan. Switch on the Plan page, then invite your practitioners.",
  invalid_name: "Enter the practice's name (up to 120 characters).",
  invalid_slug: "Use 3 to 40 lowercase letters, digits and hyphens for the page address.",
  slug_taken: "That page address is taken. Try another.",
  invalid_about: "Keep the about text to 2,000 characters.",
  invalid_email: "Enter a valid email address.",
  invalid_role: "Pick admin or practitioner.",
  taken: "That person is already in another practice.",
  already_in_practice: "That person is already in a practice (yours or another).",
  limit: "You've used every practitioner place your plan pays for. Add a place on the Plan page (up to 10), or take someone off the page first.",
  too_many: "You've sent 10 invitations today. Try again tomorrow.",
  not_found: "That person isn't in your practice.",
  owner_fixed: "The owner always stays an admin of their practice.",
};
const DONE: Record<string, string> = {
  created: "Practice set up.", saved: "Saved.", invited: "Invitation sent.", removed: "Removed.", joined: "You've joined the practice.", left: "You've left the practice.",
};

export default async function PracticePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireOwnAccount();
  const params = await searchParams;
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const ctx = db ? await practiceContext(db, user.id) : null;
  const message = params.error ? <p role="alert" className="mt-4 text-danger">{ERRORS[params.error] ?? "That didn't work."}</p>
    : params.done ? <p role="status" className="mt-4 text-success">{DONE[params.done] ?? "Done."}</p> : null;
  const base = (resolveBaseUrl() ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");

  if (!db || !ctx) {
    const [invite, seat] = db ? await Promise.all([pendingPracticeInvite(db, user), seatFor(db, user.id)]) : [null, null];
    return (
      <div>
        <h1 className="font-display text-xl text-text">Practice</h1>
        {message}
        {invite && (
          <Card className="mt-6 max-w-2xl">
            <h2 className="font-semibold text-text">{invite.practiceName} invited you</h2>
            <p className="mt-1 text-text-muted">
              {invite.role === "admin" ? "As an admin you'll manage practitioners and see the practice's bookings." : "You'll be listed on the practice's page with your own services."}{" "}
              Your account, calendars, hours and client notes stay yours.
            </p>
            <div className="mt-4 flex gap-2">
              <form action={acceptPracticeAction}><Button type="submit">Accept</Button></form>
              <form action={leavePracticeAction}><Button type="submit" variant="ghost">Decline</Button></form>
            </div>
          </Card>
        )}
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">Set up a practice</h2>
          <p className="mt-1 max-w-xl text-text-muted">
            For a clinic or institute with 3 to 10 practitioners. Each practitioner keeps their own account, calendars, hours, services and booking link.
            The practice gets one page listing everyone, and admins who manage practitioners and see every booking. Clients choose who they book.
            Your own bookings and settings stay as they are. The practice goes live once you&apos;re on the Clinic plan.
          </p>
          <form action={createPracticeAction} className="mt-4 grid max-w-md gap-3">
            <div><Label htmlFor="p-name">Practice name</Label><Input id="p-name" name="name" required maxLength={120} /></div>
            <div><Label htmlFor="p-slug">Page address</Label><Input id="p-slug" name="slug" required pattern="[a-z0-9][a-z0-9\-]{2,39}" placeholder="mindcare-clinic" aria-describedby="p-slug-hint" />
              <p id="p-slug-hint" className="mt-1 text-sm text-text-muted">{base}/your-address</p></div>
            <div><Label htmlFor="p-about">About (optional)</Label>
              <textarea id="p-about" name="about" maxLength={2000} rows={3} className={`mt-1 block w-full rounded-md border border-border-input bg-card p-3 text-base text-text ${focusRing}`} /></div>
            <label className="flex min-h-11 items-center gap-2 text-text"><input type="checkbox" name="ownerPractises" defaultChecked /> I see clients too (list me as a practitioner)</label>
            {seat?.accepted && (
              <fieldset className="grid gap-1">
                <legend className="text-sm font-semibold text-text">Bring {seat.memberName ?? seat.email} from your Duo plan as</legend>
                <label className="flex min-h-11 items-center gap-2 text-text"><input type="radio" name="bringSeat" value="practitioner" defaultChecked /> A practitioner</label>
                <label className="flex min-h-11 items-center gap-2 text-text"><input type="radio" name="bringSeat" value="admin" /> An admin (manages the practice, doesn&apos;t see clients)</label>
                <label className="flex min-h-11 items-center gap-2 text-text"><input type="radio" name="bringSeat" value="none" /> Don&apos;t bring them</label>
              </fieldset>
            )}
            <div><Button type="submit">Set up practice</Button></div>
          </form>
        </Card>
      </div>
    );
  }

  const { practice, role, live } = ctx;
  const [members, count, limit, services, links] = await Promise.all([
    listMembers(db, user.id), practitionerCount(db, practice.id), practitionerLimit(db, practice.id), listServices(db, practice.id), myServiceLinks(db, user.id)]);
  const me = members.find((m) => m.userId === user.id);
  const field = `mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`;
  const manage = allowed(role, "members.manage");
  const roleLabel = (r: string) => (r === "owner" ? "Owner" : r === "admin" ? "Admin" : "Practitioner");
  return (
    <div>
      <h1 className="font-display text-xl text-text">{practice.name}</h1>
      <p className="mt-1 text-text-muted">
        <Link className={`underline ${focusRing}`} href={`/${practice.slug}`}>{base}/{practice.slug}</Link> · You&apos;re {roleLabel(role).toLowerCase()} ·{" "}
        {live ? `${count} of ${limit} practitioner places used` : "Not live yet: switch to the Clinic plan to publish the page and invite practitioners."}
      </p>
      {message}
      {allowed(role, "bookings.view_all") && (
        <p className="mt-4"><Link className={`font-semibold text-accent underline ${focusRing}`} href="/dashboard/practice/bookings">See every practitioner&apos;s bookings</Link></p>
      )}

      <Card className="mt-6 max-w-3xl">
        <h2 className="font-semibold text-text">People</h2>
        <p className="mt-1 text-sm text-text-muted">Client notes stay with each practitioner. Admins see bookings, never notes.</p>
        <ul className="mt-4 divide-y divide-border">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="font-semibold text-text">{m.name ?? m.email}</p>
                <p className="text-sm text-text-muted">
                  {roleLabel(m.role)}{m.role !== "practitioner" && m.practises ? " · sees clients" : ""}
                  {!m.accepted ? " · invitation sent" : ""}{m.practises && !m.active ? " · off the page" : ""} · {m.email}
                </p>
              </div>
              {manage && (
                <div className="flex flex-wrap gap-2">
                  {m.role !== "owner" && (
                    <form action={changeMemberAction}>
                      <input type="hidden" name="memberId" value={m.id} />
                      <input type="hidden" name="role" value={m.role === "admin" ? "practitioner" : "admin"} />
                      <Button type="submit" variant="secondary" size="sm">Make {m.role === "admin" ? "practitioner" : "admin"}</Button>
                    </form>
                  )}
                  {m.role !== "practitioner" && (
                    <form action={changeMemberAction}>
                      <input type="hidden" name="memberId" value={m.id} />
                      <input type="hidden" name="practises" value={m.practises ? "false" : "true"} />
                      <Button type="submit" variant="secondary" size="sm">{m.practises ? "Doesn't see clients" : "Sees clients"}</Button>
                    </form>
                  )}
                  {m.practises && m.role !== "owner" && (
                    <form action={changeMemberAction}>
                      <input type="hidden" name="memberId" value={m.id} />
                      <input type="hidden" name="active" value={m.active ? "false" : "true"} />
                      <Button type="submit" variant="secondary" size="sm">{m.active ? "Take off the page" : "Put back on the page"}</Button>
                    </form>
                  )}
                  {m.role !== "owner" && (
                    <form action={removeMemberAction}>
                      <input type="hidden" name="memberId" value={m.id} />
                      <Button type="submit" variant="ghost" size="sm">Remove</Button>
                    </form>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {manage && live && (
          <form action={inviteMemberAction} className="mt-4 grid max-w-md gap-2">
            <Label htmlFor="invite-email">Invite by email</Label>
            <Input id="invite-email" name="email" type="email" autoComplete="off" required />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex min-h-11 items-center gap-2 text-text"><input type="radio" name="role" value="practitioner" defaultChecked /> Practitioner</label>
              <label className="flex min-h-11 items-center gap-2 text-text"><input type="radio" name="role" value="admin" /> Admin</label>
            </div>
            <div><Button type="submit">Send invitation</Button></div>
          </form>
        )}
      </Card>

      <Card className="mt-6 max-w-3xl">
        <h2 className="font-semibold text-text">Services</h2>
        <p className="mt-1 text-sm text-text-muted">
          The practice page lists each service with the practitioners who offer it. Clients waiting for a full day join one waitlist per service
          and hear about a freed time with any of those practitioners.
        </p>
        <ul className="mt-4 divide-y divide-border">
          {services.map((s) => (
            <li key={s.id} className="py-3">
              {allowed(role, "practice.edit") ? (
                <div className="flex flex-wrap items-end gap-2">
                  <form action={updateServiceAction} className="flex flex-1 flex-wrap items-end gap-2">
                    <input type="hidden" name="serviceId" value={s.id} />
                    <div className="min-w-48 flex-1"><Label htmlFor={`s-${s.id}`}>Name</Label><Input id={`s-${s.id}`} name="name" defaultValue={s.name} required maxLength={120} /></div>
                    <div className="min-w-48 flex-1"><Label htmlFor={`sd-${s.id}`}>Description</Label><Input id={`sd-${s.id}`} name="description" defaultValue={s.description ?? ""} maxLength={1000} /></div>
                    <Button type="submit" variant="secondary" size="sm">Save</Button>
                  </form>
                  <form action={deleteServiceAction}><input type="hidden" name="serviceId" value={s.id} /><Button type="submit" variant="ghost" size="sm">Delete</Button></form>
                </div>
              ) : <p className="text-text">{s.name}</p>}
            </li>
          ))}
        </ul>
        {allowed(role, "practice.edit") && (
          <form action={createServiceAction} className="mt-4 flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1"><Label htmlFor="new-service">New service</Label><Input id="new-service" name="name" required maxLength={120} placeholder="Individual therapy" /></div>
            <div className="min-w-48 flex-1"><Label htmlFor="new-service-d">Description (optional)</Label><Input id="new-service-d" name="description" maxLength={1000} /></div>
            <Button type="submit">Add</Button>
          </form>
        )}
        {me?.practises && services.length > 0 && links.length > 0 && (
          <div className="mt-6">
            <h3 className="font-semibold text-text">Your event types on the practice page</h3>
            <ul className="mt-2 grid gap-2">
              {links.map((l) => (
                <li key={l.eventTypeId}>
                  <form action={linkEventTypeAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="eventTypeId" value={l.eventTypeId} />
                    <div className="min-w-48 flex-1">
                      <Label htmlFor={`l-${l.eventTypeId}`}>{l.name}</Label>
                      <select id={`l-${l.eventTypeId}`} name="serviceId" defaultValue={l.serviceId ?? ""} className={field}>
                        <option value="">Not under a service</option>
                        {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                    <Button type="submit" variant="secondary" size="sm">Save</Button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {allowed(role, "practice.edit") && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">Practice page</h2>
          <form action={updatePracticeAction} className="mt-4 grid max-w-md gap-3">
            <div><Label htmlFor="e-name">Practice name</Label><Input id="e-name" name="name" required maxLength={120} defaultValue={practice.name} /></div>
            <div><Label htmlFor="e-slug">Page address</Label><Input id="e-slug" name="slug" required defaultValue={practice.slug} /></div>
            <div><Label htmlFor="e-about">About</Label>
              <textarea id="e-about" name="about" maxLength={2000} rows={4} defaultValue={practice.about ?? ""} className={`mt-1 block w-full rounded-md border border-border-input bg-card p-3 text-base text-text ${focusRing}`} /></div>
            <div><Button type="submit">Save</Button></div>
          </form>
        </Card>
      )}

      {role !== "owner" && (
        <form action={leavePracticeAction} className="mt-6">
          <Button type="submit" variant="ghost">Leave {practice.name}</Button>
        </form>
      )}
    </div>
  );
}
