// Rebuild the vector index from the extracted text stored in SQLite.
// Needed after changing NIM_EMBED_MODEL (vectors from different models cannot
// be mixed). No re-uploading required.
//
//   npm run reindex                    rebuild every source, every owner
//   npm run reindex -- --user u1       rebuild only owner u1's sources
//   npm run reindex -- --dry-run       report what would change, write nothing
//
// Safety rules this script follows:
//   - It never drops the whole collection. Each source is rebuilt in place.
//   - Replacement vectors are embedded BEFORE the old ones are deleted, so a
//     failed embedding call never costs existing data.
//   - A source with no stored text in `source_segments` cannot be recreated, so
//     it is skipped and its existing vectors are left untouched.
//   - The embed-model bookkeeping is only rewritten after a clean, complete
//     rebuild; a mixed index keeps reporting the model it is actually mixed
//     with, instead of claiming to be coherent.

import { assertConfig, config } from '../server/config.js';
import { openDb, getMeta, setMeta, parseJsonObject } from '../server/store/sqlite.js';
import { chunkSegments } from '../server/services/chunker.js';
import { embedTexts } from '../server/services/embeddings.js';
import { resolveVectorStore } from '../server/store/vectorProvider.js';

assertConfig();

const EMBED_BATCH = 32; // matches services/embeddings.js so NIM sees familiar batches

const USAGE = `Usage: npm run reindex [-- --user <userId>] [--dry-run]

  --user <userId>  only rebuild sources owned by this user (default: everyone)
  --dry-run        report what would change and write nothing`;

/** Reads --user <id> / --user=<id> from the CLI arguments; null when absent. */
function readUserFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user') return argv[i + 1] ?? '';
    if (argv[i].startsWith('--user=')) return argv[i].slice('--user='.length);
  }
  return null;
}

/** Keep only the primitive location fields (page, slide, section, timecode,
 *  charStart/charEnd, ordinal, …) so reindex round-trips every source kind
 *  without special-casing any of them. The stores sanitize again on write. */
function flattenLocation(location) {
  const flat = {};
  if (!location || typeof location !== 'object' || Array.isArray(location)) return flat;
  for (const [key, value] of Object.entries(location)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') flat[key] = value;
  }
  return flat;
}

/** Remove one source's current vectors. Never "everything": an empty source id
 *  is rejected, and the fallback id list only covers this source's own ids. */
