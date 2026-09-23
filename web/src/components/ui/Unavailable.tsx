export function Unavailable({ what }: { what: string }) {
  return <p className="text-sm text-ink-2" role="status">Data unavailable: {what}.</p>;
}
