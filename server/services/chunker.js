// Split extracted text into retrieval-sized chunks while keeping a stable,
// citable location for every chunk.
//
// Chunking quality is what retrieval quality rides on, so there is ONE code
// path here with per-kind tuning (`KIND_PROFILES`) instead of one
// implementation per extractor:
//
//   pdf / pptx / webpage   "prose"       page / slide / paragraph boundaries
//   docx                   "document"    heading + paragraph boundaries
//   youtube                "transcript"  speaker turns: sentences + timecodes
//   image                  "ocr"         noisy text: cleaned, smaller chunks
//
// Pure functions — no I/O, easy to test.
//
// Invariant kept from v1: a chunk never spans two segments. Extractors already
// split PDFs by page, PPTX by slide and webpages by paragraph, and callers rely
// on that (every short paragraph becomes exactly one chunk, which is what the
// `chunkCount >= 5` ingestion test pins).

// server/config.js does not expose chunking knobs, so the numbers live here.
// The `default` profile keeps the historical 800/150 pair. `minLength` drops
// slivers left at a boundary (mainly OCR noise).
const DEFAULT_SIZE = 800; // characters per chunk
const DEFAULT_OVERLAP = 150; // characters repeated between consecutive chunks

const KIND_PROFILES = {
  pdf: { size: DEFAULT_SIZE, overlap: DEFAULT_OVERLAP, minLength: 1, structure: 'prose' },
  pptx: { size: DEFAULT_SIZE, overlap: DEFAULT_OVERLAP, minLength: 1, structure: 'prose' },
  webpage: { size: DEFAULT_SIZE, overlap: DEFAULT_OVERLAP, minLength: 1, structure: 'prose' },
  docx: { size: DEFAULT_SIZE, overlap: DEFAULT_OVERLAP, minLength: 1, structure: 'document' },
  // Spoken transcripts are long and dense, so a slightly smaller window keeps
  // one citation to one thought.
  youtube: { size: 700, overlap: 120, minLength: 1, structure: 'transcript' },
  // OCR text is noisy: keep chunks small so one bad line cannot poison a whole
  // retrieval hit, and drop fragments shorter than a phrase.
  image: { size: 400, overlap: 60, minLength: 20, structure: 'ocr' },
  default: { size: DEFAULT_SIZE, overlap: DEFAULT_OVERLAP, minLength: 1, structure: 'prose' },
};

/**
 * Split segments into chunks.
 *
 * @param {Array<{text?: string, location?: object, kind?: string, section?: string}>} segments
 *   One segment per extractor unit (a PDF page, a slide, a webpage paragraph).
 *   Two OPTIONAL extractor hints, both authoritative: `kind: 'heading'` marks a
 *   segment that IS a heading, and `section` names the heading a segment
 *   belongs to. When they are absent the chunker infers structure from the
 *   text (`looksLikeHeading`), so both are purely additive.
 * @param {object} [options]
 * @param {number} [options.size]        override the profile's characters-per-chunk
 * @param {number} [options.overlap]     override the profile's repeated characters
 * @param {string} [options.sourceKind]  pdf|pptx|webpage|docx|youtube|image — the
 *                                       v8 canonical `sources.source_kind`. It
 *                                       selects the profile, so passing it is
 *                                       what stops a .docx being chunked with the
 *                                       webpage profile (both cite paragraphs).
 * @param {string} [options.sourceId]    stored on every chunk so citations can
 *                                       point back at the source without the
 *                                       model ever supplying an identifier
 * @returns {Array<{text: string, location: object, chunkIndex: number, metadata: object}>}
 *   `location` and `chunkIndex` are unchanged from v1. `metadata` is additive:
 *   the citation fields stored alongside each vector (sourceId, sourceKind,
 *   section, page/slide/paragraph, charStart, charEnd, ordinal, chunkIndex,
 *   timecode for video). `charStart`/`charEnd` cover the chunk's OWN text inside
 *   its segment; when a chunk carries an overlap prefix from the previous chunk,
 *   that prefix sits before `charStart` in `text`. Keys that do not apply are
 *   omitted.
 */