async function removeOldVectors(vector, source, newChunkCount) {
  if (typeof vector.deleteBySource === 'function') {
    await vector.deleteBySource(source.id, source.user_id ?? undefined);
    return;
  }
  const oldCount = Math.max(Number(source.chunk_count) || 0, newChunkCount);
  await vector.deleteChunks(Array.from({ length: oldCount }, (_, k) => `${source.id}_${k}`));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const dryRun = argv.includes('--dry-run');
  const userId = readUserFlag(argv);
  if (userId !== null && userId.trim() === '') {
    console.error(`--user needs a user id.\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const unknown = argv.filter((a) => a.startsWith('-') && a !== '--dry-run' && a !== '--help' && a !== '-h' && a !== '--user' && !a.startsWith('--user='));
  if (unknown.length > 0) console.warn(`Ignoring unrecognized option(s): ${unknown.join(', ')}`);

  const db = await openDb();
  // The same store the app resolves with the configured VECTOR_STORE setting:
  // reindexing must never write to a different backend than the server reads.
  const vector = resolveVectorStore(db);
  const startedOn = vector.backend;

  const storedModel = await getMeta(db, 'embed_model');
  const storedDim = Number(await getMeta(db, 'embed_dimension')) || 0;
  if (storedModel && storedModel !== config.nimEmbedModel) {
    console.log(`Note: the existing index was built with "${storedModel}"; rebuilding with "${config.nimEmbedModel}".`);
  }

  console.log(`Reindexing with embedding model: ${config.nimEmbedModel}`);
  console.log(`Vector backend: ${startedOn}${dryRun ? ' (dry run — nothing will be written)' : ''}`);
  if (userId) console.log(`Owner filter: ${userId}`);

  // Chroma is a deliberate target for a maintenance command: if it is not
  // reachable we REFUSE (instead of quietly writing the rebuild into the SQLite
  // fallback, where the running app would never read it). The app itself does
  // fall back at runtime — that is a different trade-off from a rebuild.
  //
  // A Chroma collection also bakes in the vector size, so a model change that
  // alters the size cannot be repaired by re-adding rows. Both checks run
  // BEFORE anything is deleted.
  if (!dryRun && startedOn === 'chroma') {
    try {
      await vector.pingChroma();
    } catch (err) {
      console.error(`\nChroma is not reachable (${err?.message ?? err}).\nStart the Chroma server first, or run with VECTOR_STORE=sqlite to rebuild the SQLite fallback store.\nNothing was changed.`);
      process.exitCode = 1;
      return;
    }
    if (storedDim > 0) {
      const [probe] = await embedTexts(['dimension probe']);
      if (probe?.length && probe.length !== storedDim) {
        console.error(
          `\nThe stored index holds ${storedDim}-dimension vectors but "${config.nimEmbedModel}" produces ${probe.length}.\n`
          + 'A Chroma collection keeps its vector size, so it must be recreated first:\n'
          + `  1. delete the Chroma collection "${config.chromaCollection}" (Chroma CLI/API), or point CHROMA_COLLECTION at a new name\n`
          + '  2. run this command again.\n'
          + 'Nothing was deleted.',
        );
        process.exitCode = 1;
        return;
      }
    }
  }

  const sources = userId
    ? await db.all('SELECT * FROM sources WHERE user_id = ? ORDER BY created_at', userId)
    : await db.all('SELECT * FROM sources ORDER BY created_at');
  if (sources.length === 0) {
    console.log(userId ? `No sources found for owner "${userId}".` : 'No sources found — nothing to rebuild.');
    return;
  }

  const skipped = [];
  let rebuiltSources = 0;
  let totalChunks = 0;
  let rebuiltEmbeddingSize = 0;

  for (const source of sources) {
    const owner = source.user_id ?? 'default';
    const segments = (await db.all('SELECT location, text FROM source_segments WHERE source_id = ? ORDER BY seg_index', source.id))
      .map((row) => ({ text: row.text, location: parseJsonObject(row.location) }));

    if (segments.length === 0) {
      skipped.push({ source, reason: 'no stored text to re-chunk' });
      console.log(`  SKIP  ${source.title} — no stored text; its ${source.chunk_count ?? 0} existing vector(s) were left untouched.`);
      continue;
    }

    // v8 stores the canonical kind in `sources.source_kind` (legacy `type` kept
    // for the API payload). Pass it so the chunker picks the right profile for
    // every Wave-4 kind, and keep `type` in the metadata for citations.
    const sourceKind = source.source_kind ?? source.type ?? 'pdf';
    const chunks = chunkSegments(segments, { sourceId: source.id, sourceKind });
    if (chunks.length === 0) {
      skipped.push({ source, reason: 'stored text produced no chunks' });
      console.log(`  SKIP  ${source.title} — stored text produced no chunks; existing vectors untouched.`);
      continue;
    }

    const ids = chunks.map((c) => `${source.id}_${c.chunkIndex}`);
    const documents = chunks.map((c) => c.text);
    // The chunker owns the citation surface (sourceId, sourceKind, section,
    // page/slide/paragraph, charStart, charEnd, ordinal, chunkIndex); carry it
    // through untouched so every source kind round-trips identically. The
    // store-level sanitizer is the last line of defence.
    const metadatas = chunks.map((c) => ({
      type: source.type,
      title: source.title,
      ...(source.url ? { url: source.url } : {}),
      ...(c.metadata ?? flattenLocation(c.location)),
    }));

    if (dryRun) {
      console.log(`  WOULD REBUILD ${source.title} — ${chunks.length} chunk(s) for owner ${owner} (was ${source.chunk_count ?? 0}).`);
      rebuiltSources += 1;
      totalChunks += chunks.length;
      continue;
    }

    // Embed first: a failure here leaves the existing vectors in place.
    const embeddings = [];
    for (let i = 0; i < documents.length; i += EMBED_BATCH) {
      embeddings.push(...await embedTexts(documents.slice(i, i + EMBED_BATCH)));
    }
    if (embeddings.length !== documents.length) {
      throw new Error(`The embedding service returned ${embeddings.length} vectors for ${documents.length} chunks; nothing was deleted for this source.`);
    }

    await removeOldVectors(vector, source, chunks.length);
    for (let i = 0; i < ids.length; i += EMBED_BATCH) {
      await vector.addChunks({
        userId: owner,
        ids: ids.slice(i, i + EMBED_BATCH),
        embeddings: embeddings.slice(i, i + EMBED_BATCH),
        documents: documents.slice(i, i + EMBED_BATCH),
        metadatas: metadatas.slice(i, i + EMBED_BATCH),
      });
    }
    await db.run('UPDATE sources SET chunk_count = ? WHERE id = ?', chunks.length, source.id);

    rebuiltSources += 1;
    totalChunks += chunks.length;
    rebuiltEmbeddingSize = embeddings[0]?.length ?? rebuiltEmbeddingSize;
    console.log(`  ${source.title}: ${chunks.length} chunk(s) for owner ${owner}`);
  }

  if (!dryRun && startedOn === 'chroma' && vector.backend !== 'chroma') {
    console.warn('Chroma became unreachable during the rebuild — the vectors went to the SQLite fallback instead.');
  }

  // Bookkeeping: a full rebuild records the new model; a scoped rebuild (or one
  // with skipped sources) must NOT claim the whole index is coherent.
  if (!dryRun && totalChunks > 0 && skipped.length === 0 && !userId) {
    await setMeta(db, 'embed_model', config.nimEmbedModel);
    if (rebuiltEmbeddingSize > 0) await setMeta(db, 'embed_dimension', String(rebuiltEmbeddingSize));
    console.log(`Recorded embedding metadata: model=${config.nimEmbedModel}, dimension=${rebuiltEmbeddingSize || 'unchanged'}.`);
  } else if (!dryRun && skipped.length > 0) {
    console.warn(`Left the embedding-model metadata unchanged: ${skipped.length} source(s) could not be rebuilt, so the index stays mixed. Re-upload those sources, then run this again.`);
  } else if (!dryRun && userId && rebuiltSources > 0) {
    console.warn(`Left the embedding-model metadata unchanged: this was a scoped rebuild of "${userId}"; other owners' vectors are untouched. Run without --user once every source can be rebuilt.`);
  }

  console.log(`\nDone${dryRun ? ' (dry run — nothing written)' : ''}.`);
  console.log(`  sources rebuilt: ${rebuiltSources} of ${sources.length}`);
  console.log(`  chunks indexed:  ${totalChunks}`);
  if (skipped.length > 0) {
    console.log('  sources skipped (no recreatable text):');
    for (const { source, reason } of skipped) console.log(`    - ${source.id} "${source.title}" (owner ${source.user_id ?? 'default'}): ${reason}`);
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((err) => {
  console.error(`\nReindex failed: ${err?.message ?? err}`);
  if (err?.code === 'VECTOR_DIMENSION_MISMATCH') {
    console.error('The vector store holds a different vector size than the current model produces. See the instructions above and recreate the collection if it is Chroma.');
  }
  process.exit(1);
});
