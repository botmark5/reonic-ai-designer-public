# Lessons from ROSI's ElevenLabs voice setup (patterns only, no ROSI code or secrets)

- Configure the agent in code/API (prompt, first message, voice, eleven_flash_v2_5, backup LLM, data_collection), not by hand.
- Tools = webhooks to our backend; auth with one shared secret header (e.g. `x-agent-token` or Bearer) and require the
  conversation id on every call.
- Optional pre-call webhook returns `dynamic_variables` before the greeting.
- Latency: backup LLM with a timeout between 2 and 15 s (outside that range ElevenLabs rejects the config); no
  "one moment please" lines in the prompt.
- Post-call: signed `post_call_transcription` webhook; verify the HMAC on the RAW body (parse JSON only after checking).
  Store it, then run a second analysis pass if needed. Live UI via Supabase Realtime on `calls` (ROSI uses Firestore onSnapshot).
- Dynamic variables: convert null to '' (otherwise the prompt shows "None"); every variable in the prompt needs a default
  or the call fails with "Missing required dynamic variables"; label each one in the prompt ("Installer name: {{installer_name}}").
- Tool descriptions must say "never assume values; ask if unknown".
- Tool responses should return an explicit `instruction` string telling the agent what to say next.
- Keep secrets out of the prompt.
