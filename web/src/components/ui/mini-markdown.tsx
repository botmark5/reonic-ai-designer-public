import { Fragment } from "react";

/** Inline **bold** only. Text stays text (no HTML injection). */
function inline(s: string) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="font-semibold text-ink">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <Fragment key={i}>{part.replace(/\*\*/g, "")}</Fragment>
    ),
  );
}

/** Renders the small markdown subset Claude streams: paragraphs, "-"/"•"/"1." lists, "#" headings, **bold**. */
export function MiniMarkdown({ text, className }: { text: string; className?: string }) {
  const blocks: { type: "p" | "ul" | "h"; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const item = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    const head = line.match(/^#{1,4}\s+(.*)$/);
    const last = blocks[blocks.length - 1];
    if (!line.trim()) blocks.push({ type: "p", lines: [] });
    else if (head) blocks.push({ type: "h", lines: [head[1]] });
    else if (item) {
      if (last?.type === "ul") last.lines.push(item[1]);
      else blocks.push({ type: "ul", lines: [item[1]] });
    } else if (last?.type === "p") last.lines.push(line);
    else blocks.push({ type: "p", lines: [line] });
  }
  return (
    <div className={className}>
      {blocks
        .filter((b) => b.lines.length)
        .map((b, i) =>
          b.type === "ul" ? (
            <ul key={i} className="my-1.5 flex list-disc flex-col gap-1 pl-[18px] marker:text-ink-muted">
              {b.lines.map((l, j) => (
                <li key={j}>{inline(l)}</li>
              ))}
            </ul>
          ) : b.type === "h" ? (
            <p key={i} className="mt-2 mb-1 font-semibold text-ink first:mt-0">
              {inline(b.lines[0])}
            </p>
          ) : (
            <p key={i} className="my-1.5 first:mt-0 last:mb-0">
              {inline(b.lines.join(" "))}
            </p>
          ),
        )}
    </div>
  );
}
