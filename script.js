// ── CONFIG ──
const FILLER_WORDS = [
  'um', 'uh', 'umm', 'uhh', 'hm', 'hmm', 'mm',
  'like', 'basically', 'literally', 'so', 'right', 'okay', 'actually',
  'you know', 'kind of', 'sort of', 'i mean', 'you see', 'well', 'anyway'
];

// Canonical form for filler variants (so bar chart shows one bar per sound)
const FILLER_CANONICAL = {
  'umm': 'um',
  'uhh': 'uh',
  'hmm': 'hm',
  'mm':  'hm'
};

// Normalize transcript text before filler detection — catches browser-mangled hesitations
function normalizeTranscript(text) {
  return text
    .replace(/\buh[-\s]huh\b/gi,  'uh')   // uh-huh → uh
    .replace(/\bmm[-\s]hmm\b/gi,  'hm')   // mm-hmm → hm
    .replace(/\bum+h?\b/gi,       'um')   // umm, ummm, umh → um
    .replace(/\buh+\b/gi,         'uh')   // uhh, uhhh → uh
    .replace(/\bhm+\b/gi,         'hm')   // hmm, hmmm → hm
    .replace(/\bm{2,}\b/gi,       'mm');  // mmm, mmmm → mm
}

let DURATION = 60; // seconds

// ── PDF STATE ──
let pdfDoc = null;
let pdfPageNum = 1;
let pdfTotalPages = 0;
let pdfMode = 'full';
let pdfRendering = false;

// ── PDF FUNCTIONS ──
document.addEventListener('DOMContentLoaded', () => {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
});

async function handlePDFUpload(file) {
  if (!file || file.type !== 'application/pdf') return;
  document.getElementById('pdf-upload-box').style.display = 'none';
  document.getElementById('pdf-loaded-indicator').style.display = 'flex';
  document.getElementById('pdf-loaded-name').textContent = file.name;
  const arrayBuffer = await file.arrayBuffer();
  pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  pdfTotalPages = pdfDoc.numPages;
  pdfPageNum = 1;
}

function removePDF() {
  pdfDoc = null;
  pdfPageNum = 1;
  pdfTotalPages = 0;
  document.getElementById('pdf-upload-box').style.display = 'flex';
  document.getElementById('pdf-loaded-indicator').style.display = 'none';
  document.getElementById('pdf-file-input').value = '';
}

async function renderPDFPage(num) {
  if (!pdfDoc || pdfRendering) return;
  pdfRendering = true;
  try {
    const page = await pdfDoc.getPage(num);
    const canvas = document.getElementById('pdf-canvas');
    const ctx = canvas.getContext('2d');
    const containerWidth = document.getElementById('pdf-canvas-wrap').offsetWidth || 700;
    const viewport = page.getViewport({ scale: 1 });
    const scale = (containerWidth - 4) / viewport.width;
    const scaledViewport = page.getViewport({ scale });
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    document.getElementById('pdf-page-info').textContent = `${num} / ${pdfTotalPages}`;
    document.getElementById('pdf-prev').disabled = num <= 1;
    document.getElementById('pdf-next').disabled = num >= pdfTotalPages;
  } finally {
    pdfRendering = false;
  }
}

function setPDFMode(mode) {
  pdfMode = mode;
  const wrap = document.getElementById('pdf-canvas-wrap');
  const notice = document.getElementById('pdf-hidden-notice');
  const nav = document.getElementById('pdf-nav');
  ['full', 'dim', 'hidden'].forEach(m => {
    document.getElementById(`mode-${m}`).classList.toggle('active', m === mode);
  });
  wrap.classList.remove('dim');
  if (mode === 'full') {
    wrap.style.display = 'flex';
    notice.style.display = 'none';
    nav.style.opacity = '1';
    nav.style.pointerEvents = 'auto';
  } else if (mode === 'dim') {
    wrap.style.display = 'flex';
    wrap.classList.add('dim');
    notice.style.display = 'none';
    nav.style.opacity = '0.4';
    nav.style.pointerEvents = 'auto';
  } else if (mode === 'hidden') {
    wrap.style.display = 'none';
    notice.style.display = 'block';
    nav.style.opacity = '0.3';
    nav.style.pointerEvents = 'none';
  }
}

