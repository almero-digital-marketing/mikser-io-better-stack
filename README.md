# mikser-io-better-stack

[Better Stack](https://betterstack.com) (uptime + log management) integration for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). One plugin call wires both surfaces:

- **Log shipping** — every log line mikser emits ships to Better Stack's log ingestion via `@logtail/pino`, alongside the local terminal pretty stream. No "configure pino transport in your config file" boilerplate; the plugin registers the transport for you.
- **Uptime heartbeat** — periodic ping to a Better Stack Uptime heartbeat URL so the dashboard knows the mikser process is alive. Default interval 60s. SIGINT/SIGTERM cleanup so the timer doesn't dangle on Ctrl-C.

Either surface works on its own — set only `sourceToken` for logs-only, only `heartbeatToken` for uptime-only.

Built on the `addLogTransport` substrate landed in mikser-io 9.x. No special config-file mutations required; the plugin's factory side-effects the transport registration at config-eval time and the engine drains it when the logger builds.

## Install

```bash
npm install mikser-io-better-stack
```

Peer dep on `mikser-io ^9`. Hard dep on `@logtail/pino`.

## Set up Better Stack (~5 minutes)

### 1. Sign up

https://betterstack.com — free tier covers a single mikser instance with sensible log retention.

### 2. Create a log source (for log shipping)

Better Stack dashboard → **Telemetry** → **Sources** → **Connect source**.

- **Name**: whatever (`mikser-blog`, `staging`, etc.)
- **Platform**: **JavaScript · Node.js**
- The **Source token** appears on the next screen. Copy it.

Drop it in your project's `.env`:

```bash
BETTERSTACK_SOURCE_TOKEN=...
# or, equivalently — matches Better Stack's own docs:
# LOGTAIL_SOURCE_TOKEN=...
```

### 3. Create a heartbeat monitor (for uptime)

Better Stack dashboard → **Uptime** → **Monitors** → **Create monitor**.

- **Monitor type**: **Heartbeat**
- **Name**: whatever (`mikser-blog heartbeat`)
- **Period**: pick the cadence you want mikser to ping at (default 60 seconds matches the plugin's default)
- **Grace period**: how long before a missed beat triggers an alert (default 30 seconds is fine for most setups)

After creating, copy the **Heartbeat URL** OR just the heartbeat token at the end (the part after `/api/v1/heartbeat/`).

```bash
BETTERSTACK_HEARTBEAT_TOKEN=...
```

## Use it

```js
// mikser.config.js
import { betterStack } from 'mikser-io-better-stack'

export default {
    plugins: [
        betterStack(),                  // picks both tokens up from env
        // ... your other plugins
    ],
}
```

That's the whole integration. Run mikser:

```bash
mikser --watch --server 3001
```

Expect:

```
Logger: ...
better-stack heartbeat: every 60000ms
... (every mikser log line now also shows up in Better Stack Telemetry)
```

A few minutes later: heartbeat status flips green in Better Stack Uptime; the mikser log stream appears in Telemetry.

## Options

```js
betterStack({
    // ─── Log shipping ──────────────────────────────────────────────────
    sourceToken: process.env.BETTERSTACK_SOURCE_TOKEN,
    level:       'info',     // minimum level shipped (default: 'info')
    // Optional alternate ingestion endpoint — only needed if your
    // Better Stack tenant uses a custom ingestion host.
    // ingestingHost: 'https://in.logs.betterstack.com',

    // ─── Heartbeat ─────────────────────────────────────────────────────
    heartbeatToken: process.env.BETTERSTACK_HEARTBEAT_TOKEN,
    intervalMs:     60_000,   // ping every minute (default)
    // Override the heartbeat endpoint if Better Stack ever changes URL
    // shape, or if you're pointing at a non-prod tenant. Falls back to
    // the standard https://uptime.betterstack.com/api/v1/heartbeat/<token>.
    // heartbeatUrl: 'https://uptime.betterstack.com/api/v1/heartbeat/...',
})
```

## Token resolution precedence

The plugin checks options first, then env. For source token:

1. `options.sourceToken`
2. `process.env.LOGTAIL_SOURCE_TOKEN` (Better Stack's own convention)
3. `process.env.BETTERSTACK_SOURCE_TOKEN` (mikser-friendlier name, pairs with `BETTERSTACK_HEARTBEAT_TOKEN`)

For heartbeat token:

1. `options.heartbeatToken`
2. `process.env.BETTERSTACK_HEARTBEAT_TOKEN`

Setting neither is a no-op with an info log line — the plugin doesn't fail, it just doesn't do anything. Useful when you want the same `mikser.config.js` to run in dev without Better Stack and production with it.

## What the log records look like

mikser uses pino with a custom level (`notice` between info and warn). The `@logtail/pino` transport ships records with the standard pino shape:

```json
{
    "level": 30,
    "level_label": "info",
    "time": 1717948800000,
    "msg": "Rendered: 25",
    "pid": 12345,
    "hostname": "blog-prod-1"
}
```

Better Stack Telemetry handles structured fields natively — searchable, filterable, JSON-aware. Build dashboards on `level`, `pid`, custom fields plugins add (`gdrive`, `github`, `ngrok` prefixes are noticeable patterns in agency setups), etc.

The terminal pretty stream stays alive in parallel. You see the colorful output locally; the shipped records have the raw structured shape.

## Heartbeat semantics

- **First ping** fires immediately on plugin load, not after the first interval. The Better Stack dashboard goes green from "first start" rather than "60 seconds after first start."
- **Transient network failures** log at warn level and don't abort the timer. Better Stack's grace period (configurable per-monitor, default 30s) tolerates short outages without paging.
- **Process exit** — SIGINT and SIGTERM clear the interval. ungraceful exits (kill -9, crash) cause the next heartbeat to miss; Better Stack pages after the grace period.

## Composing with other plugins

The `addLogTransport` substrate (mikser-io 9.x) means this isn't a special integration — it's the standard way to ship logs. Other vendors fit the same shape:

```js
import { betterStack }   from 'mikser-io-better-stack'   // logs + uptime
import { datadog }       from 'mikser-io-datadog'        // (hypothetical)
import { sentry }        from 'mikser-io-sentry'         // (hypothetical)

plugins: [
    betterStack(),                  // ships to Better Stack
    datadog({ apiKey: ... }),       // also ships to Datadog
    sentry({ dsn: ... }),           // also ships to Sentry breadcrumbs
    // ... your other plugins
]
```

Each plugin adds its own pino transport via `addLogTransport`; the multistream fans every log record out to all of them. No conflicts. Mix freely.

## What this plugin does NOT do

- **Custom metrics.** Better Stack Telemetry ships logs and metrics, but this plugin only handles logs. For metrics — request rates, build durations, error counts — wire them via pino structured logs or a separate metrics shipper.
- **Deploy markers / release tracking.** Better Stack supports flagging deploys for correlation; this plugin doesn't yet auto-fire one at startup. v1.1 may add it via a deploy-marker call at onInitialized.
- **Process supervision.** Heartbeat tells Better Stack mikser is alive at the application level. It doesn't restart mikser if the process dies — use systemd / pm2 / k8s readiness probes for that.
- **Webhook receivers for Better Stack alerts.** One-way: mikser → Better Stack. Receiving alerts back (e.g. "wake mikser up if it goes quiet") is a different integration.

## License

MIT
