-- 2.4: Zoom links. A host connects their own Zoom account (an `integrations` row with provider 'zoom', which 0001
-- already allows); each Zoom booking gets its own meeting, created by the job queue on the new 'video' channel.

-- Who connected (public_id holds the Zoom user id, which the deauthorization webhook names), and the one alert per
-- outage, as calendar_connections has.
alter table integrations add column account_email text;
alter table integrations add column granted_scopes text;
alter table integrations add column last_error text;
alter table integrations add column alert_sent_at timestamptz;
create index integrations_provider_public_id_idx on integrations (provider, public_id);

-- The Zoom meeting behind a booking's join_url, so a reschedule moves it and a cancel deletes it. Seats of one group
-- class share a meeting; a move carries it over to the new booking.
alter table bookings add column zoom_meeting_id text;

alter table notifications drop constraint notifications_channel_check;
alter table notifications add constraint notifications_channel_check check (channel in ('email','whatsapp','sms','calendar','payment','video'));
