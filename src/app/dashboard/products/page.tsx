import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { Input, Label } from "@/components/ui/Input";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { listOrders, listProducts, MAX_DOWNLOADS, MAX_PRODUCTS, type Order, type OrderStatus, type Product } from "@/lib/products/products";
import { refundAction, saveProductAction } from "./actions";

export const dynamic = "force-dynamic";

const RESULTS: Record<string, [HostKey, boolean]> = {
  saved: ["products.rSaved", true], fileSaved: ["products.rFileSaved", true], refunding: ["products.rRefunding", true],
  invalid_slug: ["products.rSlug", false], invalid_title: ["products.rTitle", false], invalid_description: ["products.rDescription", false],
  invalid_price: ["products.rPrice", false], invalid_delivery: ["products.rDelivery", false], invalid_linkUrl: ["products.rLink", false],
  invalid_active: ["products.rActive", false], invalid_limit: ["products.rLimit", false], invalid_id: ["products.rNotFound", false],
  not_found: ["products.rNotFound", false], notFound: ["products.rNotFound", false], not_refundable: ["products.rNotRefundable", false],
  tooBig: ["products.rTooBig", false], badType: ["products.rBadType", false], hostFull: ["products.rHostFull", false],
  noFile: ["products.rNoFile", false], demo: ["products.rDemo", false],
};

const STATUS: Record<OrderStatus, HostKey> = {
  pending: "products.sPending", paid: "products.sPaid", failed: "products.sFailed", refund_pending: "products.sRefundPending", refunded: "products.sRefunded",
};

const field = `mt-1 block w-full rounded-md border border-border-input bg-card px-3 py-2 text-base text-text ${focusRing}`;

