# Session D: voice agent backend + Google Solar
Branch: `web/voice`. Model: Opus. Start AFTER session B pushed milestone 1 (git pull it first).
Read: CLAUDE.md, docs/api.md, docs/voice-agent.md, web/src/lib/{types,engine,supabase}.ts, supabase/schema.sql,
and docs/rosi-notes.md if it exists (how ROSI does voice agents; reuse what fits).
Skills: superpowers:writing-plans, superpowers:test-driven-development, superpowers:systematic-debugging.
Plan first, wait for my OK. You own ONLY web/src/app/api/{voice,solar}/ and web/src/lib/{solar,voice}.ts.

1. POST /api/voice/create-design: the ElevenLabs agent's server tool (webhook). Check the shared secret header
   (env ELEVENLABS_TOOL_SECRET). Body: customer_name, address, annual_kwh or monthly_bill_eur, household, has_ev,
   ev_km_year, heating, heating_age_years, roof_type, roof_direction, existing_pv_kwp, existing_battery_kwh, notes.
   Normalise (bill → kWh via price), optionally enrich with /api/solar, call engine.design (mock or real), insert a calls
   row + a designs row (source 'voice', status 'draft'), and return within ~3 s a one-sentence summary the agent can say
   ("10.8 kWp, 10 kWh battery, wallbox; heat pump as a later option. It's in your inbox.").
2. POST /api/voice/post-call: ElevenLabs post-call webhook (verify HMAC with ELEVENLABS_WEBHOOK_SECRET) → store
   transcript, summary and data-collection results on the calls row.
3. GET /api/solar?address=…: Google Geocoding + Solar API buildingInsights:findClosest (env GOOGLE_MAPS_API_KEY) →
   { lat, lng, roof segments (pitch, azimuth, area), maxArrayPanelsCount, panel watts, yearly sunshine hours };
   cache results; return a clear "not covered" result instead of failing.
4. POST /api/voice/explain: Claude writes a 45-second plain-language offer summary; ElevenLabs text-to-speech turns it
   into audio for "Listen to your offer". Build the endpoint but do NOT generate any audio until Mark confirms the voice.
5. docs/voice-agent.md: add how to run a tunnel for local webhooks (cloudflared) and which env vars Vercel needs.
Never log secrets. Tick docs/PLAN.md, open a PR.
