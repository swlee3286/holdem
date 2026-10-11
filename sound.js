// ===== 효과음 =====
// 소리 파일 없이 Web Audio로 그때그때 합성한다. 브라우저 자동 재생 제한 때문에 첫 클릭·터치·키 입력 뒤부터 소리가 난다.
//   PokerSound.play(name)  — deal · flip · check · chip · call · raise · allin · fold · turn · tick · win · bust
//   PokerSound.setMuted(bool) · isMuted() · toggle()  (음소거 여부는 localStorage에 기억)
// 같은 소리를 60ms 안에 다시 부르면 한 번만 낸다. 다른 탭에 있을 때 · 화면을 누르기 전에는 소리를 내지 않는다(쌓아 두지도 않는다).
// 브라우저 전역 PokerSound 하나만 만든다.
(function (root) {
"use strict";
const KEY = "holdem-sound";
const GAP_MS = 60; // 같은 소리 사이 최소 간격
let ctx = null, master = null, noise = null, muted = false;
const lastAt = {};
try { muted = root.localStorage?.getItem(KEY) === "off"; } catch {}

function audio() {
  if (ctx) return ctx;
  const AC = root.AudioContext || root.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    // 여러 소리가 겹쳐도 찢어지지 않게
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp);
    comp.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

// 오디오는 사용자 입력 안에서만 만들고 깨운다 (그 전에 만들면 브라우저가 경고를 남긴다).
// iOS는 touchend · click에서만 허락하고, 다른 앱을 다녀오면 다시 멈출(interrupted) 수 있어 입력마다 확인한다
function unlock() {
  if (muted && !ctx) return;
  const c = audio();
  if (!c || c.state === "running") return;
  c.resume().catch(() => {});
  // 옛 iOS: 빈 소리를 한 번 내야 풀린다
  try {
    const s = c.createBufferSource();
    s.buffer = c.createBuffer(1, 1, 22050);
    s.connect(c.destination);
    s.start(0);
  } catch {}
}
for (const ev of ["pointerdown", "pointerup", "touchend", "click", "keydown"]) root.addEventListener?.(ev, unlock, { capture: true, passive: true });

// 흰 소음 1초 (한 번 만들어 재사용)
function noiseBuffer(c) {
  if (noise) return noise;
  noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

// 짧은 음: 주파수 f(→ f2로 미끄러짐), 길이 dur초, 파형 type, 크기 g, 시작 t초 뒤
function tone(c, { f, f2, dur, type = "sine", g = 0.3, t = 0, attack = 0.004 }) {
  const at = c.currentTime + t, o = c.createOscillator(), v = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, at);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, at + dur);
  v.gain.setValueAtTime(0.0001, at);
  v.gain.exponentialRampToValueAtTime(g, at + attack);
  v.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(v).connect(master);
  o.start(at);
  o.stop(at + dur + 0.02);
}

// 걸러낸 소음 한 번: 필터 종류·주파수(→ f2), 길이, 크기, 시작
function hiss(c, { filter = "bandpass", f, f2, q = 1, dur, g = 0.3, t = 0, attack = 0.003 }) {
  const at = c.currentTime + t, s = c.createBufferSource(), bq = c.createBiquadFilter(), v = c.createGain();
  s.buffer = noiseBuffer(c);
  bq.type = filter;
  bq.frequency.setValueAtTime(f, at);
  if (f2) bq.frequency.exponentialRampToValueAtTime(f2, at + dur);
  bq.Q.value = q;
  v.gain.setValueAtTime(0.0001, at);
  v.gain.exponentialRampToValueAtTime(g, at + attack);
  v.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  s.connect(bq).connect(v).connect(master);
  s.start(at, Math.random() * 0.5);
  s.stop(at + dur + 0.02);
}

const jitter = (x, r) => x * (1 + (Math.random() * 2 - 1) * r);

// 칩 하나가 부딪히는 소리: 높은 금속성 두 음 + 짧은 잡음
function clink(c, t, g = 0.16) {
  const f = jitter(3600, 0.12);
  tone(c, { f, dur: 0.07, type: "triangle", g, t });
  tone(c, { f: f * 1.48, dur: 0.05, type: "sine", g: g * 0.5, t: t + 0.004 });
  hiss(c, { filter: "highpass", f: 5000, dur: 0.025, g: g * 0.6, t });
}

const SOUNDS = {
  // 카드가 펠트 위로 미끄러지는 소리
  deal: (c) => hiss(c, { f: jitter(3200, 0.1), f2: 1800, q: 0.8, dur: 0.09, g: 0.22 }),
  // 카드를 뒤집는 짧은 두 번의 탁
  flip: (c) => {
    hiss(c, { f: 2600, q: 1.2, dur: 0.035, g: 0.2 });
    hiss(c, { f: 1900, q: 1.2, dur: 0.04, g: 0.16, t: 0.06 });
  },
  // 테이블을 두 번 두드리는 체크
  check: (c) => {
    for (const t of [0, 0.11]) {
      tone(c, { f: 170, f2: 120, dur: 0.07, type: "triangle", g: 0.45, t });
      hiss(c, { filter: "lowpass", f: 900, dur: 0.03, g: 0.18, t });
    }
  },
  // 칩 두세 개
  chip: (c) => { const n = 2 + (Math.random() < 0.5 ? 1 : 0); for (let i = 0; i < n; i++) clink(c, i * 0.045 + Math.random() * 0.01); },
  call: (c) => SOUNDS.chip(c),
  // 레이즈: 칩을 조금 더 많이, 조금 더 크게
  raise: (c) => { for (let i = 0; i < 5; i++) clink(c, i * 0.04 + Math.random() * 0.012, 0.19); },
  // 올인: 칩 더미가 쏟아지고 낮게 쿵
  allin: (c) => {
    tone(c, { f: 90, f2: 55, dur: 0.25, type: "sine", g: 0.5 });
    for (let i = 0; i < 12; i++) clink(c, 0.03 + i * 0.03 + Math.random() * 0.02, 0.14);
  },
  // 패를 밀어 놓는 부드러운 소리
  fold: (c) => hiss(c, { filter: "lowpass", f: 1400, f2: 300, dur: 0.18, g: 0.2, attack: 0.02 }),
  // 내 차례: 맑은 두 음
  turn: (c) => {
    tone(c, { f: 659.3, dur: 0.18, g: 0.2 });
    tone(c, { f: 880, dur: 0.28, g: 0.2, t: 0.12 });
  },
  // 시간 경고: 짧은 째깍
  tick: (c) => tone(c, { f: 1250, dur: 0.03, type: "square", g: 0.06 }),
  // 팟을 땄을 때: 올라가는 아르페지오 + 칩
  win: (c) => {
    [523.3, 659.3, 784, 1046.5].forEach((f, i) => tone(c, { f, dur: 0.22, type: "triangle", g: 0.17, t: i * 0.08 }));
    for (let i = 0; i < 4; i++) clink(c, 0.3 + i * 0.05, 0.12);
  },
  // 탈락: 내려가는 두 음
  bust: (c) => {
    tone(c, { f: 392, dur: 0.25, type: "triangle", g: 0.18 });
    tone(c, { f: 311.1, dur: 0.4, type: "triangle", g: 0.18, t: 0.2 });
  },
};

function play(name) {
  if (muted || !SOUNDS[name]) return;
  if (root.document?.hidden) return; // 다른 탭에 있을 때는 조용히
  const c = ctx;
  if (!c || c.state !== "running") return; // 아직 화면을 누르기 전: 소리를 쌓아 두지 않는다
  const now = root.performance ? root.performance.now() : Date.now();
  if (now - (lastAt[name] ?? -1e9) < GAP_MS) return; // 같은 소리 연타는 한 번만
  lastAt[name] = now;
  try { SOUNDS[name](c); } catch {}
}

function setMuted(v) {
  muted = !!v;
  try { root.localStorage?.setItem(KEY, muted ? "off" : "on"); } catch {}
  if (!muted) unlock();
}

root.PokerSound = {
  play, setMuted, isMuted: () => muted, toggle: () => { setMuted(!muted); return muted; },
  state: () => (ctx ? ctx.state : "none"), // 오디오 상태 (none: 아직 화면을 누르기 전)
  names: Object.keys(SOUNDS),
};
})(globalThis);
