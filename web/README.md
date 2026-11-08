# web: Reonic AI Designer (Next.js)

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # vitest (mock engine logic)
npm run build
```

## Env (web/.env.local, never committed)
| var | where | what |
|---|---|---|
| `ENGINE_URL` | server only | Python engine base URL (engine/README.md) |
| `ENGINE_API_KEY` (or `ENGINE_KEY`) | server only | sent as `X-Engine-Key`; never reaches the browser |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser | read-only + realtime (RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | all writes |
| `ANTHROPIC_API_KEY` | server only | /api/agent (refine agent) |

## Shared files (sessions C and D import these; owner: session B)
- `src/lib/types.ts`: engine types matching docs/api.md (+ optional engine extras)
- `src/lib/engine.ts` (**server only**): `engine.design / validate / refine / explain / eval / project`, `engineHealth()`.
  Falls back to the offline estimate (`src/lib/engine-mock.ts`) when `ENGINE_URL` is unset, the engine errors, or it does
  not answer in time (design/validate/eval 4 s, project 8 s, refine 10 s, explain 8 s to first byte); after an outage the
  engine is skipped for 15 s. Every response carries `served: { source: "engine" | "offline", reason?, ms }`;
  render `<ServedBadge served={…} />` (components/ui/served-badge.tsx) next to engine numbers.
- **Browser code calls the routes, not the engine:** `POST /api/engine/{design,validate,refine,explain}`,
  `GET /api/engine/eval`, `GET /api/engine/project/:id`. Quick check: `GET /api/engine/health` (engine /health + one /design).
- `src/lib/supabase.ts`: `getBrowserSupabase()` (anon, read + realtime), `getServerSupabase()` (service role, server only), row types
- `../supabase/schema.sql`: tables calls, designs, overrides, shares; RLS; realtime on calls + designs

## Theme
`src/app/globals.css` maps docs/design/tokens.json to Tailwind v4: token names as utilities (`bg-surface-1`, `text-ink-muted`,
`bg-comp-pv`, `text-ai-text`, `bg-ai` gradient, `text-metric`, `text-label`, `rounded-pill`, `shadow-pop`) and shadcn's
semantic names mapped onto them. Dark mode = `.dark` class (next-themes, follows the system).
