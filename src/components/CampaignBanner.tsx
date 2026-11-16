/** A host's dated offer, shown at the top of their booking pages while it runs. The text is the host's own. */
export function CampaignBanner({ name, banner }: { name: string; banner: string }) {
  return (
    <aside aria-label={name} className="my-3 max-w-xl rounded-md border border-accent bg-surface p-3">
      <p className="font-semibold text-text">{name}</p>
      <p className="text-sm text-text">{banner}</p>
    </aside>
  );
}
