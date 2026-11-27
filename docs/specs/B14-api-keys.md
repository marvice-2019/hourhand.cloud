# B14: API keys and a read API for bookings

Calendly (API v2 with personal access tokens), Cal.com (API keys), Zoho Bookings and TidyCal give hosts an API.
Hourhand pushes booking changes out by webhook (PR 66) but has no way to ask for data: an n8n flow, Zapier step, CRM
sync or spreadsheet can't list a host's bookings or event types, or catch up after missing a webhook. This adds
personal API keys and a small read-only API.

## Host
- Integrations gets an "API keys" card under Webhooks: what the API is for, the host's keys (name, the key's first
  characters, created, last used) and a form to make one (a name, up to 60 characters).
- A new key is shown once, right after it's made, with "Copy it now: it won't be shown again." Only its hash is kept.
- Remove deletes a key at once; anything using it stops working.
- At most 5 keys per account. Only the account owner sees the card: a Duo second person managing someone's account
  doesn't, since a key reads the whole account.
- No plan limit: every plan has the API. No plan or price changes.

## Keys
- Format `hh_` and 43 random base64url characters (32 bytes). Stored as SHA-256 of the whole key, plus its first 7
  characters (`hh_` and 4) to tell keys apart. A key is never logged, and is never shown again.
- Sent as `Authorization: Bearer <key>`. A missing, malformed, removed or unknown key gets 401 `invalid_key`, all the
  same. `last_used_at` is updated at most once a minute per key.
- 120 requests a minute per key, then 429 `rate_limited` with `retry-after`.

## API (read-only, JSON, `cache-control: no-store`)
- `GET /api/v1/me`: `{ id, name, slug, timezone, booking_page }`.
- `GET /api/v1/event-types`: the host's event types (one-off meetings left out): id, name, slug, duration_minutes,
  active, hidden, price_minor, currency, booking_url.
- `GET /api/v1/bookings`: the host's bookings, oldest start first, each in the same shape as a webhook's `data`
  (booking, event_type, guest), so one n8n flow can read both.
  - `status`: `upcoming` (confirmed, not ended), `past` (confirmed, ended), `cancelled`, `all` (default, every status).
  - `from`, `to`: ISO times; bookings starting at or after `from` and before `to`.
  - `limit` 1 to 100 (default 50); `next_cursor` in the answer, passed back as `cursor`, gives the next page.
  - A bad parameter gets 400 `bad_request` naming it.
- `GET /api/v1/bookings/{id}`: one booking, or 404 `not_found` (also for another host's booking).
- No booking answers, private notes, manage links or payment details: the same fields a webhook sends.
- Documented in docs/api.md.

## Data (migration 0077)
- `api_keys`: id, user_id (cascade), name (1 to 60), prefix, key_hash (bytea, unique), last_used_at, created_at.

## Tests
- Keys: made, listed without the secret, found by the whole key only, removed; 5 at most; a name is required;
  another host can't remove one; last_used_at updated, then not again within a minute.
- API: 401 for no key, a bad key, a removed key; 429 after the limit; each endpoint's fields; bookings filters,
  paging with a cursor across pages, 400 for bad parameters; another host's booking is 404; same booking shape as the
  webhook payload.
