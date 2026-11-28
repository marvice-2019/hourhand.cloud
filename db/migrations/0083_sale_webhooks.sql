-- Outgoing webhooks for paid questions and digital products (B23): a host's automation (n8n, Zapier, a CRM) hears about
-- a new question, an answered one and a product sale, as it already does about bookings. Widens the event list only.
alter table webhook_endpoints drop constraint webhook_endpoints_events_check;
alter table webhook_endpoints add constraint webhook_endpoints_events_check check (cardinality(events) between 1 and 6
  and events <@ array['booking.created', 'booking.cancelled', 'booking.rescheduled', 'question.received', 'question.answered', 'product.sold']);
