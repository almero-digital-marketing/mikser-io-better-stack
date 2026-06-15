// mikser-io-better-stack — Better Stack (Logtail + Uptime) integration
// for mikser-io.
//
// Two surfaces wired by one plugin call:
//
//   1. Log shipping. The factory side-effects an addLogTransport({
//      target: '@logtail/pino', options: { sourceToken } }) at config-
//      eval time. mikser-io's logger drains the pending queue when it
//      builds, so every log line from then on fans out to Better Stack
//      alongside the terminal pretty stream.
//
//   2. Uptime heartbeat. The returned lifecycle plugin registers an
//      onLoaded hook that fires a setInterval ping to Better Stack
//      Uptime's heartbeat URL. Default interval is 60s — matches the
//      "Every 1 minute" preset in the Better Stack dashboard. SIGINT
//      and SIGTERM clear the interval cleanly so a Ctrl-C doesn't
//      leave a dangling timer.
//
// Each surface is independent — if you only have a sourceToken (logs)
// or only a heartbeatToken (uptime), the other half silently no-ops.

import { addLogTransport } from 'mikser-io'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000

export function betterStack(options = {}) {
    // ───── log shipping (side-effect at factory call time) ─────────────
    //
    // Resolution order:
    //   1. options.sourceToken          (explicit)
    //   2. process.env.LOGTAIL_SOURCE_TOKEN  (matches Better Stack's own
    //      env-var convention from their docs)
    //   3. process.env.BETTERSTACK_SOURCE_TOKEN  (mikser-friendlier name
    //      that pairs with BETTERSTACK_HEARTBEAT_TOKEN below)
    const sourceToken =
        options.sourceToken
        ?? process.env.LOGTAIL_SOURCE_TOKEN
        ?? process.env.BETTERSTACK_SOURCE_TOKEN

    if (sourceToken) {
        addLogTransport({
            level:  options.level ?? 'info',
            target: '@logtail/pino',
            options: {
                sourceToken,
                ...(options.ingestingHost ? { endpoint: options.ingestingHost } : {}),
            },
        })
    }

    // ───── lifecycle plugin (heartbeat) ────────────────────────────────
    return ({ runtime, onLoaded, useLogger }) => {
        onLoaded(async () => {
            const logger = useLogger()
            const heartbeatToken =
                options.heartbeatToken
                ?? process.env.BETTERSTACK_HEARTBEAT_TOKEN
            if (!heartbeatToken) {
                if (!sourceToken) {
                    // Nothing was configured at all — surface that so
                    // the operator notices.
                    logger.info('better-stack: no tokens configured (sourceToken, heartbeatToken). Plugin is a no-op.')
                }
                return
            }

            const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
            const url = options.heartbeatUrl
                ?? `https://uptime.betterstack.com/api/v1/heartbeat/${heartbeatToken}`

            const ping = async () => {
                try {
                    const res = await fetch(url, { method: 'HEAD' })
                    if (!res.ok) {
                        logger.warn('better-stack heartbeat: %d %s', res.status, res.statusText)
                    }
                } catch (err) {
                    // Network transient — log at warn and let the next
                    // tick try again. Better Stack's grace window
                    // tolerates short outages without an alert.
                    logger.warn('better-stack heartbeat failed: %s', err.message)
                }
            }

            // Fire once immediately so the dashboard shows green from
            // the first start, not after the first interval elapses.
            ping()
            const timer = setInterval(ping, intervalMs)
            timer.unref?.()
            for (const sig of ['SIGINT', 'SIGTERM']) {
                process.once(sig, () => clearInterval(timer))
            }

            logger.info('better-stack heartbeat: every %dms', intervalMs)
        })
    }
}
