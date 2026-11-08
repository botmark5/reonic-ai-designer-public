import { createCn } from "cn/config";

/**
 * Class merging that knows our design tokens (globals.css), so e.g. `text-label` (a font size) is not
 * dropped when combined with `text-ink-muted` (a colour), and `rounded-pill` overrides `rounded-lg`.
 * Always import cn from here, not from "cn".
 */
export const cn = createCn({
  extend: {
    theme: {
      text: ["display", "h1", "h2", "h3", "body", "body-sm", "label", "metric", "data"],
      radius: ["pill"],
      shadow: ["card", "pop"],
    },
  },
});
