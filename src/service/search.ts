import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { edges, entities as entitiesTable, type Entity } from "../db/schema.js";
import type { Scope } from "./scope.js";
import type { SearchInput } from "./types.js";

export interface SearchHit {
  entity: Entity;
  score: number;
  components: {
    keyMatch?: number;
    bm25?: number;
    cosine?: number;
    timeDecay?: number;
    accessBoost?: number;
  };
  /** True when another entity supersedes this one (score multiplied down). */
  superseded?: boolean;
}

const RRF_K = 60;
// Entities that are the target of a 'supersedes' edge keep showing up in
// results (history stays reachable) but far below their replacement.
const SUPERSEDED_MULTIPLIER = 0.3;
// Light frequency boost: log-scaled, capped well below one RRF rank step at
// the top of the list so access count breaks ties rather than beating relevance.
function accessBoostFor(accessCount: number): number {
  return Math.min(Math.log1p(accessCount) * 0.0015, 0.005);
}
const KIND_WEIGHTS: Record<string, number> = {
  decision: 0.3,
  memory: 0.1,
  task: 0.05,
  worklog: -0.1,
  feedback: -0.1,
  log: -0.2
};

// Freshness is a tie-breaker, not a relevance signal: the boost decays with
// the hit's own age and its maximum stays below the RRF gap between rank 1
// and rank 2 (1/61 - 1/62 ≈ 2.6e-4), so it can never lift a hit over one
// ranked above it in any modality.
const TIME_DECAY_MAX = 0.00025;
const TIME_DECAY_SCALE_DAYS = 90;
const DAY_MS = 86_400_000;

export function timeDecayFor(createdAt: Date, now: Date = new Date()): number {
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / DAY_MS);
  return TIME_DECAY_MAX * Math.exp(-ageDays / TIME_DECAY_SCALE_DAYS);
}

function rrfScore(rank: number | undefined): number {
  if (rank == null) return 0;
  return 1 / (RRF_K + rank);
}

// A KEY-SEQ ref in the query names one entity outright, so an exact match
// outranks every relevance-scored hit (those top out near 0.04).
const KEY_MATCH_SCORE = 1;
const MAX_KEY_REFS = 10;
const KEY_REF_RE = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_]*)-(\d{1,9})(?![A-Za-z0-9_-])/g;

export interface KeyRef {
  projectKey: string;
  sequenceId: number;
}

export function parseKeyRefs(query: string): KeyRef[] {
  const seen = new Set<string>();
  const refs: KeyRef[] = [];
  for (const m of query.matchAll(KEY_REF_RE)) {
    const projectKey = m[1]!.toUpperCase();
    const sequenceId = Number.parseInt(m[2]!, 10);
    if (sequenceId <= 0) continue;
    const id = `${projectKey}-${sequenceId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push({ projectKey, sequenceId });
    if (refs.length >= MAX_KEY_REFS) break;
  }
  return refs;
}

function keyMatchScore(rank: number | undefined): number {
  if (rank == null) return 0;
  return KEY_MATCH_SCORE / rank;
}

type IdRow = { id: string };

/** Rows arrive in the sub-query's ORDER BY; position is the modality rank. */
function rankMap(rows: IdRow[]): Map<string, number> {
  const m = new Map<string, number>();
  rows.forEach((r, i) => m.set(r.id, i + 1));
  return m;
}

// HNSW evaluates the WHERE clause after the nearest-neighbour walk, so the
// default ef_search=40 can leave a project-scoped query with almost nothing.
// Widen the candidate set per query (ef_search caps at 1000) and, where
// pgvector supports it, keep scanning until LIMIT rows pass the filter.
const HNSW_EF_SEARCH_MIN = 200;
const HNSW_EF_SEARCH_MAX = 1000;

const iterativeScanSupport = new WeakMap<object, Promise<boolean>>();

function versionAtLeast(version: string | undefined, min: [number, number, number]): boolean {
  if (!version) return false;
  const parts = version.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const v = parts[i] ?? 0;
    if (v > min[i]!) return true;
    if (v < min[i]!) return false;
  }
  return true;
}

function supportsIterativeScan(db: Database["db"]): Promise<boolean> {
  let cached = iterativeScanSupport.get(db);
  if (!cached) {
    cached = db
      .execute<{ extversion: string }>(
        sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`
      )
      .then((r) => versionAtLeast(r.rows[0]?.extversion, [0, 8, 0]))
      .catch(() => false);
    iterativeScanSupport.set(db, cached);
  }
  return cached;
}

