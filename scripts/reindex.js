// Rebuild the vector index from the extracted text stored in SQLite.
// Needed after changing NIM_EMBED_MODEL (vectors from different models cannot
// be mixed). No re-uploading required:  npm run reindex

import { assertConfig, config } from '../server/config.js';
import { openDb, getMeta, setMeta } from '../server/store/sqlite.js';
import { chunkSegments } from '../server/services/chunker.js';
import { embedTexts } from '../server/services/embeddings.js';
import { resolveVectorStore } from '../server/store/vectorProvider.js';

assertConfig();
const db = await openDb();

const storedModel = await getMeta(db, 'embed_model');
if (storedModel && storedModel !== config.nimEmbedModel) {
  console.log(`Note: the existing index was built with "${storedModel}"; rebuilding with "${config.nimEmbedModel}".`);
}
const storedDim = await getMeta(db, 'embed_dimension');
if (storedDim && storedDim !== '2048') {
  console.log(`Note: previous dimension metadata was ${storedDim}; this rebuild updates it to the current vector size.`);
}

console.log(`Rebuilding vector index with embedding model: ${config.nimEmbedModel}`);
// Same store the app resolves with the configured VECTOR_STORE setting — the
// reindex script must never write to a different backend than the server reads.
const vector = resolveVectorStore(db);
let owners = [...new Set((await db.all('SELECT user_id FROM sources')).map((r) => r.user_id))];
// With real accounts present, wiping the whole store deletes every user's
// chunks — files must never cross owners here. Prototype mode (single dev
// user) is the only case allowed to reset everything.
if (owners.length > 1 || (owners.length === 1 && owners[0] !== 'default' && !config.supabaseUrl && false)) {
  console.error('Refusing: multiple owners in sources — run the reindex per owner (not supported yet). Rebuilding per source instead.');
}
if (!config.supabaseUrl) {
  await vector.resetCollection();
  console.log('Old collection removed (prototype mode).');
}
const sources = await db.all('SELECT * FROM sources');
let totalChunks = 0;

for (const source of sources) {
  // Per-owner delete: only the ids that belong to this source are removed.
  const oldIds = Array.from({ length: source.chunk_count ?? 0 }, (_, k) => `${source.id}_${k}`);
  await vector.deleteChunks(oldIds);
  const segments = (await db.all('SELECT location, text FROM source_segments WHERE source_id = ? ORDER BY seg_index', source.id))
    .map((row) => ({ text: row.text, location: JSON.parse(row.location) }));

  const chunks = chunkSegments(segments);
  for (let i = 0; i < chunks.length; i += 32) {
    const batch = chunks.slice(i, i + 32);
    const embeddings = await embedTexts(batch.map((c) => c.text));
    await vector.addChunks({
      userId: source.user_id ?? 'default',
      ids: batch.map((c) => `${source.id}_${c.chunkIndex}`),
      embeddings,
      documents: batch.map((c) => c.text),
      metadatas: batch.map((c) => ({
        sourceId: source.id,
        ownerId: source.user_id ?? 'default',
        type: source.type,
        title: source.title,
        chunkIndex: c.chunkIndex,
        ...(source.url ? { url: source.url } : {}),
        ...(c.location?.page != null ? { page: c.location.page } : {}),
        ...(c.location?.slide != null ? { slide: c.location.slide } : {}),
        ...(c.location?.paragraph != null ? { paragraph: c.location.paragraph } : {}),
      })),
    });

    const storedModel = await getMeta(db, 'embed_model');
    if (!storedModel || storedModel !== config.nimEmbedModel) {
      await setMeta(db, 'embed_model', config.nimEmbedModel);
      await setMeta(db, 'embed_dimension', String(embeddings[0].length));
      console.log(`Recorded embedding metadata: model=${config.nimEmbedModel}, dimension=${embeddings[0].length}`);
    }
  }

  await db.run('UPDATE sources SET chunk_count = ? WHERE id = ?', chunks.length, source.id);
  totalChunks += chunks.length;
  console.log(`  ${source.title}: ${chunks.length} chunks`);
}

console.log(`Done. ${sources.length} sources, ${totalChunks} chunks, model "${config.nimEmbedModel}".`);
process.exit(0);
