import { PixelIcon } from "@/components/ui/PixelIcon";

const EXAMPLES = ["Show me the Fengyun-1C debris cloud", "How much Chinese debris from 2007 is still up?", "What is the Kessler syndrome?"];

export function ChatPanel() {
  return (
    <div aria-label="AI analyst">
      <div className="label flex items-center gap-2"><PixelIcon name="chat" /> ANALYST</div>
      <p className="mt-2 text-sm text-ink-2">An AI analyst that answers from the real catalog and moves the globe is coming soon.</p>
      <ul className="mt-3 flex flex-col gap-2">
        {EXAMPLES.map((e) => (
          <li key={e} className="rounded-[10px] border-2 border-dashed border-line px-3 py-2 text-[13px] text-ink-3">{e}</li>
        ))}
      </ul>
    </div>
  );
}
