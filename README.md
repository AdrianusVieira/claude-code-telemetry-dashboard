# Claude Code telemetry dashboard

A local dashboard that tracks Claude Code usage per chat across projects, using your existing chat names to find and compare sessions.

This first version receives **OTLP over HTTP/JSON**, saves selected fields in SQLite, and serves a React + TypeScript dashboard from your own machine. The receiver is also TypeScript, so npm runs the entire app. No external service is required.

## Start the dashboard

From this repository, with Node.js 20.19+ installed:

```sh
npm install
npm start
```

Open [http://127.0.0.1:41300](http://127.0.0.1:41300). The OTLP receiver listens on `http://127.0.0.1:4318` at `/v1/metrics` and `/v1/logs`. Both listeners bind only to loopback. The SQLite database is created at `data/telemetry.sqlite3` and is ignored by Git.

`npm start` builds the React UI, then starts both local listeners. The same SQLite database path (`data/telemetry.sqlite3`) works with the earlier Python prototype; existing local data is preserved except for old `claude_code.session.count` rows, which are removed when the receiver starts. Future session count metrics are ignored. To change a port or path after building, use `npm run server -- --dashboard-port 41301 --otlp-port 4319 --db data/telemetry.sqlite3`. Use `--claude-dir` to point chat title discovery at another Claude data directory.

For development, run `npm run dev` and open `http://127.0.0.1:5173`. This starts Vite and the TypeScript receiver together. Vite proxies `/api` to the local receiver. After UI edits, `npm start` rebuilds the page served on port 41300.

## Connect one project

Open a **new terminal** in the project you want to measure, then run:

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_RESOURCE_ATTRIBUTES=project.id=my-project
claude
```

Replace `my-project` with your project's name. For each additional project, launch Claude Code with a different `project.id`. Recent Claude Code versions can also supply repository identity: set `OTEL_METRICS_INCLUDE_REPOSITORY=true` and the dashboard will use `vcs.repository.name` when no `project.id` is present.

Send a prompt. Logs usually export within 5 seconds; metrics default to a 60 second interval. If no data arrives, run `claude --debug-file /tmp/claude-otel-debug.log` and look for `[3P telemetry]` exporter errors. Claude Code does not accept OTLP exporter settings from a project's `.claude/settings.json`; use the shell, managed settings, or your user-level `~/.claude/settings.json`. For a first test, the terminal CLI makes the environment easiest to verify. An editor extension may need its own startup environment or user-level settings.

To show sanitized prompt text alongside the API request tokens and estimated cost it triggered, enable prompt content **only for the local receiver**, before launching Claude Code:

```sh
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_ASSISTANT_RESPONSES=0
```

The dashboard never backfills earlier prompt text. It links each `user_prompt` event to API requests through `prompt.id`. Costs shown per prompt are the sum of the linked API request estimates when all those requests include a cost; they can differ from session cost metrics. Leave raw API bodies, tool content, and tool details disabled. Do not point a content-enabled OTLP exporter directly at a hosted endpoint: the raw prompt reaches that endpoint before this dashboard can sanitize it.

The OTLP receiver supports HTTP/JSON only. If Claude Code is set to `grpc` or `http/protobuf`, switch it to `http/json` for this dashboard.

## What the dashboard means

| Field | Meaning |
| --- | --- |
| Chats | Distinct `session.id` values in the selected period. |
| Tokens | Input, output, cache read, and cache creation tokens. API request events supply the breakdown when available; otherwise token metrics do. |
| Active time | `claude_code.active_time.total` for user interaction and CLI processing. Idle time is excluded. “Unavailable” means Claude Code has not sent that metric. |
| Median request time | Median `duration_ms` of `api_request` events in this chat and period. This is API request wall time, not tokens per second. |
| Estimated cost | Claude Code's `cost.usage` metric, or `api_request` cost if the metric has not arrived. The Dashboard sums the available chat estimates for the selected period and projects and marks the total as partial when any chat lacks a cost estimate. It is an estimate, not an invoice. |
| Account emails | Distinct `user.email` values received for a chat in the selected period, shown in first-seen order. If an account changes during the same chat and both emails appear in telemetry, both are shown. |

The period filter uses telemetry timestamps. Today and custom date ranges use the browser's local calendar days. A long chat can appear in multiple periods; its numbers are calculated from the data in each selected period. The dashboard refreshes every 10 seconds.

The Dashboard home page shows totals, average tokens per API request and per prompt group, and a cumulative token timeline for the selected projects and period. The prompt-group average uses API requests with a `prompt.id`, grouped within each chat. The Sessions page lists the matching chats. Open a chat for a dedicated detail page with context at the top, followed by one overview card containing summary metrics, performance, and usage averages. Expand Above-average prompts in that card to inspect high-usage prompts and any wording matches. The Sections selector shows the token timeline by default and lets you add the token breakdown, totals per prompt, totals per API request, Cost Drivers, and Recent activity. The two comparison charts break out input, output, cache read, and cache write tokens. They start in time order and can be reordered by highest usage. The request chart displays 20 requests per page. Requests are grouped by Claude Code's `prompt.id` when available; requests without it appear in an “Other” group. Cost Drivers starts with five prompts and offers page sizes of 10 or 20. Recent activity starts with the newest 12 events; expand it to fetch the complete history in pages of 50, or collapse the section. The sidebar can be hidden and restored.

The Office page shows every project office in one navigable world. Click an office name to focus its room without hiding the others. Drag to move, use the mouse wheel or map buttons to zoom, and use Fit all to return to the campus overview. Zooming in reveals session names above seated characters at each shared desk. Each session keeps a consistent combination of clothing, skin, and hair colors. Characters have quiet idle motion. A newly observed event briefly changes their gesture and monitor color for reading, editing, commands, model requests, responses, or errors, then they return to idle. Recent signals add a teal dot to the session name. Select a character to inspect its latest observed event, usage, and estimated cost, then open the full session details. Project and period filters apply to the world. A recent signal means telemetry was received within two minutes; it does not prove the chat is still running. The page uses the dashboard's existing 10-second refresh and makes no additional Claude requests. When the world is quiet, Preview activity demonstrates the gestures with sample sessions.

The Accounts page groups usage by the `user.email` on each metric or event, with an Unattributed group for records that lack it. It shows tokens, estimated cost, chats, prompts, API requests, active time, token breakdown, and projects for each account. Date and project filters apply to the underlying records. A chat that switches accounts contributes to both accounts' distinct chat counts, while each usage record stays with the email it carried. Cost metrics take precedence over API request cost estimates within each account, project, and chat; partial estimates are labeled.

Metrics shows average and median token usage per API request and per prompt with linked requests. It identifies prompts above the linked-prompt average and their share of linked prompt tokens. For above-average prompts whose sanitized text was captured, it compares wording locally and shows up to three pairs with strong word overlap. Wording similarity is a rough text signal, not a measure of task or semantic similarity. The comparison uses at most the 50 highest-token above-average prompts; prompts without captured text cannot be compared.

Delete a chat from the Sessions list or its detail page. After confirmation, the dashboard removes that session's telemetry and saved title from its local database and ignores future telemetry for the same session ID. This does not delete the Claude Code chat or transcript.

The theme switch follows your system's light or dark setting until you choose a mode. Your choice is then saved in this browser's local storage. The visual style uses compact cards, a ruled background, and a blue accent.

## Chat names and privacy

OTLP telemetry carries `session.id` but does **not** carry the chat title. The dashboard checks local `~/.claude/projects` transcript metadata every 30 seconds for custom chat titles and joins them by session ID. It stores only the title, session ID, and modification time from that metadata. Chat title storage is best effort because Claude Code's local transcript format can change; until a title is found, the dashboard shows a shortened session ID. Only chats with telemetry received by this dashboard appear. Existing chats are not backfilled.

The receiver **does not store the incoming OTLP payload**. It stores only allowlisted numeric metrics and event fields needed for this view: timestamps, session/project IDs, email when present, model, token counts, estimated cost, request duration, event kind, tool name, success flag, and sanitized user prompt text when enabled. It does not store response text, tool inputs or outputs, error messages, raw API request/response bodies, or unknown event attributes. The built-in sanitizer masks common credentials, assignment values, long opaque strings, email addresses, and common Brazilian personal identifiers; it omits prompts longer than 16,000 characters and saves no text if sanitization fails. Automated detection cannot guarantee that every sensitive value is caught. Keep `OTEL_LOG_RAW_API_BODIES` and `OTEL_LOG_TOOL_DETAILS` disabled. The database contains usage data, titles, possibly your email, and sanitized prompts, so keep the file private.

## Alternative: a hosted receiver and a title hook

The local receiver is one way to collect this data, not a requirement of Claude Code telemetry. You can build a hosted OTLP HTTP/JSON receiver and point Claude Code's `OTEL_EXPORTER_OTLP_ENDPOINT` at its HTTPS base URL. The receiver needs endpoints for `/v1/metrics` and `/v1/logs`, persistent storage, authentication, and the same strict field allowlist used here. In that setup, telemetry can arrive while this dashboard is closed. The data is stored on the hosted service rather than only on your computer.

Chat titles need a separate path: Claude Code sends `session.id` in OTLP, but does not include the chat's displayed title. A small user-level Claude Code command hook can run at `SessionStart` and after turns, read the session ID and current title from hook input or local Claude session metadata, and POST only `{ sessionId, title }` to an authenticated title endpoint. Store titles by session ID and update the existing row when a chat is renamed. There is no title-change event to send a rename immediately; the new name appears after the next hook run. This title lookup is best effort because local metadata formats can change.

The hook can be written in Node.js so the same code works on macOS and Windows. Each machine still needs Claude Code telemetry settings, the hook installation, and its own credentials. Use a dedicated ingestion credential instead of a general application API key, keep network calls short or asynchronous so Claude Code is not delayed, and never send the full transcript or raw hook input. A hosted receiver should reject oversized requests and avoid persisting prompt text, tool content, raw API bodies, or unknown fields.

Claude Code's OTLP endpoint setting does not duplicate the same signal to two different OTLP receivers. To keep both a local and a hosted copy, send Claude Code to a local relay that forwards selected data, or configure an OpenTelemetry Collector with two exporters. A local relay must be running for that dual-destination setup; direct export to a hosted receiver does not require it. Neither approach automatically backfills telemetry from earlier chats.

## Verify locally

```sh
npm test
npm run build
```

The tests use synthetic OTLP JSON, temporary localhost ports, and temporary databases. They do not read your Claude data.

## References

- [Claude Code monitoring and telemetry](https://code.claude.com/docs/en/monitoring-usage)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/)