export function chunkSegments(segments, options = {}) {
  const { size, overlap, sourceKind = null, sourceId = null } = options ?? {};
  const chunks = [];

  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment) continue;

    const kind = resolveKind(segment, sourceKind);
    const profile = KIND_PROFILES[kind] ?? KIND_PROFILES.default;
    const chunkSize = positive(size) ?? profile.size;
    const chunkOverlap = positive(overlap) ?? profile.overlap;

    const flat = flatten(segment.text, profile.structure);
    if (flat === '') continue;

    const section = sectionHint(segment);

    // Short segments stay whole: a one-line slide or a webpage paragraph is
    // already exactly the unit a learner wants cited.
    if (flat.length <= chunkSize) {
      chunks.push(makeChunk(segment, kind, sourceId, flat, 0, flat.length, section, chunks.length));
      continue;
    }

    // Long segments are cut on structure first (paragraphs, headings, speaker
    // turns) and only broken mid-paragraph when a single block is oversized.
    const units = markHeadings(splitUnits(flat, profile.structure), profile.structure);
    const expanded = expandOversized(units, chunkSize);
    const packed = packUnits(expanded, {
      size: chunkSize,
      overlap: chunkOverlap,
      minLength: profile.minLength,
      section,
    });
    for (const chunk of packed) {
      chunks.push(makeChunk(segment, kind, sourceId, chunk.text, chunk.charStart, chunk.charEnd, chunk.section, chunks.length));
    }
  }

  return chunks;
}

// ---- kind resolution ---------------------------------------------------------

