// Mock fixtures — frontend-only demo data shaped exactly like docs/API_CONTRACT.md.
//
// Reached only when mock mode is on (?mock=1 or localStorage.socius_mock = '1'),
// and always labelled "Demo data" in the UI. Nothing here pretends to be a real
// AI answer: it is canned text, and the tutor abstains path is reproduced honestly.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const httpError = (code, message, status) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const LETTERS = ['a', 'b', 'c', 'd'];
const CHAT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';

/** Small pieces the routes below share. */
const nowIso = () => new Date().toISOString();
const demoId = (kind) => `${kind}_demo${Math.random().toString(36).slice(2, 8)}`;
const countUnsorted = (list) => list.filter((item) => !item.sessionId).length;
const sessionTitleOf = (sessionId) => (sessionById(sessionId) || {}).title || null;
const activity = (type, topic, detail, daysAgo) => ({ type, topic, detail, at: iso(daysAgo) });

/** A stored row by id, or the contract's 404. */
function findById(list, id, code, message) {
  const found = list.find((item) => item.id === id);
  if (!found) throw httpError(code, message, 404);
  return found;
}

const requireSource = (id) => findById(db.sources, id, 'SOURCE_NOT_FOUND', 'That study material no longer exists.');
const requireSession = (id) => findById(db.sessions, id, 'SESSION_NOT_FOUND', 'That study session no longer exists.');
const requireDeck = (id) => findById(db.decks, id, 'DECK_NOT_FOUND', 'That deck no longer exists.');

/** `?sort=` for either list: alpha by title, active by last use, else newest first. */
function sortRecords(list, sort, fields) {
  const copy = list.slice();
  if (sort === 'alpha') return copy.sort((a, b) => String(fields.title(a)).localeCompare(String(fields.title(b)), undefined, { sensitivity: 'base' }));
  if (sort === 'active') return copy.sort((a, b) => String(fields.active(b) || '').localeCompare(String(fields.active(a) || '')));
  return copy.sort((a, b) => String(fields.recent(b)).localeCompare(String(fields.recent(a))));
}

/** One stored deck card: the fixture card's fields plus its review state. */
const deckCardRow = (stateOf) => (card, idx) => ({
  idx, front: card.front, back: card.back, citations: card.citations, ...stateOf(idx),
});

/** The topic two AI routes share: 2–80 trimmed characters, one message. */
function topicFrom(body) {
  const topic = (body.topic || '').trim();
  if (topic.length < 2 || topic.length > 80) {
    throw httpError('VALIDATION_ERROR', 'Topic must be between 2 and 80 characters.', 400);
  }
  return topic;
}

/* ------------------------------------------------------------- fixtures */

const SOURCES = [
  { id: 'src_demo01', type: 'pdf', title: 'biology-photosynthesis.pdf', sizeLabel: '14 pages', chunkCount: 42, pageCount: 14, slideCount: null, createdAt: iso(-2), sessionId: 'ses_demo01', tags: [], orgSource: 'manual' },
  { id: 'src_demo02', type: 'pptx', title: 'lecture-04-cells.pptx', sizeLabel: '28 slides', chunkCount: 56, pageCount: null, slideCount: 28, createdAt: iso(-4), sessionId: 'ses_demo01', tags: ['cells'], orgSource: 'ai' },
  { id: 'src_demo03', type: 'webpage', title: 'Khan Academy — Cell respiration', sizeLabel: 'webpage', chunkCount: 18, pageCount: null, slideCount: null, createdAt: iso(-6), sessionId: null, tags: [], orgSource: 'manual' },
];

/* -------------------------------------------------- v1.1: sessions & decks */

// Mutable in-memory demo database. Mutations (creating a session, moving a
// source, marking a card) last for the page session only — like a real
// backend they are never presented as anything but demo data.
const db = {
  sessions: [
    { id: 'ses_demo01', title: 'Biology — Cell unit', category: 'subject', description: 'First-year cell biology: structure, division and energy.', tags: ['cells', 'exam'], status: 'active', createdAt: iso(-6), updatedAt: iso(-1) },
    { id: 'ses_demo02', title: 'Research — Photosynthesis', category: 'research', description: 'Sources and notes for the photosynthesis paper.', tags: ['photosynthesis'], status: 'active', createdAt: iso(-5), updatedAt: iso(-3) },
    { id: 'ses_demo03', title: 'Exam prep — Semester finals', category: 'exam-prep', description: '', tags: ['finals'], status: 'active', createdAt: iso(-2), updatedAt: iso(-2) },
  ],
  sources: SOURCES,
  decks: [
    { id: 'deck_demo01', topic: 'Photosynthesis basics', sessionId: 'ses_demo01', category: 'subject', cardCount: 5, knownCount: 3, reviewCount: 1, createdAt: iso(-3), lastReviewedAt: iso(-1) },
    { id: 'deck_demo02', topic: 'Cell respiration overview', sessionId: null, category: null, cardCount: 4, knownCount: 0, reviewCount: 0, createdAt: iso(-2), lastReviewedAt: null },
  ],
  deckCards: new Map(), // deckId → [{ idx, front, back, citations, status, reviewedAt }]
  suggestions: new Map(), // sourceId → suggestion (stored server-side, like the real backend)
  // v1.4 singleton learner profile — one per installation, resets with this
  // demo database when the page reloads (same lifecycle as sessions/decks).
  profile: freshProfile(),
};

