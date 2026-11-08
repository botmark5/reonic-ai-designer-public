"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface Suggestion {
  text: string;
  main: string;
  secondary: string;
}

// Off for the whole page once the server says the Google key may not call Places (no dropdown, plain input).
let placesAvailable = true;

/**
 * Address input with suggestions (Google Places Autocomplete, Germany) from the first letter: towns, then streets.
 * Picking one calls onPick with the full address. Without the Places API it is a plain text input.
 */
export function AddressInput({
  value,
  onChange,
  onPick,
  className,
  listClassName,
  ...rest
}: Omit<React.ComponentProps<"input">, "value" | "onChange"> & {
  value: string;
  onChange: (v: string) => void;
  onPick?: (address: string) => void;
  listClassName?: string;
}) {
  const listId = useId();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const session = useRef<string | null>(null);
  const typed = useRef(false); // only fetch for what the user typed, not for a picked or prefilled value

  useEffect(() => {
    const q = value.trim();
    if (!typed.current || !placesAvailable || !q) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      session.current ??= crypto.randomUUID();
      fetch(`/api/places/autocomplete?q=${encodeURIComponent(q)}&s=${session.current}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { available: boolean; suggestions: Suggestion[] } | null) => {
          if (!j) return;
          if (!j.available) placesAvailable = false;
          setItems(j.available ? j.suggestions : []);
          setActive(-1);
          setOpen(j.available && j.suggestions.length > 0);
        })
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [value]);

  const pick = (s: Suggestion) => {
    typed.current = false;
    session.current = null; // a pick ends the billing session
    setOpen(false);
    onChange(s.text);
    onPick?.(s.text);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <input
        {...rest}
        value={value}
        onChange={(e) => {
          typed.current = true;
          onChange(e.target.value);
          if (!e.target.value.trim()) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (open && items.length) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % items.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
              return;
            }
            if (e.key === "Enter" && active >= 0) {
              e.preventDefault();
              pick(items[active]);
              return;
            }
            if (e.key === "Escape") {
              setOpen(false);
              return;
            }
          }
          rest.onKeyDown?.(e);
        }}
        onBlur={(e) => {
          setTimeout(() => setOpen(false), 120); // let a click on a suggestion land first
          rest.onBlur?.(e);
        }}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        className={className}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className={cn(
            "absolute top-full right-0 left-0 z-40 m-0 mt-1 max-h-72 list-none overflow-y-auto rounded-md border border-border bg-surface-1 p-1 shadow-lg",
            listClassName,
          )}
        >
          {items.map((s, i) => (
            <li
              key={s.text}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              className={cn("flex cursor-pointer flex-col rounded-sm px-3 py-2 text-left", i === active ? "bg-surface-2" : "hover:bg-surface-2/70")}
            >
              <span className="text-[14px] text-ink">{s.main}</span>
              {s.secondary && <span className="text-[12px] text-ink-muted">{s.secondary}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
