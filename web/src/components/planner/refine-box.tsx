"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { DesignResponse, Home, Locks, RefineResponse } from "@/lib/types";
import { INSTALLER } from "./use-planner";

type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; label: string }
  | { type: "design" }
  | { type: "done"; summary: string; home: Home; locks: Locks; response: DesignResponse; by: string }
  | { type: "error"; message: string };

const EXAMPLES = ["They are buying an EV next year", "Customer wants no battery", "They want to be as independent as possible"];

/** Planner text → input changes → new design. The engine still decides every size. */
export function RefineBox({
  home,
  locks,
  onResult,
  onStart,
  onEnd,
  showExamples = true,
}: {
  home: Home;
  locks: Locks;
  onResult: (r: Pick<RefineResponse, "home" | "locks" | "design" | "summary">) => void;
  onStart?: () => void;
  onEnd?: () => void;
  showExamples?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState("");
  const [steps, setSteps] = useState<string[]>([]);

  async function submit(value = text) {
    const t = value.trim();
    if (!t || busy) return;
    setBusy(true);
    onStart?.();
    setReply("");
    setSteps([]);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t, home, locks, installer: INSTALLER }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "The designer could not read that.");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finished = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as AgentEvent;
          if (ev.type === "text") setReply((r) => r + ev.text);
          else if (ev.type === "tool") {
            setSteps((st) => [...st, ev.label]);
            setReply(""); // show only what Claude says after its last step
          }
          else if (ev.type === "error") throw new Error(ev.message);
          else if (ev.type === "done") {
            finished = true;
            onResult({ home: ev.home, locks: ev.locks, design: ev.response, summary: ev.summary });
            setReply(ev.summary);
          }
        }
      }
      if (!finished) throw new Error("The designer stopped before finishing.");
      setText("");
    } catch (e) {
      toast.error("Could not update the design", { description: (e as Error).message });
    } finally {
      setBusy(false);
      onEnd?.();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <form
        aria-label="Refine the design"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-center gap-2 rounded-pill border border-border-strong/60 bg-surface-1 py-1.5 pr-1.5 pl-4 transition-[border-color,box-shadow] focus-within:border-focus focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--focus),transparent_75%)]"
      >
        <Sparkles className="size-4 shrink-0 text-ai-orange" strokeWidth={1.5} aria-hidden />
        <label htmlFor="refine" className="sr-only">
          Tell the designer what changed
        </label>
        <input
          id="refine"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Tell the designer what changed, e.g. “they're buying an EV next year”"
          className="min-w-0 flex-1 bg-transparent text-body-sm text-ink outline-none placeholder:text-ink-muted"
          readOnly={busy}
          aria-busy={busy}
        />
        <Button type="submit" size="sm" disabled={busy || !text.trim()}>
          {busy ? "Updating…" : "Update design"}
        </Button>
      </form>
      {(busy || reply) && (
        <div className="flex flex-col gap-1 rounded-md bg-ai-tint/60 px-4 py-3 text-[13px] leading-5 text-ink-body" aria-live="polite">
          {steps.length > 0 && (
            <ol className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-[12px] text-ink-muted">
              {steps.map((st, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <span className="size-1 rounded-full bg-ai-orange" aria-hidden />
                  {st}
                </li>
              ))}
            </ol>
          )}
          {reply ? <p className="m-0">{reply}</p> : busy && <p className="m-0 text-ink-muted">Reading your note…</p>}
        </div>
      )}
      {showExamples && !text && !busy && !reply && (
        <div className="flex flex-wrap gap-1.5" aria-label="Examples">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => submit(ex)}
              className="cursor-pointer rounded-pill border border-border px-2.5 py-1 text-[12px] text-ink-body transition-colors hover:border-border-strong hover:text-ink"
            >
              {ex}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
