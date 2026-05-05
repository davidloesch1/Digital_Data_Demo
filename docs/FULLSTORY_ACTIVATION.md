# FullStory Activation (Generate Context) — collector proxy

**Plain English:** Your **FullStory API key** must never ship in the browser. The collector exposes **`POST /internal/v1/fullstory/generate-context`** so operators (or Retool) can ask FullStory for **session context formatted for LLMs**, using the same **`INTERNAL_ADMIN_TOKEN`** gate as other internal routes.

## Prerequisites

- FullStory **Anywhere: Activation** (per [Generate Context](https://developer.fullstory.com/server/sessions/generate-context/)).
- An **Operations API key** with permissions FullStory documents for Sessions API v2 (typically Admin / Architect for data reads).
- Each call may count against your **Activation** quota — see FullStory pricing/docs.

## Collector environment

| Variable | Purpose |
|----------|---------|
| **`FULLSTORY_API_KEY`** | Sent as `Authorization: Basic {key}` (FullStory’s documented form). |
| **`FULLSTORY_API_BASE`** | Optional. Default `https://api.fullstory.com`. |
| **`FULLSTORY_CONTEXT_PATH_TEMPLATE`** | Optional. Default `/v2/sessions/{sessionId}/context`. `{sessionId}` is replaced with **`encodeURIComponent(session_id)`**. Override if FullStory changes the path in your contract or region. |

## Request — `POST /internal/v1/fullstory/generate-context`

Headers: `Authorization: Bearer <INTERNAL_ADMIN_TOKEN>` (or `X-Nexus-Admin-Token`, same as other internal routes).

JSON body:

```json
{
  "session_id": "12345:abc-session-id",
  "session_url": "https://app.fullstory.com/ui/…/session/12345%3Aabc-session-id",
  "context": {}
}
```

- Provide **`session_id`** **or** a **`session_url`** the helper can parse (`/session/…` or `/replay/…`).
- **`context`** is forwarded as the JSON POST body to FullStory (may be `{}` if the API accepts an empty object — confirm against current FullStory docs for required fields).

Success: **`200`** with `{ ok: true, fullstory: <parsed JSON> }`.

Errors: **`503`** if `FULLSTORY_API_KEY` is unset; **`400`** if no session id could be resolved; **`502`** / upstream status if FullStory returns an error (response body echoed in `fullstory` when parseable).

## Verify

```bash
curl -sS -X POST "$COLLECTOR/internal/v1/fullstory/generate-context" \
  -H "Authorization: Bearer $INTERNAL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"YOUR_ENCODED_SESSION_ID","context":{}}' | jq .
```

Replace `YOUR_ENCODED_SESSION_ID` with the value from `FS.getCurrentSessionURL()` / replay links (often `orgId:session` URL-encoded in paths).

## Roadmap

NEXUS_PLAN **Phase 3** (“Watch Highlights” in product UI) can call this internal route or a thin BFF that wraps the same module.