const CATEGORY_VALUES = ['subject', 'research', 'self-study', 'exam-prep', 'general'];

function sessionById(id) { return db.sessions.find((session) => session.id === id) || null; }

function sessionWithCounts(session) {
  return {
    ...session,
    sourceCount: db.sources.filter((source) => source.sessionId === session.id).length,
    deckCount: db.decks.filter((deck) => deck.sessionId === session.id).length,
    lastActivityAt: db.decks
      .filter((deck) => deck.sessionId === session.id && deck.lastReviewedAt)
      .map((deck) => deck.lastReviewedAt)
      .sort()
      .pop() || null,
  };
}

/** Throw SESSION_EMPTY when a session-scoped AI call has no material. */
function assertSessionHasSources(sessionId) {
  const session = requireSession(sessionId);
  if (db.sources.filter((source) => source.sessionId === sessionId).length === 0) {
    throw httpError('SESSION_EMPTY', `No material in «${session.title}» yet. Add a file or web page first.`, 400);
  }
}

function iso(daysAgo) {
  return new Date(Date.now() + daysAgo * 86400000).toISOString();
}

const citation = (over = {}) => ({
  sourceId: 'src_demo01',
  type: 'pdf',
  title: 'biology-photosynthesis.pdf',
  url: null,
  location: { page: 12 },
  excerpt: 'Chlorophyll absorbs light energy in the thylakoid membrane, where the light-dependent reactions convert water into oxygen, ATP, and NADPH.',
  score: 0.81,
  ...over,
});

const PHOTOSYNTHESIS_ANSWER = {
  answer: 'Photosynthesis happens in two stages. The light-dependent reactions take place in the thylakoid membranes, where chlorophyll absorbs sunlight and splits water into oxygen, ATP, and NADPH. The light-independent reactions (the Calvin cycle) then run in the stroma, using that ATP and NADPH to fix carbon dioxide into sugar.',
  citations: [
    citation(),
    citation({ sourceId: 'src_demo02', type: 'pptx', title: 'lecture-04-cells.pptx', location: { slide: 9 }, excerpt: 'The thylakoid membrane hosts photosystem II and photosystem I; the stroma hosts the Calvin cycle enzymes.', score: 0.76 }),
  ],
  model: CHAT_MODEL,
  needsContent: false,
};

const MITOSIS_ANSWER = {
  answer: 'Mitosis produces two genetically identical daughter cells and keeps the chromosome number the same, so it is used for growth and repair. Meiosis produces four genetically different cells with half the chromosome number, which is what makes sexual reproduction possible.',
  citations: [
    citation({ sourceId: 'src_demo02', type: 'pptx', title: 'lecture-04-cells.pptx', location: { slide: 17 }, excerpt: 'Mitosis: one division, two identical diploid cells. Meiosis: two divisions, four unique haploid cells.', score: 0.84 }),
  ],
  model: CHAT_MODEL,
  needsContent: false,
};

const ABSTAIN_ANSWER = {
  answer: "I couldn't find enough in your study materials to answer that. Try adding material on this topic, or ask about a topic covered in your sources.",
  citations: [],
  model: CHAT_MODEL,
  needsContent: true,
};

const DEMO_BACKS = [
  'Chlorophyll is the pigment that absorbs light energy, mostly in the blue and red wavelengths, and passes it to the reaction centre of photosystem II.',
  'In the thylakoid membranes of the chloroplast, where photosystems II and I carry out electron transport.',
  'Carbon dioxide, ATP, and NADPH. The cycle fixes CO₂ into G3P using the energy carried by ATP and NADPH.',
  'Oxygen. It comes from the splitting of water during the light-dependent reactions.',
  'When rubisco binds O₂ instead of CO₂, the cycle loses fixed carbon and must burn extra ATP to recover it, which costs energy that would otherwise go to growth.',
  'It holds the enzymes of the Calvin cycle, including rubisco, so carbon fixation happens in the fluid surrounding the thylakoids.',
  '6CO₂ + 6H₂O + light energy → C₆H₁₂O₆ + 6O₂.',
  'They spatially separate initial carbon fixation from rubisco, so rubisco never sees a high O₂ concentration.',
];

const FLASHCARD_FRONTS = [
  'What role does chlorophyll play in photosynthesis?',
  'Where do the light-dependent reactions take place?',
  'What are the inputs of the Calvin cycle?',
  'What gas is released as a by-product of photosynthesis?',
  'How does photorespiration reduce crop yield?',
  'Why is the stroma important for the light-independent reactions?',
  'What is the overall balanced equation for photosynthesis?',
  'How do C4 plants avoid photorespiration?',
];

const FLASHCARD_CARDS = FLASHCARD_FRONTS.map((front, i) => ({
  id: `card_demo${i + 1}`,
  front,
  back: DEMO_BACKS[i],
  citations: [citation({ location: { page: 10 + i } })],
}));