/** Digital products (B20): the host's products, their files, and the orders guests placed. */
export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const user = await requireHost();
  const { result } = await searchParams;
  const { t, date, money } = await getHostI18n();
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [products, orders] = pool ? await Promise.all([listProducts(pool, user.id), listOrders(pool, user.id)]) : [[] as Product[], [] as Order[]];
  const message = result ? RESULTS[result] : undefined;

  const form = (p: Product | null) => {
    const k = p?.id ?? "new";
    return (
      <form action={saveProductAction} className="grid gap-4">
        {p && <input type="hidden" name="id" value={p.id} />}
        <div><Label htmlFor={`title-${k}`}>{t("products.titleLabel")}</Label>
          <Input id={`title-${k}`} name="title" required maxLength={120} defaultValue={p?.title ?? ""} /></div>
        <div><Label htmlFor={`slug-${k}`}>{t("products.slugLabel")}</Label>
          <Input id={`slug-${k}`} name="slug" required maxLength={60} pattern="[a-z0-9\-]+" defaultValue={p?.slug ?? ""} className="w-64" /></div>
        <div><Label htmlFor={`description-${k}`}>{t("products.descriptionLabel")}</Label>
          <textarea id={`description-${k}`} name="description" maxLength={2000} rows={3} defaultValue={p?.description ?? ""} className={field} /></div>
        <div><Label htmlFor={`price-${k}`}>{t("products.price")}</Label>
          <Input id={`price-${k}`} name="price" inputMode="decimal" defaultValue={String((p?.priceMinor ?? 0) / 100)} className="w-40" /></div>
        <fieldset>
          <legend className="text-sm font-medium text-text">{t("products.delivery")}</legend>
          <label className="mt-1 flex items-center gap-2 text-text">
            <input type="radio" name="delivery" value="file" defaultChecked={(p?.delivery ?? "file") === "file"} className={focusRing} /> {t("products.deliveryFile")}
          </label>
          <label className="mt-1 flex items-center gap-2 text-text">
            <input type="radio" name="delivery" value="link" defaultChecked={p?.delivery === "link"} className={focusRing} /> {t("products.deliveryLink")}
          </label>
        </fieldset>
        <div><Label htmlFor={`link-${k}`}>{t("products.linkLabel")}</Label>
          <Input id={`link-${k}`} name="linkUrl" type="url" maxLength={500} defaultValue={p?.linkUrl ?? ""} /></div>
        <label className="flex items-center gap-2 text-text">
          <input type="checkbox" name="active" defaultChecked={p?.active ?? false} className={focusRing} /> {t("products.active")}
        </label>
        <div><Button type="submit" size="sm">{p ? t("products.save") : t("products.create")}</Button></div>
      </form>
    );
  };

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-xl text-text">{t("products.title")}</h1>
      <p className="mt-1 text-text-muted">{t("products.intro")}</p>
      {message && <p role={message[1] ? "status" : "alert"} className={`mt-4 text-sm ${message[1] ? "text-success" : "text-danger"}`}>{t(message[0], { n: MAX_PRODUCTS })}</p>}
      {products.some((p) => p.active) && (
        <p className="mt-4 text-text">{t("products.yourShop")} <Link href={`/${user.slug}/shop`} className={`text-accent underline ${focusRing}`}>{t("products.shopUrl", { slug: user.slug })}</Link></p>
      )}

      <ul className="mt-6 grid gap-4">
        {products.map((p) => (
          <li key={p.id} id={`p-${p.id}`}>
            <Card>
              <h2 className="mb-1 font-semibold text-text">{p.title}</h2>
              <p className="mb-3 text-sm text-text-muted">
                {p.active ? t("products.live") : t("products.off")} · {p.priceMinor > 0 ? money(p.priceMinor, "INR") : t("products.free")}
              </p>
              {form(p)}
              {p.delivery === "file" && (
                <form action={`/api/product-files/${p.id}`} method="post" encType="multipart/form-data" className="mt-4 grid gap-2 border-t border-border pt-4">
                  <p className="text-sm text-text">{p.file ? t("products.fileNow", { name: p.file.filename, size: Math.max(1, Math.round(p.file.sizeBytes / 1024)) }) : t("products.noFile")}</p>
                  <Label htmlFor={`file-${p.id}`}>{p.file ? t("products.replaceFile") : t("products.uploadFile")}</Label>
                  <input id={`file-${p.id}`} type="file" name="file" required accept=".pdf,.epub,.zip,.png,.jpg,.jpeg,.mp3,.docx,.xlsx,.pptx,.txt,.csv" className={`text-sm text-text ${focusRing}`} />
                  <p className="text-xs text-text-muted">{t("products.fileHelp")}</p>
                  <div><Button type="submit" size="sm" variant="secondary">{t("products.upload")}</Button></div>
                </form>
              )}
            </Card>
          </li>
        ))}
      </ul>

      {products.length < MAX_PRODUCTS && (
        <Card className="mt-6">
          <h2 className="mb-3 font-semibold text-text">{t("products.new")}</h2>
          {form(null)}
        </Card>
      )}

      <h2 id="orders" className="mt-8 font-semibold text-text">{t("products.orders")}</h2>
      {orders.length === 0 && <p className="mt-2 text-text-muted">{t("products.noOrders")}</p>}
      <ul className="mt-3 grid gap-3">
        {orders.map((o) => (
          <li key={o.id}>
            <Card>
              <p className="text-sm text-text-muted">{t("products.orderMeta", { name: o.buyerName, email: o.buyerEmail, date: date(o.createdAt, user.timezone) })}</p>
              <p className="mt-1 text-text">{o.productTitle} · {o.priceMinor > 0 ? money(o.priceMinor, "INR") : t("products.free")} · {t(STATUS[o.status])}</p>
              <p className="mt-1 text-xs text-text-muted">{t("products.downloads", { n: o.downloadCount, max: MAX_DOWNLOADS })}</p>
              {o.status === "paid" && o.priceMinor > 0 && (
                <form action={refundAction} className="mt-2">
                  <input type="hidden" name="id" value={o.id} />
                  <Button type="submit" size="sm" variant="secondary">{t("products.refund")}</Button>
                </form>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
