// Split extracted text into retrieval-sized chunks while keeping the page,
// slide, or paragraph location of every character range.
// Pure functions — no I/O, easy to test.

const DEFAULT_SIZE = 800; // characters per chunk
const DEFAULT_OVERLAP = 150; // characters repeated between consecutive chunks

function splitSentences(text) {
  // Keep sentence-ending punctuation attached; treat single newlines as breaks too.
  return text
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]*\s*/g) ?? [];
}

export function chunkSegments(segments, { size = DEFAULT_SIZE, overlap = DEFAULT_OVERLAP } = {}) {
  const chunks = [];
  let chunkIndex = 0;

  for (const segment of segments) {
    const text = (segment.text ?? '').trim();
    if (text === '') continue;

    // Very short segments stay whole (e.g. a one-line slide).
    if (text.length <= size) {
      chunks.push({ text, location: segment.location, chunkIndex: chunkIndex++ });
      continue;
    }

    const sentences = splitSentences(text);
    let current = '';

    for (const sentence of sentences) {
      if (current.length + sentence.length > size && current !== '') {
        chunks.push({ text: current.trim(), location: segment.location, chunkIndex: chunkIndex++ });
        // Start the next chunk with the tail of the previous one (overlap),
        // cut at a sentence boundary so meaning is not sliced mid-thought.
        const tail = current.slice(Math.max(0, current.length - overlap));
        const boundary = tail.indexOf('. ');
        current = (boundary > -1 ? tail.slice(boundary + 1) : tail) + sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim() !== '') {
      chunks.push({ text: current.trim(), location: segment.location, chunkIndex: chunkIndex++ });
    }
  }

  return chunks;
}
