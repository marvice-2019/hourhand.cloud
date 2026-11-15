-- Roadmap 3.9 (C): the Clinic practice's one payment account.
--
-- A practitioner in a live practice takes payment through the practice owner's Razorpay account, not their own. Each
-- payment records whose account collected it (collected_by), fixed when the payment is created, so confirming or
-- refunding it later always goes to the right account even if the practitioner has since left the practice.

-- The account that collects for a host right now: the practice owner while the host is an accepted, practising,
-- active member of a live practice; otherwise the host themselves.
create function clinic_payment_account(host uuid) returns uuid language sql stable as $$
  select coalesce((
    select p.owner_id from practice_members m join practices p on p.id = m.practice_id
    where m.user_id = host and m.accepted_at is not null and m.practises and m.active and practice_is_live(p.id)), host)
$$;

alter table payments add column collected_by uuid references users(id) on delete set null;
update payments set collected_by = host_id where collected_by is null;

create function payments_collected_by() returns trigger language plpgsql as $$
begin
  if new.collected_by is null then
    new.collected_by := case when new.provider = 'razorpay' then clinic_payment_account(new.host_id) else new.host_id end;
  end if;
  return new;
end $$;
create trigger payments_collected_by before insert on payments for each row execute function payments_collected_by();
create index payments_collected_by_idx on payments (collected_by) where collected_by is distinct from host_id;
