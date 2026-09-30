# Claude Code telemetry dashboard

A local dashboard that tracks Claude Code usage per chat across projects, using your existing chat names to find and compare sessions.

This first version receives **OTLP over HTTP/JSON**, saves selected fields in SQLite, and serves a React + TypeScript dashboard from your own machine. The receiver is also TypeScript, so npm runs the entire app. No external service is required.

## Start the dashboard

From this repository, with Node.js 20.19+ installed:

```sh
npm install
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The OTLP receiver listens on `http://127.0.0.1:4318` at `/v1/metrics` and `/v1/logs`. Both listeners bind only to loopback. The SQLite database is created at `data/telemetry.sqlite3` and is ignored by Git.

`npm start` builds the React UI, then starts both local listeners. The same SQLite database path (`data/telemetry.sqlite3`) works with the earlier Python prototype, so existing local data is preserved. To change a port or path after building, use `npm run server -- --dashboard-port 3001 --otlp-port 4319 --db data/telemetry.sqlite3`. Use `--claude-dir` to point chat title discovery at another Claude data directory.

For development, run `npm run dev` and open `http://127.0.0.1:5173`. This starts Vite and the TypeScript receiver together. Vite proxies `/api` to the local receiver. After UI edits, `npm start` rebuilds the page served on port 3000.

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

The OTLP receiver supports HTTP/JSON only. If Claude Code is set to `grpc` or `http/protobuf`, switch it to `http/json` for this dashboard.

## What the dashboard means

| Field | Meaning |
| --- | --- |
| Chats | Distinct `session.id` values in the selected period. |
| Session starts | Sum of `claude_code.session.count` in the period, including resumes and continues. `agents_view` launches are excluded. |
| Tokens | Input, output, cache read, and cache creation tokens. API request events supply the breakdown when available; otherwise token metrics do. |
| Active time | `claude_code.active_time.total` for user interaction and CLI processing. Idle time is excluded. “Unavailable” means Claude Code has not sent that metric. |
| Median request time | Median `duration_ms` of `api_request` events in this chat and period. This is API request wall time, not tokens per second. |
| Estimated cost | Claude Code's `cost.usage` metric, or `api_request` cost if the metric has not arrived. It is an estimate, not an invoice. |

The period filter uses telemetry timestamps. A long chat can appear in multiple periods; its numbers are calculated from the data in each selected period. The dashboard refreshes every 10 seconds.

The Sessions page supports selecting several projects and shows a cumulative token timeline across the selected chats and time period. Open a chat for a dedicated detail page with its own token timeline, token category percentages, prompt and API request counts, performance, and context. Recent activity starts with the newest 12 events; expand it to fetch the complete history in pages of 50, or collapse the section. The sidebar can be hidden and restored.

The theme switch follows your system's light or dark setting until you choose a mode. Your choice is then saved in this browser's local storage. The visual style uses compact cards, a ruled background, and a blue accent.

## Chat names and privacy

OTLP telemetry carries `session.id` but does **not** carry the chat title. The dashboard checks local `~/.claude/projects` transcript metadata every 30 seconds for custom chat titles and joins them by session ID. It stores only the title, session ID, and modification time from that metadata. Chat title storage is best effort because Claude Code's local transcript format can change; until a title is found, the dashboard shows a shortened session ID. Only chats with telemetry received by this dashboard appear. Existing chats are not backfilled.

The receiver **does not store the incoming OTLP payload**. It stores only allowlisted numeric metrics and event fields needed for this view: timestamps, session/project IDs, email when present, model, token counts, estimated cost, request duration, event kind, tool name, and success flag. It does not store prompt text, response text, tool inputs or outputs, error messages, raw API request/response bodies, or unknown event attributes. Do not enable `OTEL_LOG_RAW_API_BODIES`, `OTEL_LOG_USER_PROMPTS`, or `OTEL_LOG_TOOL_DETAILS` for this setup; they add content to the data sent over the loopback connection even though this receiver discards it. The database still contains usage data, titles, and possibly your email, so keep the file private.

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
