-- Multiple lengths on one event type: the guest picks e.g. 30, 45 or 60 minutes before seeing times.
-- duration_options (in the schema since 0001, unused until now) lists every length offered; empty means only
-- duration_minutes, exactly as before, so existing event types are unchanged. duration_prices lines up with it: each
-- length's own price in paise, null = the event type's price_minor.
alter table event_types add column duration_prices int[] not null default '{}';
alter table event_types add constraint event_types_duration_options_check check (
  cardinality(duration_options) = 0
  or (kind = 'one_on_one'
      and cardinality(duration_options) between 2 and 4
      and duration_minutes = any(duration_options)
      and 5 <= all(duration_options) and 720 >= all(duration_options)
      and cardinality(duration_prices) = cardinality(duration_options)));
-- A length's own price only on a priced event type, so the payment gate and the free paths stay as they are.
alter table event_types add constraint event_types_duration_prices_check check (
  (price_minor is not null or cardinality(array_remove(duration_prices, null)) = 0)
  and 100 <= all(array_remove(duration_prices, null)));
