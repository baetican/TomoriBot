const EXTENSION_OWNER_STATEMENT = /^(DROP|COMMENT ON) EXTENSION\b/;
const COPY_START = /^COPY .+ FROM stdin;\r?$/;
const COPY_END = /^\\\.\r?$/;

/**
 * Comments out `DROP EXTENSION` and `COMMENT ON EXTENSION` statements in a plain-SQL pg_dump.
 *
 * Postgres only lets an extension's owner run either one, and on a fresh install the
 * extensions (vector, pg_cron, pgcrypto) usually belong to the superuser that created them,
 * not to the bot role that runs the restore. Skipping them is lossless: the dump's own
 * `CREATE EXTENSION IF NOT EXISTS` still runs, and the comment is only a description.
 *
 * Lines are commented out rather than removed so psql error line numbers still match the
 * file on disk. COPY data rows are passed through untouched because a row can begin with
 * the same words as a statement.
 */
export function createExtensionOwnerFilter(): (line: string) => string {
  let inCopyData = false;

  return (line) => {
    if (inCopyData) {
      if (COPY_END.test(line)) inCopyData = false;
      return line;
    }
    if (COPY_START.test(line)) {
      inCopyData = true;
      return line;
    }
    // A statement that does not end on this line (a multi-line comment literal) is left
    // alone, since commenting out only its first line would corrupt the SQL that follows.
    if (EXTENSION_OWNER_STATEMENT.test(line) && line.trimEnd().endsWith(";")) {
      return `-- ${line}`;
    }
    return line;
  };
}

/** Streams a plain-SQL dump through `createExtensionOwnerFilter` without loading it into memory. */
export function createRestoreDumpStream(dumpPath: string): ReadableStream<Uint8Array> {
  const filter = createExtensionOwnerFilter();
  let pending = "";

  return Bun.file(dumpPath)
    .stream()
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          const lines = (pending + chunk).split("\n");
          pending = lines.pop() ?? "";
          if (lines.length > 0) controller.enqueue(`${lines.map(filter).join("\n")}\n`);
        },
        flush(controller) {
          if (pending.length > 0) controller.enqueue(filter(pending));
        },
      }),
    )
    .pipeThrough(new TextEncoderStream());
}