const QUIZ_QUESTIONS = [
  {
    index: 0,
    text: 'Which pigment absorbs light energy for photosynthesis?',
    choices: choiceSet('Chlorophyll', 'Starch', 'Oxygen', 'Carbon dioxide'),
    citations: [citation()],
  },
  {
    index: 1,
    text: 'Where do the light-dependent reactions take place?',
    choices: choiceSet('Thylakoid membrane', 'Stroma', 'Outer membrane', 'Cytoplasm'),
    citations: [citation({ location: { page: 12 } })],
  },
  {
    index: 2,
    text: 'Which molecule is split to release oxygen during photosynthesis?',
    choices: choiceSet('Carbon dioxide', 'Glucose', 'Water', 'NADPH'),
    citations: [citation({ location: { page: 14 } })],
  },
  {
    index: 3,
    text: 'Which enzyme fixes carbon dioxide in the Calvin cycle?',
    choices: choiceSet('ATP synthase', 'Rubisco', 'Amylase', 'Helicase'),
    citations: [citation({ sourceId: 'src_demo02', type: 'pptx', title: 'lecture-04-cells.pptx', location: { slide: 11 }, excerpt: 'Rubisco catalyses the first step of carbon fixation, attaching CO₂ to ribulose bisphosphate.', score: 0.79 })],
  },
  {
    index: 4,
    text: 'What are the products of the light-dependent reactions used in the Calvin cycle?',
    choices: choiceSet('ATP and NADPH', 'Oxygen and water', 'Starch and sucrose', 'NADH and FADH₂'),
    citations: [citation({ location: { page: 15 } })],
  },
];

function choiceSet(correct, b, c, d) {
  return [correct, b, c, d].map((text, i) => ({ id: LETTERS[i], text }));
}

// Index → the id of the correct choice. Deterministic grading in the fixture,
// exactly like the backend's string comparison against its stored key.
const QUIZ_KEY = ['Chlorophyll', 'Thylakoid membrane', 'Water', 'Rubisco', 'ATP and NADPH'];

const QUIZ_EXPLANATIONS = [
  'Chlorophyll is the pigment that absorbs light; the other options are products or unrelated molecules.',
  'The thylakoid membrane holds the photosystems; the Calvin cycle runs in the stroma.',
  'Water is split in photolysis, which is where the released oxygen comes from.',
  'Rubisco attaches CO₂ to RuBP — the first and rate-limiting step of the Calvin cycle.',
  'The light reactions export ATP and NADPH, which power carbon fixation in the stroma.',
];

function correctIdFor(question) {
  const right = QUIZ_KEY[question.index];
  return question.choices.find((choice) => choice.text === right).id;
}

const PROGRESS = {
  topics: [
    { topic: 'Photosynthesis', masteryPercent: 60, difficulty: 'medium', correct: 3, total: 5, needsRevision: false, lastPracticedAt: iso(-1) },
    { topic: 'Cell division', masteryPercent: 40, difficulty: 'easy', correct: 2, total: 5, needsRevision: true, lastPracticedAt: iso(-3) },
    { topic: 'Cell respiration', masteryPercent: 80, difficulty: 'hard', correct: 4, total: 5, needsRevision: false, lastPracticedAt: iso(-5) },
  ],
  overall: { quizzesTaken: 3, questionsAnswered: 15, accuracyPercent: 60 },
  suggestedNext: { topic: 'Cell division', difficulty: 'easy' },
  recentActivity: [
    activity('quiz', 'Photosynthesis', '3/5 correct (60%)', -1),
    activity('question', null, 'Asked: Where do the light-dependent reactions take place?', -1),
    activity('upload', null, 'biology-photosynthesis.pdf (14 pages)', -2),
    activity('quiz', 'Cell division', '2/5 correct (40%)', -3),
    activity('upload', null, 'lecture-04-cells.pptx (28 slides)', -4),
    activity('quiz', 'Cell respiration', '4/5 correct (80%)', -5),
  ],
};

// Seed deck cards (after FLASHCARD_CARDS is defined, since it is a const).
db.deckCards.set('deck_demo01', FLASHCARD_CARDS.slice(0, 5).map(deckCardRow(
  (idx) => ({ status: idx < 3 ? 'known' : idx === 3 ? 'review' : 'new', reviewedAt: idx < 4 ? iso(-1) : null }),
)));
db.deckCards.set('deck_demo02', FLASHCARD_CARDS.slice(3, 7).map(deckCardRow(
  () => ({ status: 'new', reviewedAt: null }),
)));

/* ------------------------------------- learner profile & onboarding (v1.4) */

const PURPOSE_VALUES = ['exam', 'project', 'research', 'deep-understanding', 'general'];
const STYLE_VALUES = ['step-by-step', 'examples-first', 'visual', 'concise', 'guided-questions'];
const APPROACH_VALUES = [...STYLE_VALUES, 'simpler', 'different'];
const FAMILIARITY_VALUES = ['none', 'basic', 'familiar', 'confident'];

// Whitelist-only extraction, mirroring the contract's "off-list answers are
// simply not stored" rule. Interests are free-form labels, so a small keyword
// bank is enough for the scripted demo interview.
const INTEREST_KEYWORDS = [
  'football', 'games', 'music', 'art', 'drawing', 'reading', 'space',
  'biology', 'chemistry', 'physics', 'history', 'maths', 'mathematics',
  'coding', 'programming',
];

const ONBOARDING_OPENING =
  "Hi! A quick intro so the tutor can teach your way. Your answers are saved in this app's " +
  'database to personalise your learning, and you can view, edit, or delete them any time on the ' +
  'Profile page. First question: which subjects or topics are you most interested in right now? ' +
  '(Demo interview — replies are scripted.)';

