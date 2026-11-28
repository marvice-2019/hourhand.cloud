# B20: Digital products (sell a file or a private link, like Topmate)

## What it does

A host sells downloadable files, or a link shown only after purchase, from their own shop page. Guests buy free or through
Razorpay and get a private page with the download. Products start switched off.

## Host (Dashboard → Products)

- Up to 20 products: title, link name (`/<slug>/shop/<link name>`), description, price (₹0 = free, up to ₹1,00,000) and what
  buyers get: a **file** the host uploads, or a **link** (https only).
- **Files** are stored in Postgres like profile photos (single server; backups include them): up to 10 MB each and 50 MB per
  host. Allowed: PDF, EPUB, ZIP, PNG, JPG, MP3, DOCX, XLSX, PPTX, TXT, CSV. The content must match the extension (magic bytes
  for PDF, ZIP-based formats, PNG, JPG, MP3). Upload goes to `POST /api/product-files/<id>` (multipart, session host only,
  same-origin), never through a server action, so the 3 MB server-action limit stays.
- A product can be put on sale only once its file is uploaded or its link is set. A price needs a paid plan and an account that
  can take the money (the host's own Razorpay, or Hourhand's under B18), checked on the server.
- **Orders** (paid, refunding, refunded) with buyer, amount and download count. **Refund in full** on a paid order stops the
  download at once; the job runner refunds it on the account that took the money (receipt `p-<order id>`, existing refunds
  checked first, `reverse_all` when a Route transfer was made). Products can't be deleted (buyers keep their links); switch one
  off instead.

## Guests

1. `/<slug>/shop` lists the host's products on sale; `/<slug>/shop/<product>` has the buy form (name, email). Only for
   approved, open hosts. `shop` is now a reserved event-type slug.
2. Free: the order is paid at once. Paid: a Razorpay order on the collecting account (with B18's Route transfer on `split`),
   confirmed only after Razorpay shows the payment captured (signature, order, amount, currency; authorized payments are
   captured). The job runner settles a payment whose tab was closed and fails an unpaid order after a day.
3. The buyer's private page `/d/<token>` (48 random hex characters, not indexed) shows the download button or the link once
   paid. `GET /api/downloads/<token>` serves the file only for a paid order, as an attachment with `nosniff`, a sandboxing CSP
   and `no-store`, and counts it: 20 downloads per order, then 410.

Requests are rate limited per address and email (the booking limits). A repeat with the same idempotency key returns the same
order.

## Emails (notifications queue, dedupe `product:<order id>:<kind>`)

`product_receipt_buyer` (receipt with the `/d/` link), `product_sale_host` (host's language), `product_refund_buyer`. Each is
skipped at send time if the order's state no longer fits.

## Not built

Earnings page totals for product and question sales, discount codes on products, bundles, files over 10 MB (would need object
storage), and Stripe for products.
