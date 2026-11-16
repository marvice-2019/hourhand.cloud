-- Roadmap 1.2: booking texts by SMS (MSG91 first, through India's DLT). A guest ticks "text me" next to an Indian mobile
-- number; the manage page can turn it off again. Sends go through the notifications outbox with channel 'sms'
-- (allowed by the channel check since 0001). WhatsApp is preferred when the guest ticked both: SMS is the fallback.
alter table invitees add column sms_opt_in_at timestamptz;
-- The short code in each text's link (/m/<code> opens the manage page). DLT caps a template variable at 30 characters,
-- which the 48-character manage token doesn't fit. Made when the first text is sent.
alter table invitees add column sms_code text unique;
-- Numbers that must get no more texts from Hourhand, for every host: the operator reported them as on the DND/opt-out
-- list (a DLT preference block), or an owner added one by hand.
create table sms_opt_outs (
  phone text primary key,                      -- digits with country code (91XXXXXXXXXX)
  source text not null,                        -- 'dlt' (from a delivery report) or 'manual'
  opted_out_at timestamptz not null default now()
);
-- When the operator confirmed delivery (SMS delivery reports). Other channels leave it empty.
alter table notifications add column delivered_at timestamptz;
