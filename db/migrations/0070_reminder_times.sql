-- Reminder times chosen by the host, per event type (Calendly, Cal.com and Zoho Bookings workflows). Minutes before the
-- start; at most 3, each one of the editor's choices. The default is the two reminders every booking got until now
-- (a day and an hour before), so nothing changes for existing event types. An empty list sends no reminders.
alter table event_types add column reminder_minutes int[] not null default '{1440,60}'
  check (cardinality(reminder_minutes) <= 3 and reminder_minutes <@ array[15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080]);