const ONBOARDING_FOLLOWUPS = [
  'Noted. What are you working towards at the moment — an exam, a project, research, deep ' +
  'understanding, or just general learning?',
  'Got it. Last question: how do you like things explained — step-by-step, examples first, ' +
  'visual, concise, or guided questions?',
];

const ONBOARDING_CLOSING =
  'All set — your answers are saved. You can review or edit them any time on the Profile page, ' +
  'or use "Restart intro" there to run this again. (Demo interview complete.)';

// Scripted 3-turn interview: interests → goals/purpose → style. `turn` counts
// processed user answers; like db, it resets when the page reloads.
const onboarding = { turn: 0 };

function freshProfile() {
  return { state: 'new', purpose: null, interests: [], goals: [], preferences: {}, subjects: [], updatedAt: null };
}

/** GET/PATCH response shape — a defensive copy, exactly like the contract. */
function profileView() {
  return {
    state: db.profile.state,
    purpose: db.profile.purpose,
    interests: db.profile.interests.map((item) => ({ ...item })),
    goals: db.profile.goals.map((item) => ({ ...item })),
    preferences: Object.fromEntries(
      Object.entries(db.profile.preferences).map(([key, value]) => [key, { ...value }]),
    ),
    subjects: db.profile.subjects.map((item) => ({ ...item })),
    updatedAt: db.profile.updatedAt,
  };
}

function extractInterests(text) {
  const lower = text.toLowerCase();
  for (const keyword of INTEREST_KEYWORDS) {
    if (lower.includes(keyword) && !db.profile.interests.some((item) => item.label === keyword)) {
      db.profile.interests.push({ label: keyword, source: 'stated' });
    }
  }
}

function extractPurpose(text) {
  const lower = text.toLowerCase();
  if (/deep[- ]understanding|understand(ing)? (it|things|this) deeply/.test(lower)) db.profile.purpose = 'deep-understanding';
  else if (lower.includes('exam')) db.profile.purpose = 'exam';
  else if (lower.includes('project')) db.profile.purpose = 'project';
  else if (lower.includes('research')) db.profile.purpose = 'research';
  else if (lower.includes('general')) db.profile.purpose = 'general';
}

function extractExplanationStyle(text) {
  const lower = text.toLowerCase();
  const matches = [
    ['step-by-step', /step[- ]by[- ]step/],
    ['examples-first', /examples?[ -]first|examples/],
    ['visual', /visual|diagrams?|pictures?/],
    ['concise', /concise|short|brief/],
    ['guided-questions', /guided[- ]questions|quiz me/],
  ];
  const hit = matches.find(([, regex]) => regex.test(lower));
  if (hit) db.profile.preferences.explanationStyle = { value: hit[0], source: 'stated' };
}

function onboardingMessage(body) {
  if (db.profile.state === 'completed') {
    throw httpError('ONBOARDING_COMPLETE', 'Onboarding already finished.', 409);
  }
  if (body.message === null) {
    onboarding.turn = 0;
    db.profile.state = 'in_progress';
    return { reply: ONBOARDING_OPENING, state: 'in_progress', questionsAsked: 1, done: false };
  }
  if (typeof body.message !== 'string') {
    throw httpError('VALIDATION_ERROR', 'Send message as a string (1–800 characters) or null to start the interview.', 400);
  }
  const trimmed = body.message.trim();
  if (trimmed.length < 1 || trimmed.length > 800) {
    throw httpError('VALIDATION_ERROR', 'message must be between 1 and 800 characters.', 400);
  }
  if (db.profile.state !== 'in_progress') db.profile.state = 'in_progress';
  return advanceInterview(trimmed);
}

function advanceInterview(message) {
  db.profile.updatedAt = nowIso();
  if (onboarding.turn === 0) {
    extractInterests(message);
    onboarding.turn = 1;
    return { reply: ONBOARDING_FOLLOWUPS[0], state: 'in_progress', questionsAsked: 2, done: false };
  }
  if (onboarding.turn === 1) {
    extractPurpose(message);
    onboarding.turn = 2;
    return { reply: ONBOARDING_FOLLOWUPS[1], state: 'in_progress', questionsAsked: 3, done: false };
  }
  extractExplanationStyle(message);
  onboarding.turn = 3;
  db.profile.state = 'completed';
  return { reply: ONBOARDING_CLOSING, state: 'completed', questionsAsked: 3, done: true };
}

