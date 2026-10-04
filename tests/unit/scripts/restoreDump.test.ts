import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRestoreDumpStream } from "../../../scripts/lib/restoreDump";

// Longer than one file-stream chunk, so line reassembly across chunk boundaries is exercised.
const LONG_ROW = `2\t${"x".repeat(300_000)}`;

test("restore skips extension statements only the extension owner may run, leaving data intact", async () => {
  const dump = [
    "DROP INDEX IF EXISTS public.idx_chunks_embedding;",
    "DROP EXTENSION IF EXISTS vector;",
    "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;",
    "COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';",
    "COMMENT ON EXTENSION multiline IS 'first line",
    "second line';",
    "COPY public.server_memories (server_memory_id, content) FROM stdin;",
    "1\tplain memory",
    LONG_ROW,
    "DROP EXTENSION IF EXISTS vector;\tmemory text that looks like SQL",
    "\\.",
    "",
    "COMMENT ON EXTENSION pg_cron IS 'Job scheduler for PostgreSQL';",
  ].join("\n");

  const root = mkdtempSync(join(tmpdir(), "tomori-restore-dump-"));
  try {
    const dumpPath = join(root, "database.sql");
    writeFileSync(dumpPath, dump);
    const restored = await new Response(createRestoreDumpStream(dumpPath)).text();

    expect(restored.split("\n")).toEqual([
      "DROP INDEX IF EXISTS public.idx_chunks_embedding;",
      "-- DROP EXTENSION IF EXISTS vector;",
      "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;",
      "-- COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';",
      "COMMENT ON EXTENSION multiline IS 'first line",
      "second line';",
      "COPY public.server_memories (server_memory_id, content) FROM stdin;",
      "1\tplain memory",
      LONG_ROW,
      "DROP EXTENSION IF EXISTS vector;\tmemory text that looks like SQL",
      "\\.",
      "",
      "-- COMMENT ON EXTENSION pg_cron IS 'Job scheduler for PostgreSQL';",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
