# Voice agent (ElevenLabs)

- Agent: "Reonic AI Designer - Site Visit Agent", id `<your ElevenLabs agent id>` (Mark's ElevenLabs workspace)
- Editor: (ElevenLabs dashboard → Agents)
- Test call (browser/phone): (ElevenLabs dashboard → Agents)
- Language: English (German preset can be added later). Voice: default for now; planned "Dylan" (KxR7w7QY9Rc4gig86VPG)
  once added to the workspace from the Voice Library.
- Behaviour: collects 8 fact groups, never invents values, reads a summary back, confirms, says the draft will be in the inbox.

## Data collection (post-call analysis fields)
customer_name, address, annual_kwh, monthly_bill_eur, household, daytime_presence, has_ev, ev_km_year,
heating [gas|oil|heatpump|electric|district|wood|other|unknown], heating_age_years,
roof_type [concrete_tile|clay_tile|flat|metal|slate|other|unknown],
roof_direction [south|south_east|south_west|east_west|east|west|north|unknown],
has_existing_pv [yes|no|unknown → home.has_existing_pv true/false/null], existing_pv_kwp, existing_battery_kwh, wishes, facts_confirmed.
Evaluation criterion: facts_complete.

## Prompt: question order (hand this to HQ chat for the agent's system prompt)
Ask early, right after name and address, because it is the engine's strongest input:
> "Is there already solar on your roof? If yes, roughly how many kWp?"

Send `has_existing_pv` = yes / no / unknown and `existing_pv_kwp` only if the caller gave a number (never guess).
Then: yearly use in kWh, or the monthly bill, or the number of people · EV now or planned (and km per year, if known) ·
heating and its age · roof type and direction · wishes. Read the summary back, confirm, call `create_design`, then
say its `instruction`.
What the backend fills in when a fact is missing (stated in the design's assumptions): EV without km → 15,000 km/year;
no use and no bill → household-size estimate, else 4,000 kWh.
`household` may be a number or words ("family of four", "zu zweit", "couple with two kids" → 4; capped at 20).
`daytime_presence` (someone home during the day) only changes the engine load profile for one-person homes
(home → `HomeOfficeOnePerson`, out → `FullTimeOnePerson`); for larger households it stays in the call's facts (profile `H0`). A stated use or bill is sent as real demand
(`demand_is_default: false`).

## Connecting the agent (APP_URL = the production deployment; the URL itself lives in env/.status, not in git)
1. Server tool `create_design` → POST `<APP_URL>/api/voice/create-design` with header `x-agent-token: {ELEVENLABS_TOOL_SECRET}`,
   params = the fields above (description: "never assume values; only send what the caller said"), response
   `{ instruction: "Tell the caller: …" }`. The prompt's closing step: "call create_design, then read its instruction".
2. Post-call webhook (workspace settings) → POST `<APP_URL>/api/voice/post-call`, HMAC secret = ELEVENLABS_WEBHOOK_SECRET.
3. While developing locally, a cloudflared tunnel can stand in for APP_URL (see the end of this file).
See docs/rosi-notes.md for the pitfalls (raw-body HMAC, null → '', defaults for dynamic variables).

## Tool config: `update_facts` (HQ attaches it; no new env var)
- Type: webhook / server tool · Method `POST` · URL `<APP_URL>/api/voice/update-facts` · response timeout 5 s.
- Header: `x-agent-token` = secret `ELEVENLABS_TOOL_SECRET` (the same secret as `create_design`).
- Description: "Save the caller's answer right after they give it, silently, without telling the caller. Send
  conversation_id and ONLY the fields the caller just stated or corrected. Never guess or fill in values."
- Prompt line: "After each answer, call update_facts with just that answer, then continue the conversation."
- Body parameters (all optional except `conversation_id`; the same descriptions as `create_design`):
```json
{
  "type": "object",
  "required": ["conversation_id"],
  "properties": {
    "conversation_id": { "type": "string", "description": "Dynamic variable system__conversation_id" },
    "customer_name": { "type": "string" },
    "address": { "type": "string", "description": "Street, number, postcode, town" },
    "annual_kwh": { "type": "number", "description": "Yearly electricity use in kWh, if the caller knows it" },
    "monthly_bill_eur": { "type": "number", "description": "Monthly electricity bill in euros" },
    "household": { "type": "string", "description": "People living there, as said: a number or words like 'family of four'" },
    "daytime_presence": { "type": "string", "description": "Is someone home during the day? yes / no / as said" },
    "has_ev": { "type": "string", "enum": ["yes", "no", "planned", "unknown"] },
    "ev_km_year": { "type": "number", "description": "Kilometres per year, only if stated" },
    "heating": { "type": "string", "enum": ["gas", "oil", "heatpump", "electric", "district", "wood", "other", "unknown"] },
    "heating_age_years": { "type": "number" },
    "roof_type": { "type": "string", "enum": ["concrete_tile", "clay_tile", "flat", "metal", "slate", "other", "unknown"] },
    "roof_direction": { "type": "string", "enum": ["south", "south_east", "south_west", "east_west", "east", "west", "north", "unknown"] },
    "has_existing_pv": { "type": "string", "enum": ["yes", "no", "unknown"] },
    "existing_pv_kwp": { "type": "number", "description": "Size of existing solar in kWp, only if stated" },
    "existing_battery_kwh": { "type": "number" },
    "wishes": { "type": "string" }
  }
}
```
Note: "planned" for `has_ev` counts as yes (an EV next year needs the wallbox now).

## Endpoints (session D, `web/src/app/api/{voice,solar}`, logic in `web/src/lib/{voice,solar}.ts`)
| Endpoint | Auth | What it does |
|---|---|---|
| `POST /api/voice/create-design` | `x-agent-token` (or `Authorization: Bearer`) = `ELEVENLABS_TOOL_SECRET` | Normalises the facts (bill → kWh at 0.35 €/kWh, household-size estimate, heating/roof vocab), fills a missing roof orientation/tilt from Google Solar (≤ 0.9 s), calls the engine (budget 2.5 s), writes `calls` (status `live`, in parallel with the engine) + ONE `designs` row per call (source `voice`, status `draft`; a second tool call updates it while it is still a draft), returns `{ instruction, call_id, design_id, pending }`. Engine slow or down → `pending: true`, "in the inbox in a minute"; after the response it waits up to 10 s for the slow answer, else retries once after the engine client's 15 s cool-down. Never stores the engine client's offline estimate as a voice draft. |
| `POST /api/voice/update-facts` | `x-agent-token` (or Bearer) = `ELEVENLABS_TOOL_SECRET` (same as create-design) | Agent tool called after EACH answer during the call. Body: `conversation_id` + only the fields just stated or corrected. Merges into `calls.facts.stated` (empty/unknown never erases; corrections overwrite; idempotent), re-normalises, and writes the same `calls.facts` shape as create-design (home fields + `voice` + `assumptions`) plus `stated`, `updated_fields`, `facts_updated_at`; status `live`. A new address triggers a Google roof lookup after the answer (fills `orientation_deg` / `tilt_deg`, `solar`). Answers `{ ok, call_id, updated }` in ~0.2-0.5 s. create-design later fills any field the agent did not repeat from these stored answers. |
| `POST /api/voice/post-call` | `ElevenLabs-Signature` HMAC on the raw body, `ELEVENLABS_WEBHOOK_SECRET`, ±30 min | `post_call_transcription` → transcript, summary, data-collection values and evaluation results onto the same `calls` row (by `conversation_id`), status `ended`/`failed`. If the agent never called the tool and use/bill/household is known, drafts the design then. Other webhook types → `{ ignored: true }`. |
| `GET /api/solar?address=…` | none (server key); 20/min per client | `{ status: ok, lat, lng, segments[{pitch_deg, azimuth_deg, area_m2}], max_panels, panel_watts, sunshine_hours_year, imagery_quality }` or `{ status: not_covered | not_found | no_key | error, reason }`. Roof = the most south-facing face with ≥ 70 % of the largest face's area. Cached 24 h (errors are not cached). |
| `GET /api/solar/panels?lat=&lng=&kwp=` (or `address=&kwp=`) | none (server key); 20/min per client | Panel placement for the 3D house: Google's panels best-first, N = round(kWp / 0.45), capped at what fits (`capped`). Returns `center`, `building_bbox`, `panel_size`, `panels[{lat, lng, x_m, y_m, orientation, segment_index, yearly_kwh}]` (x/y = metres east/north of the centre) and `segments[{index, pitch_deg, azimuth_deg, area_m2, plane_height_m (above sea level), plane_height_rel_m (above the lowest segment), center, bbox, panel_count}]`. buildingInsights cached 24 h per building, so kWp changes are free. Failures: `{status: not_covered | not_found | no_key | error, reason}`. |
| `GET /api/solar/layers?lat=&lng=` | none (server key); 10/min per client | Sun-map overlay: Google dataLayers (annual flux + roof mask, 30 m radius, 0.5 m pixels) → `image` (PNG data URL, cool → warm in the app palette, transparent off the roof), `width`, `height`, `pixel_size_m`, `bounds` (sw/ne lat/lng), `local` {`center`, `width_m`, `height_m`, `rotation_deg` (UTM grid vs true north, ~2° in Munich), `corners` nw/ne/se/sw} in metres east/north of `origin` (pass `/api/solar/panels`' `center`), `flux` {min, max} kWh/kW/year for the legend. Cached 30 days in memory plus `s-maxage` on the CDN; concurrent requests share one Google round trip. |
| `POST /api/intake` (page `/intake`) | planner passcode (gated like the planner) | `{ answers }` with the same field names as `update_facts` → `{ facts, home, assumptions, ready, design, design_error?, solar }`. The typed twin of the call: the same normaliseFacts and Google roof as `create_design`, so the same answers give the same engine home. Drafts only once use, bill or household is known. Stores nothing; the page saves the finished draft via `POST /api/designs` (source `voice`, no calls row, so `/live` never shows a typed intake as a call). |
| `factsFromForm(fields)` / `formDraft(fields, deps)` (`web/src/lib/intake.ts`, server-side) | for /visit | Typed `FormFields` (booleans, numbers, enum keys; empty = not answered; `has_ev: "now"` = yes) → the same `normaliseFacts` facts and home as a call. `formDraft` adds Google's roof and the engine design, exactly like `/api/intake`, so /visit, /intake and the voice call design identically. |
| `GET /api/voice/status` | none (no facts, names or secrets in it) | `{ checked_at, config{toolSecret, webhookSecret, elevenLabsKey, ttsEnabled}, tools{update_facts|create_design|post_call: {last, recent[{at, status, result}]}}, supabase{newest_call{created_at, status, from_update_facts, facts_updated_at, answers, transcript_turns}, newest_voice_design_at} }`. "Did the agent reach us?": each tool route keeps its last 10 hits in memory (GET on the tool route returns them), and the newest calls row is the durable proof. `result` names the cause: wrong x-agent-token, webhook signature, no facts. |
| `POST /api/voice/explain` | none; 10/min per client | `{ design_id }` (stored designs only in production; `{ design_response }` in dev and via `/api/offer/[token]`), optional `language: "de"`, `audio: true` → `{ text, by: claude|template, segments[{text, moment: morning|noon|evening|null, start_s, end_s, time_of_day_h: 8|12.5|19|null}], duration_s, timing: audio|estimated, audio_base64, audio_url?, cache_key, cached: clip|memory|in_flight|null, audio_reason? }`. The script tells the household's day (one sentence each for morning / noon / evening) so the 3D house's clock can follow the voice; Claude writes JSON and every number must be an engine number, else the template is used. Audio via ElevenLabs `with-timestamps`, so sentence times are exact; without audio they are estimated. Cached by (engine facts, language, voice): memory per instance (concurrent requests for the same design share one Claude + ElevenLabs run: `cached: in_flight`; a failed TTS run is retried by the next request), plus committed clips in `web/public/voice/` listed in `web/src/lib/voice-cache.json` (the demo offer never calls ElevenLabs twice). Audio only when `VOICE_TTS_ENABLED=true`. |

The tool needs `conversation_id` as a parameter filled from the system dynamic variable `system__conversation_id`, so the
tool call and the post-call webhook land on the same `calls` row. Requires `supabase/migrations/20261107_calls_conversation_id.sql`
(adds `calls.conversation_id` + unique index, and a unique index for one voice draft per call).

**Privacy (open, owner: schema / session B):** `schema.sql` lets the anon key read every `calls` row, and voice calls now
hold names, addresses and full transcripts. Before real customers: drop anon read on `calls` (serve the inbox via a
server route) or expose a view without transcript/address.

## Env vars (web/.env.local locally, Vercel → Project → Settings → Environment Variables; names only, never values in git)
| Name | Where it comes from | Needed for |
|---|---|---|
| `ENGINE_URL`, `ENGINE_API_KEY` | Cala's engine (tunnel URL + its key) | real designs (without: mock in dev) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project settings → API | storing calls/designs (without: endpoints answer, nothing stored) |
| `ELEVENLABS_TOOL_SECRET` | `openssl rand -hex 32`; same value in the agent tool's `x-agent-token` header | create-design auth |
| `ELEVENLABS_WEBHOOK_SECRET` | ElevenLabs → workspace settings → webhooks, shown when the post-call webhook is created | post-call HMAC |
| `GOOGLE_MAPS_API_KEY` | Google Cloud, Geocoding API + Solar API enabled | roof lookup (without: `no_key`, design still made) |
| `ANTHROPIC_API_KEY` | Anthropic console | explain text (without: template text) |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `VOICE_TTS_ENABLED=true` | ElevenLabs | explain audio (off by default) |
| `VOICE_INSTALLER` (optional) | default `installer_a` | which installer's catalogue voice drafts use |

## Local webhooks through a tunnel (cloudflared)
```bash
cd web && npm run build && npx next start -p 3100      # production server (dev also works, first call compiles)
cloudflared tunnel --url http://localhost:3100          # prints a temporary public URL
```
The quick-tunnel URL changes on every restart: update the `create_design` tool URL and the post-call webhook URL in
ElevenLabs each time (or use a named tunnel / the Vercel URL). Smoke tests:
```bash
curl -X POST $APP_URL/api/voice/create-design -H "x-agent-token: $ELEVENLABS_TOOL_SECRET" -H 'content-type: application/json' \
  -d '{"conversation_id":"test_1","customer_name":"Test","monthly_bill_eur":150,"household":4,"has_ev":"yes","heating":"gas","roof_direction":"south"}'
curl "$APP_URL/api/solar?address=Marienplatz%201%20M%C3%BCnchen"
curl -X POST $APP_URL/api/voice/post-call -d '{}'        # → 401 invalid signature (expected)
```

## Voice demo pre-flight
1. Deployed main includes #91 (offer mp3 public), #101 (Listen for any stored design), #106 (/live shows household/bill/roof); `<APP_URL>/api/engine/health` shows `served.source = engine`.
2. Agent "Reonic AI Designer - Site Visit Agent" (id above): tools `create_design` and `update_facts` → `<APP_URL>/api/voice/…` with header `x-agent-token`; post-call webhook → `/api/voice/post-call` (HMAC secret set).
3. Big screen: sign in, open `/live` before dialling (it polls every 2 s); call from the ElevenLabs "Test call" link with a headset.
4. Persona: "Anna Weber, Musterstraße 80, München; family of four; about €120 a month; buying an EV next year; no solar yet; gas heating; south-facing roof."
5. Expect on /live within ~2–3 s of each answer: name → address (Google roof fills orientation/tilt) → 4 people → €120 → ~4,100 kWh → EV + 15,000 km (assumed) → no existing PV.
6. Close: the agent reads the facts back, calls `create_design` and says "Your draft design is ready: … kWp solar, a … kWh battery and a wallbox"; the draft appears on /live and in the inbox.
7. "EV next year" counts as yes (`has_ev: planned`), so the wallbox is in the first design; that is the "design adapts" beat.
8. After hang-up: the post-call webhook sets the call to `ended` with transcript and summary (≤ 1 min).
9. Fallbacks: engine slow → agent says "in the inbox in a minute" and the draft lands later; `update_facts` not attached → /live fills only at `create_design`; Google off → roof from the caller's answer; call fails → /live demo mode (scripted).
10. Homeowner beat: `/offer/demo` → Listen plays the cached 40 s clip (no ElevenLabs cost) and the house clock runs 8 → 12.5 → 19 h. Afterwards delete test calls by conversation_id (service role, Mark's OK).

**Which persona on stage (decision for Mark).** The persona above says "buying an EV next year", so the wallbox is in the first design and the EV shows up during the call. `docs/demo-runbook.md` uses a caller with **no** EV, so that the planner's "They are buying an EV next year" step visibly changes the design (9.9 → 11.25 kWp, wallbox added). Pick one story and use the matching persona.