function nextPDFPage() {
  if (pdfPageNum < pdfTotalPages) { pdfPageNum++; renderPDFPage(pdfPageNum); }
}

function prevPDFPage() {
  if (pdfPageNum > 1) { pdfPageNum--; renderPDFPage(pdfPageNum); }
}

// ── STATE ──
let timerInterval = null;
let sessionActive = false;
let secondsLeft = DURATION;
let fillerCounts = {};
let totalFillers = 0;
let fullTranscript = '';
let transcriptHTML = '';
let recognition = null;
let mediaRecorder = null;
let recordedChunks = [];
let videoStream = null;
let sessionStartTime = null;
let sessionElapsed = 0;
let noSpeechTimer = null;
let hadSpeech = false;
let interimFillersSeen = new Set(); // tracks interim fillers to avoid double-counting

// ── INIT FILLER MAP ──
function resetFillerCounts() {
  fillerCounts = {};
  FILLER_WORDS.forEach(w => fillerCounts[w] = 0);
  totalFillers = 0;
}

// ── SCREEN MANAGEMENT ──
function showScreen(id) {
  ['screen-idle', 'screen-active', 'screen-results'].forEach(s => {
    document.getElementById(s).classList.remove('visible');
  });
  document.getElementById(id).classList.add('visible');
}

// ── BUILD FILLER GRID ──
function buildFillerGrid() {
  const grid = document.getElementById('filler-grid');
  grid.innerHTML = '';
  FILLER_WORDS.forEach(w => {
    const div = document.createElement('div');
    div.className = 'filler-item';
    div.id = `fi-${w.replace(/\s+/g, '_')}`;
    div.innerHTML = `<span class="filler-word">${w}</span><span class="filler-count">0</span>`;
    grid.appendChild(div);
  });
}

// ── UPDATE FILLER UI ──
function bumpFiller(word) {
  const key = FILLER_CANONICAL[word] ?? word;
  fillerCounts[key] = (fillerCounts[key] ?? 0) + 1;
  totalFillers++;
  document.getElementById('total-count').textContent = totalFillers;
  const id = `fi-${key.replace(/\s+/g, '_')}`;
  const el = document.getElementById(id);
  if (el) {
    el.querySelector('.filler-count').textContent = fillerCounts[key];
    el.classList.add('hit');
    el.style.transform = 'scale(1.05)';
    setTimeout(() => el.style.transform = '', 200);
  }
}

// ── TIMER ──
function startTimer() {
  secondsLeft = DURATION;
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    secondsLeft--;
    sessionElapsed = DURATION - secondsLeft;
    updateTimerDisplay();
    if (secondsLeft <= 0) { stopSession(); }
  }, 1000);
}

function updateTimerDisplay() {
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  const disp = document.getElementById('timer-display');
  disp.textContent = `${m}:${String(s).padStart(2, '0')}`;
  disp.className = secondsLeft <= 10 ? 'warning' : '';
  const bar = document.getElementById('timer-bar');
  const pct = (secondsLeft / DURATION) * 100;
  bar.style.width = pct + '%';
  bar.style.background = secondsLeft <= 10 ? 'var(--red)' : secondsLeft <= 20 ? 'var(--accent)' : 'var(--accent)';
}

