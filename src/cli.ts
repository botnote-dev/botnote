#!/usr/bin/env node
import { createDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { EmbeddingService } from "./service/embedding.js";
import { purgeExpired } from "./service/entities.js";
import { LOCK_KEYS, withAdvisoryLock } from "./service/locks.js";
import { materializeScheduledRecurrences } from "./service/recurrence.js";
import { resolveDefaultScope } from "./service/scope.js";
import { pruneExpiredSessions } from "./service/sessions.js";
import { DEFAULT_PORT, envValue } from "./config.js";
import { authConfigFromEnv, isLoopback } from "./rest/auth.js";
import { buildServer } from "./rest/server.js";
import { VERSION } from "./version.js";

const DEFAULT_RECURRENCE_MATERIALIZE_INTERVAL_MS = 5 * 60 * 1000;
// Trashed entities are hard-deleted after this many days. 0 disables auto-purge.
const DEFAULT_TRASH_RETENTION_DAYS = 30;
const DAILY_MS = 24 * 60 * 60 * 1000;
const TRASH_PURGE_INTERVAL_MS = DAILY_MS;
const SESSION_PRUNE_INTERVAL_MS = DAILY_MS;
// Re-queues task/note rows still without a vector: rows left behind by a
// restart or by a provider outage become searchable without manual backfill.
const EMBEDDING_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function endOfToday(): Date {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return end;
}

async function runRest(): Promise<void> {
  const port = Number(envValue(process.env.BOTNOTE_PORT) ?? DEFAULT_PORT);
  const host = process.env.BOTNOTE_HOST ?? "127.0.0.1";
  const logLevel = process.env.BOTNOTE_LOG_LEVEL ?? "info";
  const recurrenceIntervalMs = Number(
    process.env.BOTNOTE_RECURRENCE_MATERIALIZE_INTERVAL_MS ??
      DEFAULT_RECURRENCE_MATERIALIZE_INTERVAL_MS
  );

  await migrate();

  const { db, pool } = createDb();
  const defaultScope = await resolveDefaultScope(db);
  const embedding = new EmbeddingService(db, { apiKey: process.env.OPENAI_API_KEY });
  await embedding.reloadConfig();

  const auth = authConfigFromEnv();
  const app = await buildServer({ db, embedding, logLevel, auth, defaultScope });
  await app.listen({ port, host });
  embedding.setLogger((msg) => app.log.warn(`embedding: ${msg}`));

  app.log.info(
    `botnote v${VERSION} listening on http://${host}:${port} (docs: /docs, embeddings ${embedding.isEnabled() ? "ON" : "OFF"})`
  );
  if (!auth.required && !isLoopback(host) && host !== "localhost") {
    app.log.warn(
      `listening on ${host} with auth disabled: anyone who can reach port ${port} can read and write everything. Set BOTNOTE_PASSWORD (and create an API token) or BOTNOTE_REQUIRE_AUTH=1.`
    );
  }

  // Background jobs take a database-wide advisory lock so several daemon
  // instances on one database (hosted mode) never run the same pass twice.
  const materializeRecurrences = async () => {
    try {
      const run = await withAdvisoryLock(pool, LOCK_KEYS.recurrenceMaterializer, () =>
        materializeScheduledRecurrences(db, endOfToday(), 500)
      );
      if (!run.acquired) {
        app.log.debug("recurrence materializer skipped: another instance holds the lock");
        return;
      }
      if (run.value.length > 0) {
        app.log.info(`materialized ${run.value.length} scheduled recurring task(s)`);
      }
    } catch (err) {
      app.log.error({ err }, "scheduled recurrence materializer failed");
    }
  };
  await materializeRecurrences();
  const recurrenceTimer =
    recurrenceIntervalMs > 0 ? setInterval(materializeRecurrences, recurrenceIntervalMs) : null;

  const trashRetentionDays = Number(
    process.env.BOTNOTE_TRASH_RETENTION_DAYS ?? DEFAULT_TRASH_RETENTION_DAYS
  );
  const purgeTrash = async () => {
    try {
      const run = await withAdvisoryLock(pool, LOCK_KEYS.trashPurge, () =>
        purgeExpired(db, trashRetentionDays)
      );
      if (!run.acquired) {
        app.log.debug("trash purge skipped: another instance holds the lock");
        return;
      }
      if (run.value > 0) {
        app.log.info(`purged ${run.value} trashed entit(ies) older than ${trashRetentionDays}d`);
      }
    } catch (err) {
      app.log.error({ err }, "trash purge failed");
    }
  };
  let trashTimer: NodeJS.Timeout | null = null;
  if (trashRetentionDays > 0) {
    await purgeTrash();
    trashTimer = setInterval(purgeTrash, TRASH_PURGE_INTERVAL_MS);
  }

  const pruneSessions = async () => {
    try {
      const run = await withAdvisoryLock(pool, LOCK_KEYS.sessionPrune, () =>
        pruneExpiredSessions(db)
      );
      if (!run.acquired) {
        app.log.debug("session prune skipped: another instance holds the lock");
        return;
      }
      if (run.value > 0) {
        app.log.info(`pruned ${run.value} expired session(s)`);
      }
    } catch (err) {
      app.log.error({ err }, "session prune failed");
    }
  };
  await pruneSessions();
  const sessionTimer = setInterval(pruneSessions, SESSION_PRUNE_INTERVAL_MS);

  const sweepMissingEmbeddings = async () => {
    if (!embedding.isEnabled()) return;
    try {
      const queued = await embedding.enqueueMissing();
      if (queued.enqueued > 0) {
        app.log.info(
          `queued ${queued.enqueued} entit(ies) for embedding backfill (${queued.pendingCount} pending)`
        );
      }
    } catch (err) {
      app.log.error({ err }, "embedding backfill sweep failed");
    }
  };
  await sweepMissingEmbeddings();
  const embeddingTimer = setInterval(sweepMissingEmbeddings, EMBEDDING_SWEEP_INTERVAL_MS);

  const shutdown = async (sig: string) => {
    app.log.info(`shutting down on ${sig}`);
    if (recurrenceTimer) clearInterval(recurrenceTimer);
    if (trashTimer) clearInterval(trashTimer);
    clearInterval(sessionTimer);
    clearInterval(embeddingTimer);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Old plugin configs ran `node dist/cli.js mcp`; without this they would boot
// a second daemon instead of an MCP server.
if (process.argv[2] === "mcp") {
  console.error("The MCP server moved to the botnote CLI package. Run `botnote mcp` (or `npx -y botnote mcp`).");
  process.exit(2);
}

runRest().catch((err) => {
  console.error(err);
  process.exit(1);
});