function patchProfile(body) {
  const allowed = ['interests', 'goals', 'purpose', 'preferences', 'subjects'];
  const entries = Object.entries(
    body && typeof body === 'object' && !Array.isArray(body) ? body : {},
  );
  const unknown = entries.map(([key]) => key).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw httpError('VALIDATION_ERROR', `Unknown field(s): ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`, 400);
  }
  const patch = Object.fromEntries(entries.filter(([key]) => allowed.includes(key)));
  if (Object.keys(patch).length === 0) {
    throw httpError('VALIDATION_ERROR', `Provide at least one field to update (${allowed.join(', ')}).`, 400);
  }

  if (patch.interests !== undefined) {
    if (!Array.isArray(patch.interests)) {
      throw httpError('VALIDATION_ERROR', 'interests must be an array of { label }.', 400);
    }
    if (patch.interests.length > 12) {
      throw httpError('VALIDATION_ERROR', 'Up to 12 interests.', 400);
    }
    for (const item of patch.interests) {
      const label = item && typeof item === 'object' ? String(item.label ?? '').trim() : '';
      if (label.length < 1 || label.length > 40) {
        throw httpError('VALIDATION_ERROR', 'Each interest needs a label of 1–40 characters.', 400);
      }
    }
  }

  if (patch.goals !== undefined) {
    if (!Array.isArray(patch.goals)) {
      throw httpError('VALIDATION_ERROR', 'goals must be an array of { label, deadline? }.', 400);
    }
    if (patch.goals.length > 6) {
      throw httpError('VALIDATION_ERROR', 'Up to 6 goals.', 400);
    }
    for (const item of patch.goals) {
      const label = item && typeof item === 'object' ? String(item.label ?? '').trim() : '';
      if (label.length < 1 || label.length > 120) {
        throw httpError('VALIDATION_ERROR', 'Each goal needs a label of 1–120 characters.', 400);
      }
      if (item.deadline !== undefined && item.deadline !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(item.deadline))) {
        throw httpError('VALIDATION_ERROR', 'Goal deadlines must use the YYYY-MM-DD format.', 400);
      }
    }
  }

  if (patch.purpose !== undefined && patch.purpose !== null && !PURPOSE_VALUES.includes(patch.purpose)) {
    throw httpError('VALIDATION_ERROR', `purpose must be one of: ${PURPOSE_VALUES.join(', ')} (or null).`, 400);
  }

  if (patch.preferences !== undefined) {
    const prefs = patch.preferences;
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
      throw httpError('VALIDATION_ERROR', 'preferences must be an object.', 400);
    }
    if (Object.keys(prefs).some((key) => key !== 'explanationStyle')) {
      throw httpError('VALIDATION_ERROR', 'preferences only supports explanationStyle.', 400);
    }
    if (prefs.explanationStyle !== undefined && prefs.explanationStyle !== null
        && !STYLE_VALUES.includes(prefs.explanationStyle)) {
      throw httpError('VALIDATION_ERROR', `explanationStyle must be one of: ${STYLE_VALUES.join(', ')}.`, 400);
    }
  }

  if (patch.subjects !== undefined) {
    if (!Array.isArray(patch.subjects)) {
      throw httpError('VALIDATION_ERROR', 'subjects must be an array of { subject, familiarity, confidence? }.', 400);
    }
    if (patch.subjects.length > 12) {
      throw httpError('VALIDATION_ERROR', 'Up to 12 subjects.', 400);
    }
    for (const item of patch.subjects) {
      const subject = item && typeof item === 'object' ? String(item.subject ?? '').trim() : '';
      if (subject.length < 1 || subject.length > 60) {
        throw httpError('VALIDATION_ERROR', 'Each subject needs a name of 1–60 characters.', 400);
      }
      if (!FAMILIARITY_VALUES.includes(item.familiarity)) {
        throw httpError('VALIDATION_ERROR', `familiarity must be one of: ${FAMILIARITY_VALUES.join(', ')}.`, 400);
      }
      if (item.confidence !== undefined && item.confidence !== null
          && (!Number.isInteger(item.confidence) || item.confidence < 1 || item.confidence > 5)) {
        throw httpError('VALIDATION_ERROR', 'confidence must be a whole number from 1 to 5.', 400);
      }
    }
  }

  // Valid — replace each provided key wholesale, forcing source: "stated"
  // (any client-sent source field is ignored, per the contract).
  db.profile.updatedAt = nowIso();
  if (patch.interests !== undefined) {
    db.profile.interests = patch.interests.map((item) => ({ label: String(item.label).trim(), source: 'stated' }));
  }
  if (patch.goals !== undefined) {
    db.profile.goals = patch.goals.map((item) => ({
      label: String(item.label).trim(),
      ...(item.deadline ? { deadline: String(item.deadline) } : {}),
      source: 'stated',
    }));
  }
  if (patch.purpose !== undefined) db.profile.purpose = patch.purpose;
  if (patch.preferences !== undefined) {
    db.profile.preferences = patch.preferences.explanationStyle
      ? { explanationStyle: { value: patch.preferences.explanationStyle, source: 'stated' } }
      : {};
  }
  if (patch.subjects !== undefined) {
    db.profile.subjects = patch.subjects.map((item) => ({
      subject: String(item.subject).trim(),
      familiarity: item.familiarity,
      confidence: item.confidence ?? null,
      source: 'stated',
    }));
  }
  // Direct profile editing counts as opting out of the intro (contract note).
  if (db.profile.state === 'new') db.profile.state = 'skipped';
  return { profile: profileView() };
}

/* --------------------------------------------------------- mock router */

const submittedQuizzes = new Map(); // quizId → stored result (409 on repeat)
const generatedQuizzes = new Map(); // quizId → { topic, questions }

