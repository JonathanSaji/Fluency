// ── CONFIG ──
const FILLER_WORDS = [
  'um', 'uh', 'like', 'basically', 'literally', 'so', 'right', 'okay', 'actually',
  'you know', 'kind of', 'sort of', 'i mean', 'you see', 'well', 'anyway', 'umm', 'uhh'
];

const DURATION = 60; // seconds

// ── STATE ──
let timerInterval = null;
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
  fillerCounts[word]++;
  totalFillers++;
  document.getElementById('total-count').textContent = totalFillers;
  const id = `fi-${word.replace(/\s+/g, '_')}`;
  const el = document.getElementById(id);
  if (el) {
    el.querySelector('.filler-count').textContent = fillerCounts[word];
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
  recognition.maxAlternatives = 1;

  recognition.onend = () => {
    if (timerInterval) recognition.start(); // restart if session still active
  };

  let interimSpan = null;

  recognition.onresult = (event) => {
    hadSpeech = true;
    clearTimeout(noSpeechTimer);
    const transcript = document.getElementById('transcript');
    let interim = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        const text = res[0].transcript;
        fullTranscript += text + ' ';
        const highlighted = highlightFillers(text);
        transcriptHTML += highlighted + ' ';
        // remove old interim span and append final
        if (interimSpan) { interimSpan.remove(); interimSpan = null; }
        const finalEl = document.createElement('span');
        finalEl.innerHTML = highlighted + ' ';
        transcript.appendChild(finalEl);
        transcript.scrollTop = transcript.scrollHeight;
        // count fillers
        countFillers(text);
      } else {
        interim += res[0].transcript;
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

function countFillers(text) {
  const lower = text.toLowerCase();
  // Check multi-word fillers first
  const sorted = [...FILLER_WORDS].sort((a, b) => b.length - a.length);
  const tempText = lower;
  let remaining = ' ' + tempText + ' ';
  sorted.forEach(fw => {
    const re = new RegExp(`\\b${fw.replace(/\s+/g, '\\s+')}\\b`, 'gi');
    let m;
    while ((m = re.exec(remaining)) !== null) {
      bumpFiller(fw);
    }
  });
}

function highlightFillers(text) {
  let result = text;
  const sorted = [...FILLER_WORDS].sort((a, b) => b.length - a.length);
  sorted.forEach(fw => {
    const re = new RegExp(`\\b(${fw.replace(/\s+/g, '\\s+')})\\b`, 'gi');
    result = result.replace(re, `<span class="filler-highlight">$1</span>`);
  });
  // wrap non-highlighted text in .normal
  return `<span class="normal">${result}</span>`;
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
  document.getElementById('transcript').innerHTML = '<span style="color:var(--muted);font-family:\'Space Mono\',monospace;font-size:0.8rem;">Waiting for speech…</span>';
  document.getElementById('total-count').textContent = '0';
  document.getElementById('no-speech-notice').style.display = 'none';

  buildFillerGrid();
  showScreen('screen-active');

  sessionStartTime = Date.now();
  startTimer();
  await startCamera();
  startSpeechRecognition();
}

function stopSession() {
  clearInterval(timerInterval);
  clearTimeout(noSpeechTimer);
  sessionElapsed = Math.round((Date.now() - sessionStartTime) / 1000) || DURATION;

  if (recognition) { try { recognition.stop(); } catch (e) { } recognition = null; }
  stopCamera();

  setTimeout(showResults, 400);
}

function cancelSession() {
  clearInterval(timerInterval);
  clearTimeout(noSpeechTimer);
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
  const elapsed_s = Math.min(elapsed, 60);
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
    document.querySelectorAll('.bar-fill').forEach(b => {
      b.style.width = b.dataset.pct + '%';
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
    tips.push({ icon: '🔁', text: 'Record yourself daily for 60 seconds on any topic. Reviewing your own footage builds awareness fast.' });
  }
  if (total > 0) {
    tips.push({ icon: '📖', text: 'Try the "just say nothing" drill: speak, but when a filler urge appears — pause completely instead.' });
  }
  if (tips.length === 0) {
    tips.push({ icon: '📈', text: 'Keep practicing! Try explaining complex topics in 60 seconds to push your fluency further.' });
  }
  return tips;
}