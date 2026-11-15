# Hosting the EDUROAM Python tutor (always on)

The tutor is a LiveKit **agent worker**: it opens an outbound connection to the LiveKit project and waits
for dispatches. It needs no public URL. Any Linux container host works; Railway is described here.
The image is built from `agent/Dockerfile` (Python 3.13 slim, non-root `appuser`). It runs
`python agent.py start` and serves its health check on port 8081.

The Agent Builder agent `eduroam-tutor` stays untouched throughout. Calls only move to the Python tutor
when the Supabase secret `VOICE_AGENT_NAME` names it, and that is the last step.

## Verified locally (Linux container, 2026-11-15)

- `docker build -t eduroam-tutor:phase3 agent/`: the image holds no tests, no `.env*` files and no
  Builder config.
- Started with the dispatch name `eduroam-tutor-linux-check`:
  - health `GET /` returned 200 after about 10 s; `/worker` reported the name;
  - a test dispatch with an invalid pairing id was accepted, `voice-agent` refused it
    (`pairing_invalid`), the Gemini Live session opened, and there were no errors.

## Secrets (names only; set them in the host, never in git)

| Name | Value |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit project → Settings → API keys |
| `GOOGLE_API_KEY` | Gemini API key (Gemini Live + the end-of-call summary) |
| `VOICE_AGENT_SECRET` | the same value as the Supabase secret of that name |
| `EDUROAM_VOICE_AGENT_URL` | `https://horhkariflujndhttrhr.supabase.co/functions/v1/voice-agent` |
| `LIVEKIT_AGENT_NAME_OVERRIDE` | `eduroam-tutor-staging` first, then `eduroam-tutor-code` (see the rollout below) |
| `PORT` | `8081` (Railway's health check uses `$PORT`) |
| optional | `GEMINI_LIVE_MODEL`, `GEMINI_VOICE`, `SUMMARY_MODEL`, `MAX_CALL_MINUTES` (45), `AGENT_IDLE_PROCESSES` (1), `JOB_MEMORY_LIMIT_MB` (1500) |

## Railway

1. Create a Railway project and a service from this repository with **Root Directory** `agent`.
   `railway.json` makes it build the Dockerfile. It also sets a health check on `/`, restarts on
   failure (up to 10 times) and runs 1 replica. Do not add a public domain.
2. Add the variables above, with `LIVEKIT_AGENT_NAME_OVERRIDE=eduroam-tutor-staging`, then deploy.
3. Check: the deploy goes healthy, and the logs show `registered worker` with `agent_name` `eduroam-tutor-staging`.
4. Smoke test from your PC. No student data is involved; the invalid pairing id must be refused:
   ```powershell
   lk dispatch create --room eduroam-staging-check --agent-name eduroam-tutor-staging --metadata 00000000-0000-4000-8000-0000000000ff
   # Railway logs: "received job request", "pairing rejected: pairing_invalid", no traceback
   lk room delete eduroam-staging-check
   ```
5. Production switch (only after step 4, and after you approve it):
   1. Set `LIVEKIT_AGENT_NAME_OVERRIDE=eduroam-tutor-code` on Railway and stop any local `agent.py`,
      so two workers do not share the name.
   2. Run `npx supabase secrets set VOICE_AGENT_NAME=eduroam-tutor-code --project-ref horhkariflujndhttrhr`.
   3. Make a real in-game call and verify the NPC's name, a document question, memory, and the camera.

Cost controls:
- Each call ends after `MAX_CALL_MINUTES`.
- The voice-agent session window is 2 h.
- Tool calls are rate-limited per student (40/min; web search is capped at 3/min and 25/day, shared with text chat).
- `JOB_MEMORY_LIMIT_MB` restarts a runaway job instead of the worker.
- One replica, plus LiveKit's default load threshold (0.7), limits concurrent calls.

Crash recovery and shutdown:
- Each call runs in its own process, so one crash does not end other calls.
- Railway restarts the container if it exits.
- A redeploy sends SIGTERM, and active calls get up to 30 min to finish (`drain_timeout`).

## Rollback (any step, seconds)

1. Calls back to the Builder agent:
   `npx supabase secrets unset VOICE_AGENT_NAME --project-ref horhkariflujndhttrhr`
   The game still works; voice-session sends the Builder metadata.
2. Stop the Python worker: in Railway, open the service and choose Settings → Sleep / Remove deployment.
3. Code: `git checkout checkpoint-pre-ai-tutor -- agent supabase/functions` (the tag made before this work).

The Builder agent `CA_DsfmFTRP5ir5` is never modified by any of these steps.