// ── SPEECH RECOGNITION ──
function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    document.getElementById('no-speech-notice').style.display = 'block';
    document.getElementById('no-speech-notice').textContent = '⚠ Speech recognition not supported in this browser (use Chrome)';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 3;

  recognition.onend = () => {
    if (sessionActive) setTimeout(() => { try { recognition.start(); } catch(e) {} }, 200);
  };

  let interimSpan = null;
  // Track which result indices we've already finalised to avoid double-counting
  let finalisedUpTo = -1;

  recognition.onresult = (event) => {
    hadSpeech = true;
    clearTimeout(noSpeechTimer);
    const transcript = document.getElementById('transcript');
    let interim = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        // Use the top alternative for display
        const text = res[0].transcript;
        fullTranscript += text + ' ';
        const highlighted = highlightFillers(text);
        transcriptHTML += highlighted + ' ';
        if (interimSpan) { interimSpan.remove(); interimSpan = null; }
        const finalEl = document.createElement('span');
        finalEl.innerHTML = highlighted + ' ';
        transcript.appendChild(finalEl);
        transcript.scrollTop = transcript.scrollHeight;

        // Count from top alternative
        countFillers(text);

        // Also scan lower-ranked alternatives for hesitations missed in alt[0]
        // Only count um/uh/hm — these are the sounds most likely to be in alt[1+]
        const HESITATIONS = new Set(['um','uh','hm']);
        for (let a = 1; a < res.length; a++) {
          const altText = normalizeTranscript(res[a].transcript);
          detectFillers(altText).forEach(m => {
            if (HESITATIONS.has(m.word)) {
              // Only bump if top alt didn't already have it at this position
              const topNorm = normalizeTranscript(text);
              if (!topNorm.toLowerCase().includes(m.word)) {
                bumpFiller(m.word);
              }
            }
          });
        }

        // Clear interim dedup keys for this result index now it's final
        interimFillersSeen.forEach(k => {
          if (k.startsWith(`${i}:`)) interimFillersSeen.delete(k);
        });
        finalisedUpTo = i;

      } else {
        // Interim: scan for hesitations and count them early (with dedup)
        const interimText = normalizeTranscript(res[0].transcript);
        interim += res[0].transcript;
        detectFillers(interimText).forEach(m => {
          if (['um','uh','hm'].includes(m.word)) {
            const key = `${i}:${m.word}:${m.start}`;
            if (!interimFillersSeen.has(key)) {
              interimFillersSeen.add(key);
              bumpFiller(m.word);
            }
          }
        });
      }
    }

    // update interim
    if (interimSpan) interimSpan.remove();
    if (interim) {
      interimSpan = document.createElement('span');
      interimSpan.style.color = 'var(--muted)';
      interimSpan.style.fontStyle = 'italic';
      interimSpan.textContent = interim;
      transcript.appendChild(interimSpan);
      transcript.scrollTop = transcript.scrollHeight;
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'not-allowed') {
      document.getElementById('no-speech-notice').style.display = 'block';
      document.getElementById('no-speech-notice').textContent = '⚠ Microphone permission denied';
    }
  };

  noSpeechTimer = setTimeout(() => {
    if (!hadSpeech) {
      document.getElementById('no-speech-notice').style.display = 'block';
      document.getElementById('no-speech-notice').textContent = '⚠ No speech detected — check your microphone';
    }
  }, 5000);

  recognition.start();
}

// ── CONTEXT-AWARE FILLER DETECTION ──
//
// Works at the TOKEN level so prev/next word lookups are always accurate.
// Each token is { word: string (lowercase, letters only), raw: string, start: number }
//
function tokenize(text) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({
      raw: m[0],
      word: m[0].toLowerCase().replace(/[^a-z']/g, ''),
      start: m.index,
      end: m.index + m[0].length
    });
  }
  return tokens;
}

function w(tokens, i) { return i >= 0 && i < tokens.length ? tokens[i].word : ''; }

