// 음성 기능 — 모두 브라우저·안드로이드 내장 기능만 사용 (무료)
import { chunkForSpeech, isDialogue } from './util.js';

// ---------- ① 말해서 글쓰기 (SpeechRecognition) ----------
export const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const sttSupported = !!SR;

export class Dictation {
  constructor({ onFinal, onInterim, onState, onError }) {
    this.cb = { onFinal, onInterim, onState, onError }; this.active = false; this.rec = null;
  }
  start() {
    if (!SR) { this.cb.onError?.('이 브라우저는 음성 입력을 지원하지 않아요. 안드로이드 크롬이나 PC 크롬·엣지에서 써 주세요. (키보드의 마이크 버튼도 쓸 수 있어요)'); return false; }
    this.active = true; this._spawn(); this.cb.onState?.(true); return true;
  }
  _spawn() {
    const r = new SR();
    r.lang = 'ko-KR'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) this.cb.onFinal?.(res[0].transcript.trim()); else interim += res[0].transcript;
      }
      this.cb.onInterim?.(interim);
    };
    r.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      const msg = { 'not-allowed': '마이크 권한이 꺼져 있어요. 브라우저 설정에서 마이크를 허용해 주세요.', 'service-not-allowed': '이 기기에서는 음성 인식 서비스를 쓸 수 없어요.', network: '음성 인식은 인터넷 연결이 필요해요.', 'audio-capture': '마이크를 찾을 수 없어요.' }[e.error] || ('음성 인식 오류: ' + e.error);
      this.cb.onError?.(msg);
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) this.stop();
    };
    // 안드로이드는 잠깐 조용하면 끝나 버려서, 켜져 있는 동안은 다시 시작
    r.onend = () => { if (this.active) { try { this._spawn(); } catch (e) { this.stop(); } } };
    this.rec = r;
    try { r.start(); } catch (e) { this.cb.onError?.('음성 입력을 시작하지 못했어요.'); this.stop(); }
  }
  stop() {
    this.active = false;
    try { this.rec && (this.rec.onend = null, this.rec.stop()); } catch (e) {}
    this.rec = null; this.cb.onState?.(false);
  }
}

// ---------- ② 내 소설 듣기 (speechSynthesis) ----------
export const ttsSupported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

export function koVoices() {
  if (!ttsSupported) return [];
  const v = speechSynthesis.getVoices();
  const ko = v.filter(x => /^ko/i.test(x.lang));
  return ko.length ? ko : v;
}
export function onVoicesChanged(fn) { if (ttsSupported) speechSynthesis.addEventListener?.('voiceschanged', fn); }

export class Reader {
  // paragraphs: [{text, el}] , opts: {rate, voiceURI, dialogVoiceURI, dialogDiff}
  constructor({ onPara, onEnd, onState }) { this.cb = { onPara, onEnd, onState }; this.paras = []; this.i = 0; this.c = 0; this.playing = false; this.opts = { rate: 1 }; this.gen = 0; }
  load(paras) { this.paras = paras; }
  setOpts(o) { Object.assign(this.opts, o); }
  play(from = this.i) {
    if (!ttsSupported) { this.cb.onState?.('unsupported'); return false; }
    speechSynthesis.cancel(); this.i = from; this.c = 0; this.fails = 0; this.playing = true; this.gen++;
    this.cb.onState?.('playing'); this._next(this.gen); return true;
  }
  _next(gen) {
    if (gen !== this.gen || !this.playing) return;
    while (this.i < this.paras.length && !this.paras[this.i].text.trim()) { this.i++; this.c = 0; }
    if (this.i >= this.paras.length) { this.playing = false; this.cb.onState?.('ended'); this.cb.onEnd?.(); return; }
    const p = this.paras[this.i]; const chunks = chunkForSpeech(p.text);
    if (this.c === 0) this.cb.onPara?.(this.i);
    const u = new SpeechSynthesisUtterance(chunks[this.c] || '');
    u.lang = 'ko-KR'; u.rate = this.opts.rate || 1;
    const voices = speechSynthesis.getVoices();
    const dlg = this.opts.dialogDiff && isDialogue(p.text);
    const vURI = dlg ? (this.opts.dialogVoiceURI || this.opts.voiceURI) : this.opts.voiceURI;
    const v = voices.find(x => x.voiceURI === vURI); if (v) u.voice = v;
    if (dlg) u.pitch = this.opts.dialogVoiceURI && this.opts.dialogVoiceURI !== this.opts.voiceURI ? 1 : 1.25;
    u.onend = () => { if (gen !== this.gen) return; this.fails = 0; this.c++; if (this.c >= chunks.length) { this.i++; this.c = 0; } this._next(gen); };
    u.onerror = e => {
      if (gen !== this.gen || e.error === 'interrupted' || e.error === 'canceled') return;
      if (++this.fails >= 3) { this.playing = false; this.cb.onState?.('failed'); return; } // 음성 엔진이 없으면 계속 건너뛰지 않고 멈춤
      this.c++; if (this.c >= chunks.length) { this.i++; this.c = 0; } this._next(gen); };
    speechSynthesis.speak(u);
  }
  // 안드로이드의 pause()가 불안정해서, 멈춤 = 취소 후 현재 문장부터 다시 시작
  pause() { if (!this.playing) return; this.playing = false; this.gen++; speechSynthesis.cancel(); this.cb.onState?.('paused'); }
  resume() { if (this.playing) return; this.playing = true; this.gen++; this.cb.onState?.('playing'); this._next(this.gen); }
  stop() { this.playing = false; this.gen++; if (ttsSupported) speechSynthesis.cancel(); this.i = 0; this.c = 0; this.cb.onState?.('stopped'); }
}

// ---------- ③ 아이디어 녹음 (MediaRecorder) ----------
export const recSupported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
export function pickMime() {
  if (!window.MediaRecorder) return '';
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return '';
}
export class Recorder {
  async start() {
    if (!recSupported) throw new Error('이 브라우저는 녹음을 지원하지 않아요.');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { throw new Error(e.name === 'NotAllowedError' ? '마이크 권한이 필요해요. 브라우저 설정에서 허용해 주세요.' : '마이크를 쓸 수 없어요: ' + (e.message || e.name)); }
    this.stream = stream; this.chunks = []; this.mime = pickMime();
    this.mr = new MediaRecorder(stream, this.mime ? { mimeType: this.mime } : undefined);
    this.mr.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.t0 = Date.now(); this.mr.start(1000);
  }
  elapsed() { return this.t0 ? (Date.now() - this.t0) / 1000 : 0; }
  stop(save = true) {
    return new Promise(res => {
      if (!this.mr) return res(null);
      const dur = this.elapsed();
      this.mr.onstop = () => {
        this.stream.getTracks().forEach(t => t.stop());
        const type = (this.mr.mimeType || this.mime || 'audio/webm').split(';')[0];
        const blob = save ? new Blob(this.chunks, { type }) : null;
        this.mr = null; this.t0 = 0; res(blob ? { blob, mime: type, duration: dur } : null);
      };
      try { this.mr.stop(); } catch (e) { res(null); }
    });
  }
}