/** Which tuning profile applies: caller, then segment hint, then location keys. */
function resolveKind(segment, sourceKind) {
  for (const candidate of [sourceKind, segment.kind, segment.sourceKind]) {
    if (typeof candidate === 'string' && KIND_PROFILES[candidate]) return candidate;
  }
  const location = segment.location ?? {};
  if (location.page != null) return 'pdf';
  if (location.slide != null) return 'pptx';
  if (location.timecode != null || location.timestamp != null) return 'youtube';
  if (location.paragraph != null) return 'webpage';
  return 'default';
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** Section carried by the extractor, if any (docx paragraphs may know theirs). */
function sectionHint(segment) {
  const hint = segment.section ?? segment.location?.section ?? null;
  return typeof hint === 'string' && hint.trim() !== '' ? hint.trim() : null;
}

// ---- text preparation --------------------------------------------------------

/**
 * OCR cleanup: table/column pipes, decorative character runs, and lines that
 * carry no letters or digits at all. Exported nowhere — `chunkSegments` is the
 * only entry point.
 */
function cleanOcrText(text) {
  return String(text ?? '')
    .replace(/\|+/g, ' ') // column / box-drawing artefacts
    .replace(/([^\p{L}\p{N}\s])\1{2,}/gu, '$1$1') // "------" → "--"
    .replace(/(\p{L}|\p{N})\1{3,}/gu, '$1$1') // "sooooo" → "soo"
    .split('\n')
    .filter((line) => /[\p{L}\p{N}]/u.test(line)) // drop symbol-only noise lines
    .join('\n');
}

/**
 * Structure-aware whitespace normalisation. The only newlines left in the
 * result are the structural separators the splitter uses, so a chunk's text is
 * always single-spaced — the same shape v1 produced for long segments.
 */
function flatten(text, structure) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  const cleaned = structure === 'ocr' ? cleanOcrText(raw) : raw;

  if (structure === 'prose') {
    // Blank line = new paragraph; single newlines are just line wrapping.
    return cleaned.split(/\n\s*\n/).map(collapse).filter((part) => part !== '').join('\n\n');
  }
  if (structure === 'document' || structure === 'ocr') {
    return cleaned.split('\n').map(collapse).filter((line) => line !== '').join('\n');
  }
  return collapse(cleaned); // transcript: one continuous stream
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// ---- structural units --------------------------------------------------------

const UNIT_SEPARATORS = {
  prose: /\n{2,}/g, // paragraph
  document: /\n/g, // line (headings sit on their own line)
  transcript: /(?=\[\d{1,2}:\d{2}(?::\d{2})?\])/g, // [00:12:30] timecode
  ocr: /\n/g, // OCR line: the most reliable unit available
};

/** Split normalised text into units, keeping each unit's offset in the text. */
function splitUnits(text, structure) {
  const separator = UNIT_SEPARATORS[structure] ?? UNIT_SEPARATORS.prose;
  const units = [];
  let start = 0;
  for (const match of text.matchAll(separator)) {
    pushUnit(units, text, start, match.index);
    start = match.index + match[0].length; // zero-width lookahead → start = match.index
  }
  pushUnit(units, text, start, text.length);
  return units;
}

function pushUnit(units, text, from, to) {
  const unit = trimmedUnit(text.slice(from, to), from);
  if (unit) units.push(unit);
}

/**
 * A unit trimmed of surrounding whitespace, with its TRUE offset inside the
 * parent text (`base` is where the slice started). Shared by the unit, sentence
 * and hard-split paths so a chunk's charStart/charEnd always point at the text
 * that is actually stored.
 */
function trimmedUnit(raw, base) {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const lead = raw.indexOf(trimmed);
  return {
    text: trimmed,
    start: base + lead,
    end: base + lead + trimmed.length,
    isHeading: false,
  };
}

/**
 * A heading-looking unit: short, no sentence-ending punctuation, and either an
 * explicit marker (#, "1.2 Title") or a fully capitalised line. Applying this
 * to paragraph units only is what keeps a sentence inside a paragraph from
 * ever being mistaken for a heading.
 */
function looksLikeHeading(text) {
  const line = text.trim();
  if (line === '' || line.length > 80) return false;
  if (/[.!?;:,]$/.test(line)) return false; // sentences end in punctuation
  if (/^#{1,6}\s+\S/.test(line)) return true; // markdown heading
  if (/^\d+(?:\.\d+)+[.)]?\s+\S/.test(line)) return true; // "1.2 Title"
  if (/^\d{1,2}[.)]\s+\S/.test(line)) return true; // "1. Title"

  const words = line.split(/\s+/);
  if (words.length > 12) return false;
  if (!/[A-Za-z]/.test(line)) return false; // digits/symbols only
  // "Chapter 1 Introduction" counts: a leading digit is a section number, not
  // a word that broke the Title Case.
  const startsAWord = (word) => /^[A-Z]/.test(word) || /^\d/.test(word);
  const capitalised = words.filter(startsAWord).length;
  return capitalised === words.length || (line === line.toUpperCase() && /[A-Z]/.test(line));
}

function markHeadings(units, structure) {
  if (structure !== 'document' && structure !== 'prose') return units;
  return units.map((unit) => (looksLikeHeading(unit.text) ? { ...unit, isHeading: true } : unit));
}

// ---- oversized units ---------------------------------------------------------

/**
 * Paragraph integrity: a unit larger than one chunk is split at sentence
 * boundaries; a single sentence larger than one chunk is cut on characters as
 * a last resort.
 */
function expandOversized(units, size) {
  const out = [];
  for (const unit of units) {
    if (unit.text.length <= size) {
      out.push(unit);
      continue;
    }
    const sentences = sentencesWithOffsets(unit.text, unit.start);
    if (sentences.length === 0) {
      out.push(...hardSplit(unit, size));
      continue;
    }
    for (const sentence of sentences) {
      if (sentence.text.length <= size) out.push(sentence);
      else out.push(...hardSplit(sentence, size));
    }
  }
  return out;
}