// Returns true if this token occurrence is genuinely a filler word
function isFiller(fw, tokens, i) {
  const prev  = w(tokens, i - 1);
  const prev2 = w(tokens, i - 2);
  const next  = w(tokens, i + 1);
  const next2 = w(tokens, i + 2);

  switch (fw) {

    case 'right': {
      // "right now / here / away / there / back / up / down / through" — adverbial emphasis → NOT filler
      if (/^(now|here|away|there|back|up|down|through|along|in|out|over|around|before|after|next|then)$/.test(next)) return false;
      // "the/a/your/my/his/her/this/that right ..." — determiner before it → adjective use → NOT filler
      if (/^(the|a|an|your|my|his|her|their|our|its|this|that|one|no|every|each)$/.test(prev)) return false;
      // "turn/go/move right" — directional → NOT filler
      if (/^(turn|go|veer|lean|look|move|swing|bear|hang|step|slide|shift)$/.test(prev)) return false;
      // "all/far/hard/alt right" — compound → NOT filler
      if (/^(all|far|hard|alt|center|centre)$/.test(prev)) return false;
      // "right hand/side/angle/answer/way/place/time/choice/wing..." → NOT filler
      if (/^(hand|side|wing|angle|answer|way|direction|place|time|choice|decision|track|path|person|thing|point|moment|move|call|foot|eye|ear|lane|turn)$/.test(next)) return false;
      // "not right" → NOT filler
      if (prev === 'not') return false;
      // Everything else → filler ("...right?" / "right so" / "and right, ...")
      return true;
    }

    case 'like': {
      // "would/should/could/might/do/did/will like" → verb use → NOT filler
      if (/^(would|should|could|might|may|do|does|did|will|wouldnt|shouldnt|couldnt|wont|dont|doesnt|didnt)$/.test(prev)) return false;
      // "I/we/you/they/he/she like(s)" → genuine verb → NOT filler
      if (/^(i|we|you|they|he|she|who|people|everyone|nobody|somebody|anyone|everyone)$/.test(prev)) return false;
      // "feels/looks/seems/sounds/smells/acts/appears like" → comparison → NOT filler
      if (/^(feel|feels|felt|look|looks|looked|seem|seems|seemed|sound|sounds|sounded|taste|tastes|smell|smells|act|acts|acted|appear|appears|appeared)$/.test(prev)) return false;
      // "more/just/much/exactly/nothing/something/nothing like" → comparison → NOT filler
      if (/^(more|less|just|much|exactly|nothing|something|anything|everything|kind|sort|type|bit|rather|almost|quite|not|nowhere|never)$/.test(prev)) return false;
      // "like this/that" after a real subject (not a conjunction) → demonstrative → NOT filler
      if (/^(this|that)$/.test(next) && !/^(and|but|so|or|um|uh|like)$/.test(prev) && prev !== '') return false;
      return true;
    }

    case 'well': {
      // "went/did/works/performed/handled well" → adverb of manner → NOT filler
      if (/^(went|goes|go|doing|done|did|work|works|worked|sleep|slept|play|played|run|ran|end|ended|turn|turned|perform|performs|performed|behaved|respond|responds|aged|fare|fared|function|functions|handle|handles|handled|communicate|communicates|sit|sits|sat|stand|stands|stood|eat|ate|eats)$/.test(prev)) return false;
      // "very/pretty/quite/as/so/not/extremely well" → degree adverb → NOT filler
      if (/^(as|not|very|pretty|quite|so|extremely|remarkably|particularly|incredibly|doing|feeling|fairly|reasonably)$/.test(prev)) return false;
      // "well known/being/rounded/informed/established/deserved/suited/balanced/defined..." → compound → NOT filler
      if (/^(known|being|rounded|informed|established|intentioned|deserved|placed|suited|versed|aware|balanced|defined|built|thought|received|designed|written|spoken|read|made|paid|earned|spent|used|equipped|funded|maintained|regarded|respected|documented|supported|connected|attended|liked|loved|managed|run|led|organized)$/.test(next)) return false;
      return true;
    }

    case 'so': {
      // "so much/many/good/great/far/long/often..." → genuine intensifier → NOT filler
      if (/^(much|many|few|little|far|long|often|well|good|great|bad|important|big|small|easy|hard|clear|simple|complex|difficult|fast|slow|quick|smart|strong|weak|high|low|close|wide|happy|sad|busy|tired|excited|cool|nice|interesting|weird|strange|powerful|obvious|deep|helpful|useful|effective|beautiful|awful|terrible|wonderful|amazing|incredible|popular|common|rare|special|serious|significant|different|similar|large|small|full|empty|young|old|new|true|false|sure|certain|glad|sorry|proud|grateful|thankful)$/.test(next)) return false;
      // "so that" → purpose clause → NOT filler
      if (next === 'that') return false;
      // "and/even/or/if/why/not/how so" → connective/response → NOT filler
      if (/^(and|even|or|if|why|not|how|just|ever|never)$/.test(prev)) return false;
      // "or so" (approximation) → NOT filler
      if (prev === 'or') return false;
      return true;
    }

    case 'okay': {
      // "are you okay / is it okay / sounds okay / that's okay" → genuine adjective → NOT filler
      if (/^(you|he|she|it|that|this|everything|everyone|i|we|they|things|everything)$/.test(prev)) return false;
      if (/^(are|is|was|were|sounds|looks|seems|feel|feels|be)$/.test(prev)) return false;
      return true;
    }

    case 'actually': {
      // "actually" is almost always a filler/hedge in speech — keep flagging
      return true;
    }

    case 'basically':
    case 'literally':
    case 'anyway':
      return true;

    case 'kind of':
    case 'sort of': {
      // "kind of blue/sad/weird" → legitimate qualifier followed by adjective — still flag, it's a hedge
      // Only skip if it's a real set phrase: "sort of thing", "kind of person"
      if (/^(thing|person|way|place|situation|idea|concept|topic|subject)$/.test(next)) return false;
      return true;
    }

    case 'um': case 'uh': case 'umm': case 'uhh':
    case 'hm': case 'hmm': case 'mm':
    case 'you know': case 'i mean': case 'you see':
      return true;

    default:
      return true;
  }
}