async function nearestRows(
  db: Database["db"],
  queryEmbedding: number[],
  commonFilter: ReturnType<typeof sql>,
  fetchN: number
): Promise<IdRow[]> {
  const vecLiteral = `[${queryEmbedding.join(",")}]`;
  const efSearch = Math.min(HNSW_EF_SEARCH_MAX, Math.max(HNSW_EF_SEARCH_MIN, fetchN * 4));
  const iterative = await supportsIterativeScan(db);
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${efSearch}`));
    if (iterative) await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    const result = await tx.execute<IdRow>(sql`
      SELECT id
      FROM entities
      WHERE body_vec IS NOT NULL ${commonFilter}
      ORDER BY body_vec <=> ${vecLiteral}::vector
      LIMIT ${fetchN}
    `);
    return result.rows;
  });
}

export async function search(
  scope: Scope,
  db: Database["db"],
  input: SearchInput,
  opts: { queryEmbedding?: number[]; now?: Date; matchKeys?: boolean } = {}
): Promise<SearchHit[]> {
  const wsFilter = sql`AND workspace_id = ${scope.workspaceId}::uuid`;
  const projectFilter = input.projectId
    ? sql`AND project_id = ${input.projectId}::uuid`
    : sql``;
  const kindFilter = input.kind ? sql`AND kind = ${input.kind}` : sql``;
  const activeProjectFilter = input.projectId
    ? sql``
    : sql`AND (project_id IS NULL OR project_id IN (
        SELECT id FROM projects
        WHERE status <> 'archived' AND workspace_id = ${scope.workspaceId}::uuid
      ))`;
  const notTrashed = sql`AND deleted_at IS NULL`;
  const commonFilter = sql`${wsFilter} ${projectFilter} ${kindFilter} ${activeProjectFilter} ${notTrashed}`;
  const fetchN = Math.max(input.limit * 4, 40);

  const lexicalRows = async (): Promise<IdRow[]> => {
    const bm25 = (
      await db.execute<IdRow>(sql`
        SELECT id
        FROM entities, websearch_to_tsquery('simple', ${input.query}) q
        WHERE body_tsv @@ q ${commonFilter}
        ORDER BY ts_rank_cd(body_tsv, q) DESC
        LIMIT ${fetchN}
      `)
    ).rows;
    if (bm25.length > 0) return bm25;
    return (
      await db.execute<IdRow>(sql`
        SELECT id
        FROM entities
        WHERE (title ILIKE ${`%${input.query}%`} OR body ILIKE ${`%${input.query}%`})
          ${commonFilter}
        ORDER BY created_at DESC
        LIMIT ${fetchN}
      `)
    ).rows;
  };

  const keyRefs = opts.matchKeys === false ? [] : parseKeyRefs(input.query);
  const keyRows = async (): Promise<IdRow[]> => {
    if (keyRefs.length === 0) return [];
    const values = sql.join(
      keyRefs.map((r, i) => sql`(${r.projectKey}::text, ${r.sequenceId}::int, ${i}::int)`),
      sql`, `
    );
    return (
      await db.execute<IdRow>(sql`
        SELECT entities.id
        FROM entities
        JOIN (
          SELECT p.id AS ref_project_id, k.seq AS ref_seq, k.ord AS ref_ord
          FROM (VALUES ${values}) AS k(project_key, seq, ord)
          JOIN projects p
            ON p.key = k.project_key AND p.workspace_id = ${scope.workspaceId}::uuid
        ) AS refs
          ON entities.project_id = refs.ref_project_id AND entities.sequence_id = refs.ref_seq
        WHERE TRUE ${commonFilter}
        ORDER BY refs.ref_ord
      `)
    ).rows;
  };

  const hasEmbedding = !!opts.queryEmbedding && opts.queryEmbedding.length > 0;
  const [keyMatchRows, bm25Rows, vecRows] = await Promise.all([
    keyRows(),
    lexicalRows(),
    hasEmbedding ? nearestRows(db, opts.queryEmbedding!, commonFilter, fetchN) : Promise.resolve([])
  ]);

  const keyMap = rankMap(keyMatchRows);
  const bm25Map = rankMap(bm25Rows);
  const vecMap = rankMap(vecRows);

  const ids = new Set<string>([...keyMap.keys(), ...bm25Map.keys(), ...vecMap.keys()]);
  if (ids.size === 0) return [];

  const idArr = [...ids];
  const [entitiesRows, supersededRows] = await Promise.all([
    db
      .select()
      .from(entitiesTable)
      .where(and(eq(entitiesTable.workspaceId, scope.workspaceId), inArray(entitiesTable.id, idArr))),
    db
      .select({ toId: edges.toId })
      .from(edges)
      .where(and(eq(edges.kind, "supersedes"), inArray(edges.toId, idArr)))
  ]);
  const entityMap = new Map<string, Entity>();
  for (const r of entitiesRows) entityMap.set(r.id, r);
  const supersededIds = new Set(supersededRows.map((r) => r.toId));

  const now = opts.now ?? new Date();
  const hits: SearchHit[] = [];
  for (const id of idArr) {
    const entity = entityMap.get(id);
    if (!entity) continue;
    const keyMatch = keyMatchScore(keyMap.get(id));
    const bm25 = rrfScore(bm25Map.get(id));
    const cosine = rrfScore(vecMap.get(id));
    const timeDecay = timeDecayFor(entity.createdAt, now);
    const kindWeight = KIND_WEIGHTS[entity.kind] ?? 0;
    const accessBoost = accessBoostFor(entity.accessCount);
    const superseded = supersededIds.has(id);
    let score = keyMatch + bm25 + cosine + timeDecay + kindWeight * 0.01 + accessBoost;
    if (superseded) score *= SUPERSEDED_MULTIPLIER;
    hits.push({
      entity,
      score,
      components: {
        keyMatch: keyMatch || undefined,
        bm25: bm25 || undefined,
        cosine: cosine || undefined,
        timeDecay: timeDecay || undefined,
        accessBoost: accessBoost || undefined
      },
      ...(superseded ? { superseded: true } : {})
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, input.limit);
}

// A hit must be near the top of at least one modality to count as a
// near-duplicate hint (bm25 rank-1 alone ≈ 1/61 ≈ 0.016).
const SIMILAR_MIN_SCORE = 0.015;

/**
 * Near-duplicate candidates for a freshly written note, used by `remember`
 * to hint the caller that a similar memory may already exist. Queries with
 * the note's label line (title or first body line) so tsquery stays short.
 */
export async function findSimilar(
  scope: Scope,
  db: Database["db"],
  opts: {
    title?: string | null;
    body: string;
    projectId?: string | null;
    excludeId?: string;
    limit?: number;
    queryEmbedding?: number[];
  }
): Promise<SearchHit[]> {
  const label = (opts.title ?? opts.body.split("\n")[0] ?? "").trim().slice(0, 200);
  if (!label) return [];
  const limit = opts.limit ?? 3;
  const hits = await search(
    scope,
    db,
    { query: label, projectId: opts.projectId ?? null, kind: "note", limit: limit + 1 },
    { matchKeys: false, ...(opts.queryEmbedding ? { queryEmbedding: opts.queryEmbedding } : {}) }
  );
  return hits
    .filter((h) => h.entity.id !== opts.excludeId && !h.superseded && h.score >= SIMILAR_MIN_SCORE)
    .slice(0, limit);
}