/** Sentence units with offsets, sentence-ending punctuation attached. */
function sentencesWithOffsets(text, offset) {
  const sentences = [];
  const regex = /[^.!?]+[.!?]*/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const sentence = trimmedUnit(match[0], offset + match.index);
    if (sentence) sentences.push(sentence);
  }
  return sentences;
}

function hardSplit(unit, size) {
  const pieces = [];
  for (let from = 0; from < unit.text.length; from += size) {
    const piece = trimmedUnit(unit.text.slice(from, from + size), unit.start + from);
    if (piece) pieces.push(piece);
  }
  return pieces;
}

// ---- packing -----------------------------------------------------------------

/**
 * Greedily pack units into chunks of at most `size` characters. A heading
 * always starts a new chunk; every other chunk continues the section it
 * belongs to. Consecutive chunks share an overlap tail cut at a sentence
 * boundary so meaning is not sliced mid-thought.
 */
function packUnits(units, { size, overlap, minLength = 1, section = null }) {
  const chunks = [];
  let prefix = ''; // overlap carried in from the previous chunk
  let core = ''; // the current chunk's own text
  let charStart = null;
  let charEnd = null;
  let lastHeading = section; // section the next chunk belongs to
  let chunkSection = section;
  let startsAtHeading = false;

  const flush = () => {
    const body = core.trim();
    if (body.length >= minLength) {
      // A chunk that opens with its own heading needs no overlap prefix: the
      // heading is the context, and leading with the previous paragraph's tail
      // would put the heading in the middle of the chunk.
      const keepPrefix = prefix !== '' && !startsAtHeading;
      chunks.push({
        text: keepPrefix ? `${prefix} ${core}`.trim() : body,
        charStart,
        charEnd,
        section: chunkSection,
      });
    }
  };

  for (const unit of units) {
    if (unit.isHeading) lastHeading = unit.text;

    const separated = core === '' ? 0 : core.length + 1 + unit.text.length;
    if (core !== '' && (separated > size || unit.isHeading)) {
      const body = core.trim();
      flush();
      prefix = overlapTail(body, overlap);
      core = '';
    }
    if (core === '') {
      charStart = unit.start;
      chunkSection = lastHeading;
      startsAtHeading = unit.isHeading;
    }
    core = core === '' ? unit.text : `${core} ${unit.text}`;
    charEnd = unit.end;
  }
  flush();

  return chunks;
}

/** Tail of a chunk reused as context by the next one (cut after ". "). */
function overlapTail(text, overlap) {
  const tail = text.slice(Math.max(0, text.length - overlap));
  const boundary = tail.indexOf('. ');
  return boundary > -1 ? tail.slice(boundary + 2) : tail;
}

// ---- chunk construction ------------------------------------------------------

/**
 * One chunk. `location` and `chunkIndex` are the v1 shape; `metadata` is the
 * citation surface. Keys that do not apply are omitted rather than stored as
 * null — the vector stores (Chroma in particular) reject null metadata values.
 *
 * `timecode`/`timestamp` (video) are copied from the segment's location so a
 * citation never has to parse the passage text to learn its timestamp.
 */
function makeChunk(segment, sourceKind, sourceId, text, charStart, charEnd, section, ordinal) {
  const location = segment.location;
  return {
    text,
    location,
    chunkIndex: ordinal,
    metadata: {
      ...(sourceId != null ? { sourceId } : {}),
      sourceKind,
      ...(section != null ? { section } : {}),
      ...(location?.page != null ? { page: location.page } : {}),
      ...(location?.slide != null ? { slide: location.slide } : {}),
      ...(location?.paragraph != null ? { paragraph: location.paragraph } : {}),
      ...(location?.timecode != null ? { timecode: location.timecode } : {}),
      ...(location?.timestamp != null ? { timestamp: location.timestamp } : {}),
      charStart,
      charEnd,
      ordinal,
      chunkIndex: ordinal, // mirrors chunkIndex so a metadata spread keeps the id
    },
  };
}