// Find all filler matches with their char positions, skipping overlaps and non-filler context
function detectFillers(text) {
  const lower = text.toLowerCase();
  const tokens = tokenize(lower);
  const usedTokens = new Set();
  const matches = [];

  // Sort: multi-word first, then longer single words first
  const sorted = [...FILLER_WORDS].sort((a, b) => {
    const am = a.includes(' ') ? 1 : 0;
    const bm = b.includes(' ') ? 1 : 0;
    if (bm !== am) return bm - am;
    return b.length - a.length;
  });

  for (const fw of sorted) {
    const fwTokens = fw.split(' '); // e.g. ['you', 'know']
    const span = fwTokens.length;

    for (let i = 0; i <= tokens.length - span; i++) {
      // Check if all tokens in the span match the filler word tokens
      const match = fwTokens.every((ft, offset) => tokens[i + offset].word === ft);
      if (!match) continue;

      // Check no token in this span already used by a longer match
      let overlap = false;
      for (let s = 0; s < span; s++) { if (usedTokens.has(i + s)) { overlap = true; break; } }
      if (overlap) continue;

      // Context check
      if (!isFiller(fw, tokens, i)) continue;

      // Record match using original-case text positions
      const startChar = tokens[i].start;
      const endChar   = tokens[i + span - 1].end;
      matches.push({ word: fw, start: startChar, end: endChar, original: text.slice(startChar, endChar) });
      for (let s = 0; s < span; s++) usedTokens.add(i + s);
    }
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function countFillers(text) {
  detectFillers(normalizeTranscript(text)).forEach(m => bumpFiller(m.word));
}

function highlightFillers(text) {
  const normalized = normalizeTranscript(text);
  const matches = detectFillers(normalized);
  if (!matches.length) return `<span class="normal">${escapeHtml(text)}</span>`;
  let out = '', last = 0;
  for (const m of matches) {
    out += escapeHtml(text.slice(last, m.start));
    out += `<span class="filler-highlight">${escapeHtml(m.original)}</span>`;
    last = m.end;
  }
  out += escapeHtml(text.slice(last));
  return `<span class="normal">${out}</span>`;
}

// ── CAMERA ──
async function startCamera() {
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const vid = document.getElementById('video-preview');
    vid.srcObject = videoStream;
    vid.style.display = 'block';
    document.getElementById('cam-off-msg').style.display = 'none';
    document.getElementById('cam-dot').style.background = 'var(--red)';
    document.getElementById('cam-dot').classList.add('live');
    // Start recording
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(videoStream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.start();
  } catch (e) {
    document.getElementById('video-preview').style.display = 'none';
    document.getElementById('cam-off-msg').style.display = 'flex';
  }
}

function stopCamera() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (videoStream) {
    videoStream.getTracks().forEach(t => t.stop());
    videoStream = null;
  }
}

// ── SESSION FLOW ──
async function startSession() {
  resetFillerCounts();
  fullTranscript = '';
  transcriptHTML = '';
  hadSpeech = false;
  sessionElapsed = 0;
  sessionActive = true;
  interimFillersSeen = new Set();
  document.getElementById('transcript').innerHTML = '<span style="color:var(--muted);font-family:\'Space Mono\',monospace;font-size:0.8rem;">Waiting for speech…</span>';
  document.getElementById('total-count').textContent = '0';
  document.getElementById('no-speech-notice').style.display = 'none';

  buildFillerGrid();
  showScreen('screen-active');

  // Show PDF panel if a PDF was loaded
  if (pdfDoc) {
    const panel = document.getElementById('pdf-viewer-panel');
    panel.style.display = 'block';
    pdfMode = 'full';
    ['full','dim','hidden'].forEach(m =>
      document.getElementById(`mode-${m}`).classList.toggle('active', m === 'full')
    );
    document.getElementById('pdf-canvas-wrap').style.display = 'flex';
    document.getElementById('pdf-canvas-wrap').classList.remove('dim');
    document.getElementById('pdf-hidden-notice').style.display = 'none';
    document.getElementById('pdf-nav').style.opacity = '1';
    document.getElementById('pdf-nav').style.pointerEvents = 'auto';
    setTimeout(() => renderPDFPage(pdfPageNum), 150);
  } else {
    document.getElementById('pdf-viewer-panel').style.display = 'none';
  }

  const durationInput = document.getElementById('duration-select');
  if (durationInput) {
    DURATION = parseInt(durationInput.value, 10);
  }

  sessionStartTime = Date.now();
  startTimer();
  await startCamera();
  startSpeechRecognition();
}

function stopSession() {
  clearInterval(timerInterval);
  clearTimeout(noSpeechTimer);
  sessionActive = false;
  sessionElapsed = Math.round((Date.now() - sessionStartTime) / 1000) || DURATION;

  if (recognition) { try { recognition.stop(); } catch (e) { } recognition = null; }
  stopCamera();

  setTimeout(showResults, 400);
}

function cancelSession() {
  clearInterval(timerInterval);
  clearTimeout(noSpeechTimer);
  sessionActive = false;
  if (recognition) { try { recognition.stop(); } catch (e) { } recognition = null; }
  stopCamera();
  resetToIdle();
}

function resetToIdle() {
  showScreen('screen-idle');
}

// ── RESULTS ──
function showResults() {
  showScreen('screen-results');

  const elapsed = Math.max(sessionElapsed, 1);
  const rate = Math.round((totalFillers / elapsed) * 60);

  // Score coloring
  const totalEl = document.getElementById('r-total');
  totalEl.textContent = totalFillers;
  totalEl.className = 'stat-value ' + (totalFillers <= 5 ? 'good' : totalFillers <= 15 ? 'warn' : 'bad');

  const rateEl = document.getElementById('r-rate');
  rateEl.textContent = rate;
  rateEl.className = 'stat-value ' + (rate <= 5 ? 'good' : rate <= 15 ? 'warn' : 'bad');

  document.getElementById('r-total-sub').textContent = totalFillers <= 5 ? '🟢 Excellent' : totalFillers <= 15 ? '🟡 Needs work' : '🔴 High usage';

  // Top word
  const sorted = Object.entries(fillerCounts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const topEl = document.getElementById('r-top');
  const topSubEl = document.getElementById('r-top-sub');
  if (sorted.length) {
    topEl.textContent = `"${sorted[0][0]}"`;
    topEl.className = 'stat-value bad';
    topSubEl.textContent = `used ${sorted[0][1]} time${sorted[0][1] !== 1 ? 's' : ''}`;
  } else {
    topEl.textContent = 'None!';
    topEl.className = 'stat-value good';
    topSubEl.textContent = 'No fillers detected 🎉';
  }

  // Subtitle
  const elapsed_s = Math.min(elapsed, DURATION);
  document.getElementById('result-subtitle').textContent =
    `You spoke for ${elapsed_s} second${elapsed_s !== 1 ? 's' : ''}. ${totalFillers === 0 ? "Perfect run — zero fillers!" : `${totalFillers} filler word${totalFillers !== 1 ? 's' : ''} detected.`}`;

  // Bar chart
  const chart = document.getElementById('bar-chart');
  chart.innerHTML = '';
  const max = sorted.length ? sorted[0][1] : 1;
  const all = Object.entries(fillerCounts).sort((a, b) => b[1] - a[1]);
  all.forEach(([word, count]) => {
    const pct = max > 0 ? (count / max) * 100 : 0;
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="bar-word">${word}</span>
      <div class="bar-track"><div class="bar-fill" style="width:0%" data-pct="${pct}"></div></div>
      <span class="bar-num">${count}</span>`;
    chart.appendChild(row);
  });
  // Animate bars
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.querySelectorAll('.bar-fill').forEach(b => {
        b.style.width = b.dataset.pct + '%';
      });
    });
  });

  // Video playback
  if (recordedChunks.length > 0) {
    setTimeout(() => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const pv = document.getElementById('playback-video');
      pv.src = url;
      document.getElementById('playback-panel').style.display = 'block';
    }, 300);
  }

  // Transcript
  document.getElementById('result-transcript-text').innerHTML =
    transcriptHTML || '<span style="color:var(--muted)">No speech was captured.</span>';

  // Tips
  const tips = generateTips(totalFillers, rate, sorted);
  const tc = document.getElementById('tips-container');
  tc.innerHTML = '';
  tips.forEach(t => {
    const div = document.createElement('div');
    div.className = 'tip';
    div.innerHTML = `<span class="tip-icon">${t.icon}</span><span>${t.text}</span>`;
    tc.appendChild(div);
  });
}

function generateTips(total, rate, sorted) {
  const tips = [];
  if (total === 0) {
    tips.push({ icon: '🏆', text: 'Outstanding! Zero filler words detected. You\'re speaking with clarity and confidence.' });
  }
  if (rate > 15) {
    tips.push({ icon: '⏸', text: 'You\'re using many fillers per minute. Try pausing silently instead of filling gaps — silence signals confidence.' });
  }
  if (sorted.length && sorted[0][0] === 'like') {
    tips.push({ icon: '🎯', text: '"Like" is your top filler. It often appears when we\'re searching for words. Slow down and let a pause replace it.' });
  }
  if (sorted.length && (sorted[0][0] === 'um' || sorted[0][0] === 'uh')) {
    tips.push({ icon: '🧠', text: '"Um" and "uh" are hesitation sounds. Practice speaking slower so your thoughts can keep up with your mouth.' });
  }
  if (total > 5) {
    tips.push({ icon: '🔁', text: `Record yourself daily for ${DURATION} seconds on any topic. Reviewing your own footage builds awareness fast.` });
  }
  if (total > 0) {
    tips.push({ icon: '📖', text: 'Try the "just say nothing" drill: speak, but when a filler urge appears — pause completely instead.' });
  }
  if (tips.length === 0) {
    tips.push({ icon: '📈', text: `Keep practicing! Try explaining complex topics in ${DURATION} seconds to push your fluency further.` });
  }
  return tips;
}