export async function handleMock(path, { method = 'GET', body = {} } = {}) {
  await sleep(320);
  const [pathname, query = ''] = path.split('?');
  const qp = new URLSearchParams(query);
  const route = `${method} ${pathname}`;

  if (route === 'GET /api/health') {
    return {
      status: 'ok',
      checks: {
        sqlite: { ok: true, message: '' },
        chroma: { ok: true, message: '' },
        nim: { ok: true, message: '', chatModel: CHAT_MODEL, embeddingModel: 'nvidia/nemotron-3-embed-1b' },
        limits: { maxUploadMb: 25 },
      },
    };
  }

  if (route === 'GET /api/sources') {
    const scope = qp.get('sessionId');
    let list = db.sources;
    if (scope === 'unsorted') list = list.filter((source) => !source.sessionId);
    else if (scope) list = list.filter((source) => source.sessionId === scope);
    return { sources: list, unsortedSourceCount: countUnsorted(db.sources) };
  }

  if (route === 'GET /api/learner/progress') return PROGRESS;

  /* -------------------------------------- learner profile & onboarding (v1.4) */

  if (route === 'GET /api/profile') return { profile: profileView() };

  if (route === 'POST /api/onboarding/message') return onboardingMessage(body);

  if (route === 'POST /api/onboarding/skip') {
    if (db.profile.state === 'completed') {
      throw httpError('ONBOARDING_COMPLETE', 'Onboarding already finished.', 409);
    }
    db.profile.state = 'skipped';
    db.profile.updatedAt = nowIso();
    onboarding.turn = 0;
    return { profile: profileView() };
  }

  if (route === 'PATCH /api/profile') return patchProfile(body);

  if (route === 'DELETE /api/profile') {
    db.profile = freshProfile(); // state returns to "new", like the real backend
    onboarding.turn = 0;
    return null; // 204, no body
  }

  if (route === 'POST /api/tutor/ask') {
    const question = (body.question || '').trim();
    if (question.length < 3 || question.length > 300) {
      throw httpError('VALIDATION_ERROR', 'Question must be between 3 and 300 characters.', 400);
    }
    if (body.approach !== undefined && !APPROACH_VALUES.includes(body.approach)) {
      throw httpError('VALIDATION_ERROR', `approach must be one of: ${APPROACH_VALUES.join(', ')}.`, 400);
    }
    if (body.sessionId) assertSessionHasSources(body.sessionId);
    const lower = question.toLowerCase();
    let answer;
    if (/mitosis|meiosis|chromosome/.test(lower)) answer = MITOSIS_ANSWER;
    else if (/quantum|rocket|football|weather/.test(lower)) answer = ABSTAIN_ANSWER;
    else answer = PHOTOSYNTHESIS_ANSWER;
    // v1.4: approachUsed appears only when the learner sent an approach or a
    // personalisation preference exists (contract: "present only when…").
    const approachUsed = body.approach !== undefined
      ? body.approach
      : (db.profile.preferences.explanationStyle || {}).value || null;
    return approachUsed ? { ...answer, approachUsed } : answer;
  }

  if (route === 'POST /api/flashcards/generate') {
    const topic = topicFrom(body);
    const count = body.count ?? 8;
    if (count < 3 || count > 12) {
      throw httpError('VALIDATION_ERROR', 'Count must be between 3 and 12.', 400);
    }
    if (body.sessionId) assertSessionHasSources(body.sessionId);
    await sleep(500);
    const cards = FLASHCARD_CARDS.slice(0, count);
    // v1.1: the deck is persisted (cards + scope), like the real backend.
    const deckId = demoId('deck');
    const parent = body.sessionId ? sessionById(body.sessionId) : null;
    db.decks.unshift({
      id: deckId,
      topic,
      sessionId: body.sessionId || null,
      category: parent ? parent.category : null,
      cardCount: cards.length,
      knownCount: 0,
      reviewCount: 0,
      createdAt: nowIso(),
      lastReviewedAt: null,
    });
    db.deckCards.set(deckId, cards.map(deckCardRow(() => ({ status: 'new', reviewedAt: null }))));
    return { topic, cards, deckId, sessionId: body.sessionId || null, model: 'nvidia/nemotron-3-super-120b-a12b' };
  }

  if (route === 'POST /api/quiz/generate') {
    const topic = topicFrom(body);
    const questionCount = body.questionCount ?? 5;
    if (questionCount < 3 || questionCount > 10) {
      throw httpError('VALIDATION_ERROR', 'questionCount must be between 3 and 10.', 400);
    }
    if (body.sessionId) assertSessionHasSources(body.sessionId);
    await sleep(600);
    const quizId = demoId('quiz');
    const questions = QUIZ_QUESTIONS.slice(0, questionCount);
    generatedQuizzes.set(quizId, { topic, questions });
    return {
      quiz: { id: quizId, topic, difficulty: body.difficulty || 'medium', questions },
    };
  }

  const answerMatch = path.match(/^\/api\/quiz\/([^/]+)\/answer$/);
  if (route === `POST ${path}` && answerMatch) {
    const quizId = answerMatch[1];
    if (submittedQuizzes.has(quizId)) {
      const error = httpError('QUIZ_ALREADY_ANSWERED', 'This quiz was already submitted. Showing your stored result.', 409);
      error.data = {
        error: { code: 'QUIZ_ALREADY_ANSWERED', message: error.message },
        result: submittedQuizzes.get(quizId),
      };
      throw error;
    }
    const generated = generatedQuizzes.get(quizId);
    if (!generated) throw httpError('QUIZ_NOT_FOUND', 'That quiz does not exist.', 404);

    const answers = Array.isArray(body.answers) ? body.answers : [];
    const total = generated.questions.length;
    if (answers.length !== total || answers.some((a, i) => a.index !== i)) {
      throw httpError('VALIDATION_ERROR', 'Provide one answer per question, in order.', 400);
    }

    let correct = 0;
    const questions = generated.questions.map((question, index) => {
      const yourChoiceId = answers[index].choiceId ?? null;
      const correctChoiceId = correctIdFor(question);
      const isCorrect = yourChoiceId === correctChoiceId;
      if (isCorrect) correct += 1;
      return {
        index,
        yourChoiceId,
        correctChoiceId,
        correct: isCorrect,
        explanation: QUIZ_EXPLANATIONS[index],
        citations: question.citations,
      };
    });

    const percent = Math.round((correct / total) * 100);
    const before = 0.6;
    const after = Math.min(1, Math.max(0, before + (percent - 50) / 200));
    const result = {
      score: { correct, total, percent },
      questions,
      masteryUpdate: { topic: generated.topic, before, after, delta: Number((after - before).toFixed(2)) },
      recommendedDifficulty: percent >= 80 ? 'hard' : percent >= 50 ? 'medium' : 'easy',
    };
    submittedQuizzes.set(quizId, result);
    return { result };
  }

  /* ------------------------------------------- source organisation (v1.1) */

  const sourceMatch = pathname.match(/^\/api\/sources\/([^/]+)$/);
  if (sourceMatch && method === 'PATCH') {
    const source = requireSource(sourceMatch[1]);
    if (body.sessionId !== undefined && body.sessionId !== null) requireSession(body.sessionId);
    if (body.sessionId !== undefined) { source.sessionId = body.sessionId; source.orgSource = 'manual'; source.manualOverride = true; }
    if (body.title !== undefined) { source.title = String(body.title).trim(); source.manualOverride = true; }
    if (Array.isArray(body.tags)) { source.tags = body.tags.map((tag) => String(tag).trim()).filter(Boolean); source.manualOverride = true; }
    return { source };
  }

  const suggMatch = pathname.match(/^\/api\/sources\/([^/]+)\/suggest-organization$/);
  if (suggMatch && method === 'POST') {
    const source = requireSource(suggMatch[1]);
    const active = db.sessions.filter((session) => session.status === 'active');
    const suggestion = active.length
      ? { matchSessionId: active[0].id, newSession: null, confidence: 'high',
          reason: `Its content overlaps the material already in «${active[0].title}». (Demo suggestion — canned text, not a real AI judgement.)` }
      : { matchSessionId: null,
          newSession: { category: 'subject', title: `Study — ${source.title}`.slice(0, 80), subject: source.title, tags: [] },
          confidence: 'low', reason: 'No existing session matches closely enough. (Demo suggestion.)' };
    db.suggestions.set(source.id, suggestion);
    return { sourceId: source.id, applicable: !source.manualOverride, suggestion };
  }

  const acceptMatch = pathname.match(/^\/api\/sources\/([^/]+)\/accept-suggestion$/);
  if (acceptMatch && method === 'POST') {
    const source = requireSource(acceptMatch[1]);
    const suggestion = db.suggestions.get(source.id);
    if (!suggestion) throw httpError('VALIDATION_ERROR', 'No suggestion is stored for this material yet.', 400);
    let session = suggestion.matchSessionId ? sessionById(suggestion.matchSessionId) : null;
    if (!session && suggestion.newSession) {
      session = db.sessions.find((item) => item.title.toLowerCase() === suggestion.newSession.title.toLowerCase()) || null;
      if (!session) {
        const now = nowIso();
        session = { id: demoId('ses'), title: suggestion.newSession.title,
          category: suggestion.newSession.category, description: '', tags: suggestion.newSession.tags,
          status: 'active', createdAt: now, updatedAt: now };
        db.sessions.unshift(session);
      }
    }
    if (!session) throw httpError('VALIDATION_ERROR', 'The stored suggestion no longer applies.', 400);
    source.sessionId = session.id;
    source.orgSource = 'manual';
    source.manualOverride = true;
    return { source, session };
  }

  const deckMatch = pathname.match(/^\/api\/decks\/([^/]+)$/);
  const cardMatch = pathname.match(/^\/api\/decks\/([^/]+)\/cards\/(\d+)$/);

  if (cardMatch && method === 'PATCH') {
    const deck = requireDeck(cardMatch[1]);
    const cards = db.deckCards.get(deck.id) || [];
    const idx = Number(cardMatch[2]);
    const card = cards.find((item) => item.idx === idx);
    if (!card || !['new', 'known', 'review'].includes(body.status)) {
      throw httpError('VALIDATION_ERROR', 'Status must be new, known or review.', 400);
    }
    const now = nowIso();
    card.status = body.status;
    card.reviewedAt = now;
    deck.knownCount = cards.filter((item) => item.status === 'known').length;
    deck.reviewCount = cards.filter((item) => item.status === 'review').length;
    deck.lastReviewedAt = now;
    return { deckId: deck.id, idx, status: card.status, lastReviewedAt: now };
  }

  if (deckMatch && method === 'GET') {
    const deck = requireDeck(deckMatch[1]);
    return { deck: { ...deck, sessionTitle: sessionTitleOf(deck.sessionId) }, cards: db.deckCards.get(deck.id) || [] };
  }

  if (deckMatch && method === 'DELETE') {
    const index = db.decks.findIndex((item) => item.id === deckMatch[1]);
    if (index === -1) throw httpError('DECK_NOT_FOUND', 'That deck no longer exists.', 404);
    db.deckCards.delete(deckMatch[1]);
    db.decks.splice(index, 1);
    return null; // 204, no body
  }

  /* ------------------------------------------------ flashcard decks (v1.1) */

  if (route === 'GET /api/decks') {
    const q = (qp.get('q') || '').trim().toLowerCase();
    const category = qp.get('category') || '';
    const scope = qp.get('sessionId') || '';
    const sort = qp.get('sort') || 'recent';
    let list = db.decks.filter((deck) => {
      const parent = deck.sessionId ? sessionById(deck.sessionId) : null;
      if (scope === 'unsorted') return !deck.sessionId;
      if (scope) return deck.sessionId === scope;
      if (category) return parent && parent.category === category;
      return true;
    }).filter((deck) => {
      if (!q) return true;
      const parent = deck.sessionId ? sessionById(deck.sessionId) : null;
      return `${deck.topic} ${parent ? parent.title : ''}`.toLowerCase().includes(q);
    });
    list = sortRecords(list, sort, { title: (d) => d.topic, active: (d) => d.lastReviewedAt, recent: (d) => d.createdAt });
    const decks = list.map((deck) => ({ ...deck, sessionTitle: sessionTitleOf(deck.sessionId) }));
    return { decks, unsortedDeckCount: countUnsorted(db.decks) };
  }

  /* ------------------------------------------------ study sessions (v1.1) */

  if (route === 'GET /api/sessions') {
    const q = (qp.get('q') || '').trim().toLowerCase();
    const category = qp.get('category') || '';
    const sort = qp.get('sort') || 'recent';
    const includeArchived = qp.get('includeArchived') === '1';
    const list = db.sessions
      .filter((session) => includeArchived || session.status === 'active')
      .filter((session) => !category || session.category === category)
      .filter((session) => !q || `${session.title} ${session.category} ${session.description} ${session.tags.join(' ')}`.toLowerCase().includes(q));
    const sorted = sortRecords(list.map(sessionWithCounts), sort,
      { title: (s) => s.title, active: (s) => s.lastActivityAt, recent: (s) => s.updatedAt });
    return { sessions: sorted, unsortedSourceCount: countUnsorted(db.sources) };
  }

  if (route === 'POST /api/sessions') {
    const title = (body.title || '').trim();
    if (title.length < 2 || title.length > 80) {
      throw httpError('VALIDATION_ERROR', 'Title must be between 2 and 80 characters.', 400);
    }
    const category = body.category || 'subject';
    if (!CATEGORY_VALUES.includes(category)) {
      throw httpError('VALIDATION_ERROR', `Category must be one of: ${CATEGORY_VALUES.join(', ')}.`, 400);
    }
    const tags = Array.isArray(body.tags) ? body.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
    if (tags.length > 8 || tags.some((tag) => tag.length > 24)) {
      throw httpError('VALIDATION_ERROR', 'Up to 8 tags, each 1–24 characters.', 400);
    }
    const now = nowIso();
    const session = {
      id: demoId('ses'),
      title,
      category,
      description: (body.description || '').trim(),
      tags,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    db.sessions.unshift(session);
    return { session: sessionWithCounts(session) };
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const session = requireSession(sessionMatch[1]);

    if (method === 'GET') {
      const sources = db.sources
        .filter((source) => source.sessionId === session.id)
        .map((source) => ({ ...source }));
      const decks = db.decks
        .filter((deck) => deck.sessionId === session.id)
        .map((deck) => ({ id: deck.id, topic: deck.topic, cardCount: deck.cardCount, createdAt: deck.createdAt }));
      return { session: sessionWithCounts(session), sources, decks };
    }

    if (method === 'PATCH') {
      const allowed = ['title', 'category', 'description', 'tags', 'status'];
      const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
      if (Object.keys(patch).length === 0) {
        throw httpError('VALIDATION_ERROR', 'Provide at least one field to update.', 400);
      }
      if (patch.title !== undefined && (String(patch.title).trim().length < 2 || String(patch.title).trim().length > 80)) {
        throw httpError('VALIDATION_ERROR', 'Title must be between 2 and 80 characters.', 400);
      }
      if (patch.category !== undefined && !CATEGORY_VALUES.includes(patch.category)) {
        throw httpError('VALIDATION_ERROR', `Category must be one of: ${CATEGORY_VALUES.join(', ')}.`, 400);
      }
      if (patch.status !== undefined && !['active', 'archived'].includes(patch.status)) {
        throw httpError('VALIDATION_ERROR', 'Status must be active or archived.', 400);
      }
      if (patch.title !== undefined) patch.title = String(patch.title).trim();
      if (patch.description !== undefined) patch.description = String(patch.description).trim();
      Object.assign(session, patch, { updatedAt: nowIso() });
      return { session: sessionWithCounts(session) };
    }
  }

  if (route === 'POST /api/sources/upload' || route === 'POST /api/sources/webpage') {
    throw httpError('VALIDATION_ERROR', 'Uploading materials is disabled in demo mode.', 400);
  }

  throw httpError('NOT_FOUND', `Demo mode has no fixture for ${method} ${path}.`, 404);
}
