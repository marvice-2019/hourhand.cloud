# Hourhand API (v1, read-only)

For n8n, Zapier, Make, a CRM or a spreadsheet: read your own bookings and event types. Pair it with booking webhooks
(Integrations → Webhooks) to be told about changes as they happen, and use the API to catch up or look things up.

## Keys

Make a key on **Integrations → API keys**. It is shown once: copy it then. Up to 5 keys per account; give each tool
its own, so you can remove one without breaking the others. A key reads your whole account, so keep it private.

Send it on every request:

```
Authorization: Bearer hh_...
```

A missing, wrong or removed key gets `401 {"error":"invalid_key"}`. Each key can make 120 requests a minute; past that
you get `429 {"error":"rate_limited"}` with `retry-after: 60`.

Every answer is JSON with `cache-control: no-store`. Times are ISO 8601 in UTC.

## Endpoints

### `GET /api/v1/me`

```json
{ "id": "…", "name": "Priya Sharma", "slug": "priya", "timezone": "Asia/Kolkata", "booking_page": "https://hourhand.cloud/priya" }
```

### `GET /api/v1/event-types`

Your event types in the order you set, one-off meeting links left out.

```json
{ "data": [ { "id": "…", "name": "Coaching call", "slug": "coaching", "duration_minutes": 45, "active": true,
  "hidden": false, "price_minor": 150000, "currency": "INR", "booking_url": "https://hourhand.cloud/priya/coaching" } ] }
```

`price_minor` is in the currency's smallest unit (paise for INR); `null` for a free event type.

### `GET /api/v1/bookings`

Your bookings, oldest start first.

| Parameter | Meaning |
| --- | --- |
| `status` | `upcoming` (confirmed, not ended), `past` (confirmed, ended), `cancelled`, or `all` (default) |
| `from`, `to` | ISO times: bookings starting at or after `from` and before `to` |
| `limit` | 1 to 100, default 50 |
| `cursor` | `next_cursor` from the previous page |

```json
{ "data": [ {
    "booking": { "id": "…", "status": "confirmed", "start": "2026-12-01T04:30:00.000Z", "end": "2026-12-01T05:15:00.000Z",
                 "location": "zoom", "rescheduled_from": null, "created_at": "2026-11-27T10:02:11.000Z" },
    "event_type": { "id": "…", "name": "Coaching call", "slug": "coaching", "duration_minutes": 45 },
    "guest": { "name": "Meera Iyer", "email": "meera@example.com", "phone": null, "timezone": "Asia/Kolkata" }
  } ],
  "next_cursor": "…" }
```

Each booking has the same shape as a webhook's `data`. Answers to booking questions, private notes, manage links and
payment details are never sent. `guest.email` is `null` for a guest who booked without one.

When `next_cursor` is `null` you have everything. A parameter that can't be used gets
`400 {"error":"bad_request","param":"limit",…}`.

### `GET /api/v1/bookings/{id}`

One booking in the shape above, or `404 {"error":"not_found"}` (also for a booking that isn't yours).

## Example (curl)

```
curl -H "Authorization: Bearer $HOURHAND_KEY" "https://hourhand.cloud/api/v1/bookings?status=upcoming&limit=20"
```

## Question and product webhooks (B23)

Besides the three booking events, an endpoint can ask for these (Integrations → Webhooks). Each is sent once, signed the
same way, with the same `{ event, id, created_at, data }` envelope:

- `question.received`: a question was sent (free) or paid for. `data`: `question_id`, `guest_name`, `guest_email`,
  `question`, `price_minor` (paise), `currency`, `due_at`, `received_at`.
- `question.answered`: you answered it. `data`: `question_id`, `guest_name`, `guest_email`, `question`, `answer`,
  `answered_at`.
- `product.sold`: a digital product was bought (or taken free). `data`: `order_id`, `product_id`, `product_title`,
  `buyer_name`, `buyer_email`, `price_minor`, `currency`, `paid_at`.

Each is queued in the same transaction as the change, so nothing is sent for a change that didn't happen.

## Questions and product orders (B24)

- `GET /api/v1/questions`: your questions, oldest first. `status` is `all` (default) or one of `pending`, `open`,
  `answered`, `declined`, `failed`, `refund_pending`, `refunded`. Each item: `id`, `status`, `guest_name`, `guest_email`,
  `question`, `answer`, `price_minor`, `currency`, `due_at`, `answered_at`, `expired` (closed for missing its due date),
  `created_at`.
- `GET /api/v1/orders`: your digital product orders, oldest first. `status` is `all` or one of `pending`, `paid`,
  `failed`, `refund_pending`, `refunded`. Each item: `id`, `status`, `product_id`, `product_title`, `buyer_name`,
  `buyer_email`, `price_minor`, `currency`, `paid_at`, `downloads`, `created_at`. Download links are never returned.

Both take `limit` (1 to 100, default 50) and `cursor` (the previous page's `next_cursor`), like bookings.
