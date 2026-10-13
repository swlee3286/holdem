// ===== 모션 =====
// 테이블 위 움직임과 효과음: 카드 나눠 주기 · 보드 뒤집기 · 칩(자리 → 베팅 자리 → 팟 → 이긴 사람) · 폴드 · 올인 · 체크 · 뻥카 도장.
// game.js가 화면을 그린 뒤마다 PokerMotion.sync()를 부른다. 직전에 본 상태와 비교해 새로 일어난 일만 보여 주고 들려준다
// (새 행동 · 스트리트 · 단계 · 결과). 그래서 혼자 하기 · 방장 · 손님(자리별로 걸러진 화면)에서 똑같이 돌고, 처음 그릴 때 ·
// 이어하기 · 다시 연결 · 같은 화면을 다시 그릴 때는 아무것도 하지 않는다. 남의 카드는 늘 뒷면으로만 움직인다
// (무엇을 움직일지는 그려진 화면 · 공개된 정보로만 정한다).
// 움직임은 테이블 위 별도 층(.fx-layer)에 잠깐 띄우는 복제 요소(카드 · 칩 · 금액)일 뿐이다 (transform · opacity, Web Animations).
// 진짜 화면은 그 아래에 이미 맞게 그려져 있고(효과가 도착할 때까지 잠깐 투명할 뿐), 게임 진행 · 타이머 · 입력 · 통신은 움직임을 기다리지 않는다.
// 동작 줄이기(prefers-reduced-motion)에서는 움직이지 않고 소리만 난다.
//   PokerMotion.sync({ owner, m, me, quiet, mute })
//     owner: 매치 상태 객체 (바뀌면 처음 보는 화면: 비교하지 않는다) · m: 매치 (손님은 받은 화면으로 만든 매치) · me: 내 좌석
//     quiet: 움직임만 끈다 (창이 열려 있음) · mute: 움직임 · 소리 모두 끈다 (빨리 감기)
//   PokerMotion.cancel()  떠 있는 효과와 예약한 소리를 모두 지운다 (새 핸드 · 다른 탭 · 테이블을 떠날 때)
//   PokerMotion.clear()   떠 있는 효과만 지운다 (창이 열릴 때 · 자리가 옮겨질 때: 이미 일어난 일의 소리는 마저 난다)
//   PokerMotion.rebase()  다음 sync는 비교 없이 기준만 잡는다 (손님 재접속)
//   PokerMotion.fresh()   다음 sync는 새 매치의 첫 핸드로 본다 (카드 나눠 주기부터)
// 브라우저 전역 PokerMotion 하나만 만든다. 소리는 PokerSound(sound.js)로 낸다.
(function (root) {
"use strict";
const doc = root.document;
const RM = root.matchMedia ? root.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

// 시간 (ms)
const T_DEAL = 300, DEAL_GAP = 70;   // 카드 한 장 날아가는 시간 · 다음 장까지
const T_CHIP = 320;                  // 자리 → 베팅 자리
const T_COLLECT = 380;               // 베팅 자리 → 팟
const T_FLIP = 300, FLIP_GAP = 150;  // 카드 한 장 뒤집기 · 다음 장까지
const T_POT = 560, POT_GAP = 420;    // 팟 → 이긴 사람 · 다음 팟까지
const T_FOLD = 420;
const ACT_GAP = 180;                 // 한 번에 여러 행동이 들어왔을 때 사이 간격
const MAX_FX = 26;                   // 한꺼번에 떠 있는 효과 요소 (6명 · 폰에서도 부드럽게)
const MAX_LAG = 700;                 // 앞 효과가 끝나기를 기다리는 최대 시간 (진짜 화면보다 이만큼만 늦는다)
const EASE = "cubic-bezier(.25,.75,.35,1)";
const BOARD_AT = [0, 3, 4, 5];       // 스트리트별 보드 장수

const $ = (id) => doc.getElementById(id);
const now = () => root.performance.now();
const fmt = (n) => Number(n).toLocaleString("ko-KR");
let layer = null, prev = null, next = "", busyUntil = 0, box = null, sizeKey = "";
let seen = { holes: {}, chips: {}, amts: {}, pot: null }; // 직전 화면의 카드 · 베팅 칩 · 팟 자리 (지금 화면에서 사라진 것을 움직이려고)
let handNo = 0, t0 = 0, lastH = null;
let dealt = {};                      // 자리별 카드가 내려앉는 때 (performance.now 기준): 나눠 주는 중에 폴드해도 아직 안 온 카드는 보이지 않게
const anims = new Set(), timers = new Set();
const stats = { syncs: 0, played: 0, rebased: 0, fresh: 0, sprites: 0, capped: 0, errors: 0, lastError: "" };
const log = [];                      // 최근 효과 (테스트 · 디버그용): { no(핸드), ev, seat, x, y(도착 자리), t(sync 뒤 ms), at(performance.now 기준 도착), pot }

// ===== 기본 도구 =====
function nextIn(list, seat) {
  for (const s of list) if (s > seat) return s;
  return list[0];
}

function later(ms, fn) {
  const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
  timers.add(id);
}

// 소리: 지금 또는 ms 뒤 (효과와 맞춰서). 소리를 끈 상태 · 같은 소리 연타는 sound.js가 거른다
function sfx(name, at) {
  const go = () => { try { root.PokerSound?.play(name); } catch {} };
  if (!(at > 16)) go();
  else later(at, go);
}

function note(ev, seat, p, t, pot) {
  log.push({ no: handNo, ev, seat, x: p ? Math.round(p.x) : null, y: p ? Math.round(p.y) : null, t: Math.round(t), at: Math.round(t0 + t), pot });
  if (log.length > 400) log.splice(0, log.length - 400);
}

function track(a, done) {
  anims.add(a);
  const end = () => { anims.delete(a); if (done) done(); };
  a.onfinish = end;
  a.oncancel = end;
}

function tableBox() {
  const t = $("table");
  if (!t) return null;
  const r = t.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { el: t, left: r.left, top: r.top, w: r.width, h: r.height };
}

// 요소 가운데 · 크기 (테이블 기준 px). 화면에 없으면 null
function at(el) {
  if (!el || !box || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height && !r.left && !r.top) return null;
  return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top, w: r.width, h: r.height };
}

// 카드 자리: 레이아웃 기준 (돌고 있는 효과의 transform에 흔들리지 않게)
function cardAt(node) {
  const par = node && node.offsetParent;
  if (!par || !box) return null;
  const r = par.getBoundingClientRect();
  return { x: r.left + node.offsetLeft + node.offsetWidth / 2 - box.left, y: r.top + node.offsetTop + node.offsetHeight / 2 - box.top, w: node.offsetWidth, h: node.offsetHeight };
}

const plateAt = (s) => at($(`seat-${s}`)?.querySelector(".plate"));
const amtNode = (s) => $(`bet-${s}`)?.querySelector(".amt:not(.win)");
const betSpot = (s) => at(amtNode(s)?.querySelector(".chip")) || seen.chips[s] || at($(`bet-${s}`));
const potAt = () => at($("pot")?.querySelector(".chip")) || seen.pot || (box && { x: box.w / 2, y: box.h * 0.55 });

function getLayer() {
  const t = box && box.el;
  if (!t) return null;
  if (!layer || layer.parentNode !== t) {
    layer = doc.createElement("div");
    layer.className = "fx-layer";
    layer.setAttribute("aria-hidden", "true");
    t.appendChild(layer);
  }
  return layer;
}

// 효과 요소 하나. 너무 많이 떠 있으면 만들지 않는다 (진짜 화면은 이미 맞으니 건너뛰어도 된다)
function make(cls, style, html) {
  const L = getLayer();
  if (!L) return null;
  if (L.childElementCount >= MAX_FX) { stats.capped++; return null; }
  const el = doc.createElement("div");
  el.className = "fx " + cls;
  if (style) el.style.cssText = style;
  if (html) el.innerHTML = html;
  L.appendChild(el);
  stats.sprites++;
  return el;
}

// 칩 더미 (금액이 클수록 높게)
function chipsEl(amount, bb) {
  const x = amount / (bb || 1);
  const n = x <= 1 ? 1 : x <= 3 ? 2 : x <= 8 ? 3 : x <= 20 ? 4 : 5;
  let html = "";
  for (let i = 0; i < n; i++) html += `<i class="chip" style="top:${-3 * i}px"></i>`;
  return make("fx-chips", "", html);
}
// 베팅 자리에 보이던 것과 같은 모양 (칩 + 금액)
const amtEl = (amount) => make("amt", "", `<i class="chip"></i>${fmt(amount)}`);

// el이 점들을 따라 움직인다. 점: { t(지금부터 ms), x, y, o(불투명도), r(회전), s(크기), ry(뒤집기 각도), e(다음 점까지 easing) }
function fly(el, pts) {
  if (!el) return null;
  for (let i = 1; i < pts.length; i++) if (pts[i].t < pts[i - 1].t) pts[i].t = pts[i - 1].t;
  const start = Math.max(0, pts[0].t), dur = Math.max(1, pts[pts.length - 1].t - start);
  const kf = pts.map((p) => ({
    offset: Math.min(1, Math.max(0, (p.t - start) / dur)),
    opacity: p.o ?? 1,
    transform: `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,-50%) perspective(700px) rotateY(${p.ry || 0}deg) rotate(${p.r || 0}deg) scale(${p.s ?? 1})`,
    easing: p.e || "linear",
  }));
  let a;
  try { a = el.animate(kf, { delay: start, duration: dur, fill: "none" }); } catch { el.remove(); return null; }
  track(a, () => el.remove());
  return a;
}

// 진짜 요소는 이미 그 자리에 그려져 있다: 효과가 도착할 때(t)까지 투명했다가 나타난다. flip: 옆으로 섰다가 펴지며
function reveal(node, t, flip) {
  if (!node || typeof node.animate !== "function") return;
  node.classList.remove("deal", "flip");
  const from = flip ? "perspective(700px) rotateY(-90deg)" : "scale(.85)";
  const opts = { delay: Math.max(0, t), duration: flip ? T_FLIP / 2 : 150, easing: "ease-out", fill: "backwards" };
  let a;
  // 마지막 transform은 원래 값 (이긴 카드는 살짝 들려 있다)
  try { a = node.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: from, offset: 0.01 }, { opacity: 1 }], opts); }
  catch { try { a = node.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: from, offset: 0.01 }, { opacity: 1, transform: "none" }], opts); } catch { return; } }
  track(a);
}

// ===== 효과들 =====
// 새 핸드: 딜러 버튼에서 각 자리로 한 장씩 두 바퀴 (모두 뒷면으로 날아가고, 내 카드는 도착하면 뒤집힌다)
function dealFx(h, me, fx) {
  const order = [];
  for (let s = nextIn(h.seats, h.button), k = 0; k < h.seats.length; k++, s = nextIn(h.seats, s)) order.push(s);
  const from = at($(`dealer-${h.button}`)) || { x: box.w / 2, y: box.h * 0.45 };
  let k = 0, end = 0;
  for (let r = 0; r < 2; r++) {
    for (const s of order) {
      const t = k++ * DEAL_GAP;
      end = t + T_DEAL;
      sfx("deal", t);
      const node = $(`hole-${s}`)?.children[r];
      if (!fx || !node || node.dataset.k === "slot") continue;
      node.classList.remove("deal", "flip");
      const to = cardAt(node);
      const el = to && make("card back", `--w:${to.w}px`);
      if (!el) continue;
      const mine = s === me && node.dataset.k !== "back";
      const pts = [
        { t, x: from.x, y: from.y, s: 0.5, r: r ? 18 : -18, o: 0.3, e: EASE },
        { t: t + T_DEAL, x: to.x, y: to.y },
      ];
      if (mine) pts.push({ t: t + T_DEAL + T_FLIP / 2, x: to.x, y: to.y, ry: 90 });
      fly(el, pts);
      reveal(node, pts[pts.length - 1].t, mine);
      (dealt[s] = dealt[s] || [])[r] = t0 + pts[pts.length - 1].t;
      note("deal", s, to, t + T_DEAL);
    }
  }
  return end;
}

// 칩이 자리에서 베팅 자리로. 라운드가 바로 끝나면 collectFx가 이어서 팟으로 보낸다
function chipPath(s, amount, h, t) {
  const from = plateAt(s), to = betSpot(s);
  if (!from || !to) return null;
  return { amount, bb: h.bb, land: t + T_CHIP, to, pts: [{ t, x: from.x, y: from.y, s: 0.8, o: 0.4, e: EASE }, { t: t + T_CHIP, x: to.x, y: to.y }] };
}

// 베팅 자리에 내려앉는다: 진짜 금액은 칩이 도착하면 나타난다 (show = false: 라운드가 끝나 진짜 금액이 이미 없다)
function land(s, c, show) {
  const el = chipsEl(c.amount, c.bb);
  if (el) fly(el, [...c.pts, { t: c.land + 90, x: c.to.x, y: c.to.y, o: 0 }]);
  if (show) reveal(amtNode(s), c.land - 20, false);
  note("bet", s, c.to, c.land);
}

// 올인: 명패가 잠깐 빛난다
function glowFx(s, t) {
  const p = plateAt(s);
  const el = p && make("fx-glow", `width:${p.w}px;height:${p.h}px`);
  if (el) fly(el, [{ t, x: p.x, y: p.y, o: 0, e: "ease-out" }, { t: t + 180, x: p.x, y: p.y, o: 1, s: 1.05 }, { t: t + 1000, x: p.x, y: p.y, o: 0, s: 1.1 }]);
}

// 체크: 베팅 자리에 두드린 자국
function knockFx(s, t) {
  const p = betSpot(s);
  const el = p && make("fx-knock");
  if (el) fly(el, [{ t, x: p.x, y: p.y, o: 0, s: 0.4 }, { t: t + 60, x: p.x, y: p.y, o: 0.8, s: 0.7, e: "ease-out" }, { t: t + 420, x: p.x, y: p.y, o: 0, s: 1.5 }]);
}

// 폴드: 카드가 가운데로 미끄러지며 사라진다.
// 남의 카드는 이미 그리기에서 빠졌다: 직전 자리에 뒷면으로 남겨 두었다가 보낸다. 내 카드(흐리게 남는다)는 떠난 뒤 다시 나타난다.
// 아직 날아오는 카드는 내려앉을 때 나타난다 (나눠 주는 중에 폴드)
function foldFx(s, me, t) {
  const cards = seen.holes[s];
  if (!cards || !cards.length) return;
  const cx = box.w / 2, cy = box.h * 0.48;
  cards.forEach((c, i) => {
    let el = null;
    const show = Math.max(0, (dealt[s]?.[i] || 0) - t0), go = Math.max(t, show);
    const real = s === me ? $(`hole-${s}`)?.children[i] : null;
    if (real && real.dataset.k !== "back" && real.dataset.k !== "slot") {
      const L = getLayer();
      if (L && L.childElementCount < MAX_FX) {
        el = real.cloneNode(true);
        el.classList.remove("deal", "flip", "win", "dim");
        el.classList.add("fx");
        el.removeAttribute("aria-label");
        el.style.cssText = `--w:${c.w}px`;
        L.appendChild(el);
        stats.sprites++;
        reveal(real, go + T_FOLD, false);
      }
    } else el = make("card back", `--w:${c.w}px`);
    if (!el) return;
    const k = 0.45, tx = c.x + (cx - c.x) * k, ty = c.y + (cy - c.y) * k;
    const wait = show ? [{ t: 0, x: c.x, y: c.y, o: 0 }, { t: show, x: c.x, y: c.y, o: 0 }] : [];
    fly(el, [...wait, { t: show, x: c.x, y: c.y }, { t: go, x: c.x, y: c.y, e: "ease-in" }, { t: go + T_FOLD, x: tx, y: ty, o: 0, r: i ? 16 : -12, s: 0.85 }]);
  });
  note("fold", s, cards[0], t);
}

// 뒷면 → 앞면 (보드 · 쇼다운). appear: 뒷면이 나타나는 때, t: 뒤집기 시작
function flipFx(node, appear, t, drop) {
  node.classList.remove("deal", "flip");
  const r = cardAt(node);
  const el = r && make("card back", `--w:${r.w}px`);
  if (!el) return; // 진짜 카드가 그대로 보인다
  const half = T_FLIP / 2;
  fly(el, [
    { t: appear, x: r.x, y: r.y - (drop ? 8 : 0), o: drop ? 0 : 1, e: "ease-out" },
    { t: appear + (drop ? 90 : 0), x: r.x, y: r.y },
    { t, x: r.x, y: r.y, e: "ease-in" },
    { t: t + half, x: r.x, y: r.y, ry: 90 },
  ]);
  reveal(node, t + half, true);
}

// 플롭 · 턴 · 리버: 뒷면으로 놓였다가 한 장씩 뒤집힌다
function boardFx(from, to, T, fx) {
  const nodes = $("board")?.children || [];
  for (let i = from; i < to; i++) {
    const t = T + (i - from) * FLIP_GAP;
    sfx("flip", t);
    if (fx && nodes[i]) { flipFx(nodes[i], Math.max(0, T - 120), t, true); note("board", i, cardAt(nodes[i]), t); }
  }
  return to > from ? T + (to - from - 1) * FLIP_GAP + T_FLIP : T;
}

// 이번 스트리트에 낸 칩 (돌려받은 몫은 따로)
function streetBets(h, s) {
  const put = {}, back = {};
  for (const a of h.actions) {
    if (a.street !== s) continue;
    if (a.type === "sb" || a.type === "bb" || a.type === "call") put[a.seat] = (put[a.seat] || 0) + (a.amount || 0);
    else if (a.type === "bet" || a.type === "raise") put[a.seat] = a.to || 0;
    else if (a.type === "return") back[a.seat] = (back[a.seat] || 0) + (a.amount || 0);
  }
  return { put, back };
}

// 라운드 끝: 모든 베팅(칩 + 금액)이 팟으로 미끄러진다 (받지 않은 몫은 자기 자리로)
function collectFx(h, s, T, pend, fx) {
  const { put, back } = streetBets(h, s);
  const seats = Object.keys(put).map(Number).filter((k) => put[k] > 0);
  if (!seats.length) return T;
  let start = T;
  for (const k of seats) if (pend[k]) start = Math.max(start, pend[k].land);
  const pot = potAt();
  for (const k of seats) {
    const c = pend[k];
    delete pend[k];
    if (!fx) continue;
    if (c) land(k, c, false);
    // 직전 화면에 보이던 금액 자리 (방금 낸 칩이면 칩이 내려앉은 자리)
    const spot = (!c && seen.amts[k]) || (c && c.to) || betSpot(k);
    if (!spot) continue;
    const from = c ? c.land - 30 : 0;
    const keep = put[k] - (back[k] || 0);
    if (keep > 0 && pot) {
      fly(amtEl(keep), [{ t: from, x: spot.x, y: spot.y }, { t: start, x: spot.x, y: spot.y, e: EASE }, { t: start + T_COLLECT * 0.8, x: pot.x, y: pot.y, s: 0.85 }, { t: start + T_COLLECT, x: pot.x, y: pot.y, o: 0, s: 0.7 }]);
      note("collect", k, pot, start + T_COLLECT);
    }
    const home = back[k] > 0 && plateAt(k);
    if (home) {
      fly(amtEl(back[k]), [{ t: from, x: spot.x, y: spot.y, o: keep > 0 ? 0 : 1 }, { t: start, x: spot.x, y: spot.y, e: EASE }, { t: start + T_COLLECT * 0.8, x: home.x, y: home.y, s: 0.85 }, { t: start + T_COLLECT, x: home.x, y: home.y, o: 0, s: 0.7 }]);
      note("return", k, home, start + T_COLLECT);
    }
  }
  return start + T_COLLECT;
}

// 쇼다운 · 올인으로 새로 공개된 남의 카드
function showFx(p, h, me, T, fx) {
  let any = false;
  for (const s of h.seats) {
    if (s === me || h.folded[s] || !h.shown[s] || (p && p.shown[s])) continue;
    const nodes = [...($(`hole-${s}`)?.children || [])].filter((n) => n.dataset.k !== "back" && n.dataset.k !== "slot");
    if (!nodes.length) continue;
    any = true;
    if (fx) nodes.forEach((n, i) => flipFx(n, 0, T + i * 60, false));
    note("show", s, null, T);
  }
  if (!any) return T;
  sfx("flip", T);
  return T + 60 + T_FLIP;
}

// 쇼다운: 카드가 다 펴질 때(t)까지 족보 이름 · 이긴 카드 표시 · 결과 줄을 감춘다 (카드보다 먼저 알려 주지 않게)
function holdFx(t) {
  if (!(t > 16)) return;
  for (const el of doc.querySelectorAll(".bet .tag.lbl, #controls .result, #controls .net")) reveal(el, t, false);
  const tb = box.el;
  tb.classList.add("fx-hold");
  later(t, () => tb.classList.remove("fx-hold"));
}

// 쇼다운에서 뻥카가 들켰다(끝까지 약한 패): game.js가 그린 '뻥카!' 표시(.bet .tag.bluff)가 카드가 펴진 뒤 도장처럼 찍힌다. 소리는 핸드에 한 번
function bluffFx(T, fx) {
  const tags = [...doc.querySelectorAll(".bet .tag.bluff")];
  if (!tags.length) return;
  sfx("bluff", T);
  if (!fx) return;
  tags.forEach((el, i) => {
    if (typeof el.animate !== "function") return;
    const t = T + i * 90;
    let a;
    try {
      a = el.animate([
        { opacity: 0, transform: "scale(2.3) rotate(-20deg)" },
        { opacity: 1, transform: "scale(.88) rotate(-4deg)", offset: 0.55 },
        { opacity: 1, transform: "scale(1.08) rotate(-8deg)", offset: 0.8 },
        { opacity: 1, transform: "rotate(-6deg)" }, // style.css의 .tag.bluff와 같은 기울기
      ], { delay: t, duration: 380, easing: "cubic-bezier(.3,.7,.4,1)", fill: "backwards" });
    } catch { return; }
    track(a);
    note("bluff", Number(el.parentElement?.id?.slice(4)), at(el), t);
  });
}

// 핸드 끝: 팟마다 따로 이긴 사람(들)에게 (금액이 적힌 칩). 사이드 팟은 차례로, 나눔이면 각자의 몫이 각자에게
function potFx(h, me, T, fx) {
  const r = h.result;
  if (!r || !r.pots || !r.pots.length) return T;
  const base = potAt();
  let t = T, won = false;
  const first = {};
  r.pots.forEach((pot, i) => {
    const from = base && { x: base.x + (i - (r.pots.length - 1) / 2) * 16, y: base.y };
    for (const w of pot.winners) {
      const spot = $(`bet-${w}`)?.querySelector(".amt.win");
      const to = at(spot?.querySelector(".chip")) || plateAt(w);
      if (!(w in first)) first[w] = { at: t + T_POT, spot };
      if (!fx || !from || !to) continue;
      const share = Math.floor(pot.amount / pot.winners.length);
      fly(make("fx-pot", "", `<i class="chip"></i>${fmt(share)}`), [
        { t, x: from.x, y: from.y, o: 0, s: 0.9 },
        { t: t + 90, x: from.x, y: from.y, e: EASE },
        { t: t + T_POT, x: to.x, y: to.y },
        { t: t + T_POT + 140, x: to.x, y: to.y, o: 0 },
      ]);
      note("pot", w, to, t + T_POT, i);
    }
    if (!won && pot.winners.includes(me)) { won = true; sfx("win", t + T_POT - 80); }
    else sfx("chip", t + T_POT - 40);
    t += POT_GAP;
  });
  if (fx) for (const w in first) reveal(first[w].spot, first[w].at - 30, false); // 딴 금액은 첫 팟이 도착하면
  return t - POT_GAP + T_POT;
}

// ===== 비교 =====
// p(직전 상태)에서 h(지금)까지 새로 일어난 일을 차례대로. p가 없으면 새 핸드의 처음부터
function play(p, h, m, me, fx) {
  const newHand = !p || p.no !== h.no;
  if (newHand) cancel();
  handNo = h.no;
  t0 = now();
  let T = newHand ? 0 : Math.min(Math.max(0, busyUntil - t0), MAX_LAG);
  let dealEnd = 0;
  if (newHand) dealEnd = dealFx(h, me, fx);
  const pend = {};
  let ai = newHand ? 0 : p.n, board = newHand ? 0 : p.board, first = true, faceUp = 0;
  let collected = newHand ? -1 : p.phase === "bet" ? p.street - 1 : p.street;
  const lastCol = h.phase === "bet" ? h.street - 1 : h.street;
  for (let s = newHand ? 0 : p.street; s <= h.street; s++) {
    if (s > 0 && board < Math.min(BOARD_AT[s], h.board.length)) {
      T = faceUp = boardFx(board, Math.min(BOARD_AT[s], h.board.length), T, fx);
      board = Math.min(BOARD_AT[s], h.board.length);
    }
    for (; ai < h.actions.length && h.actions[ai].street === s; ai++) {
      const a = h.actions[ai], k = a.seat;
      if (a.type === "return") continue; // 라운드 끝에서 같이
      const blind = a.type === "sb" || a.type === "bb";
      if (newHand && !blind && first) { T = Math.max(T, Math.min(dealEnd, 900)); first = false; }
      const t = blind ? 0 : T;
      if (a.type === "fold") {
        sfx("fold", t);
        if (fx) foldFx(k, me, t);
      } else if (a.type === "check") {
        sfx("check", t);
        if (fx) knockFx(k, t);
      } else {
        sfx(a.allin ? "allin" : blind || a.type === "bet" ? "chip" : a.type, t);
        if (a.allin && fx) glowFx(k, t);
        if (fx) {
          if (pend[k]) land(k, pend[k], false);
          const c = chipPath(k, a.to ?? a.amount ?? 0, h, t);
          if (c) pend[k] = c;
          else delete pend[k];
        }
      }
      if (!blind) T = t + ACT_GAP;
    }
    if (s > collected && s <= lastCol) {
      T = collectFx(h, s, T, pend, fx);
      collected = s;
    }
  }
  for (const k of Object.keys(pend)) land(Number(k), pend[k], true);
  if (fx && faceUp && h.phase !== "done") reveal($("made"), faceUp, false); // 지금 내 패 이름은 새 보드 카드가 펴진 뒤에
  T = showFx(newHand ? null : p, h, me, T, fx);
  const fin = h.phase === "done" && (newHand || p.phase !== "done");
  if (fin && fx && h.result?.showdown) holdFx(T);
  if (fin && h.result?.showdown) bluffFx(T, fx);
  if (fin) T = potFx(h, me, T, fx);
  if (!newHand && p.out[me] === false && m.players[me]?.out) sfx("bust", Math.min(T + 250, 1450)); // 탈락 창(1.6초 뒤)보다 먼저
  // 내 차례가 새로 왔을 때 한 번
  if (h.phase === "bet" && h.toAct === me && (newHand || p.n !== h.actions.length || p.toAct !== me || p.phase !== "bet")) sfx("turn", Math.min(Math.max(T, dealEnd), 900));
  busyUntil = Math.max(busyUntil, t0 + Math.max(T, dealEnd));
  stats.played++;
}

// 직전 화면의 카드 · 베팅 칩 · 팟 자리를 기억한다 (다음 sync에서 사라진 것을 움직일 때 쓴다)
function remember(h) {
  lastH = h;
  const o = { holes: {}, chips: {}, amts: {}, pot: null };
  if (box) {
    for (const s of h.seats) {
      const cards = $(`hole-${s}`)?.children;
      if (cards && cards.length) o.holes[s] = [...cards].map(cardAt).filter(Boolean);
      const amt = amtNode(s), c = at(amt?.querySelector(".chip"));
      if (c) { o.chips[s] = c; o.amts[s] = at(amt); }
    }
    o.pot = at($("pot")?.querySelector(".chip"));
  }
  seen = o;
}

function sync(o) {
  const m = o && o.m, h = m && m.hand;
  if (!h || !doc) return;
  stats.syncs++;
  const p = prev, mode = next;
  next = "";
  prev = { owner: o.owner, me: o.me, no: h.no, n: h.actions.length, street: h.street, phase: h.phase, board: h.board.length, toAct: h.toAct, shown: h.shown.slice(), out: m.players.map((x) => !!x.out) };
  if (mode === "rebase") stats.rebased++;
  else if (mode === "fresh") stats.fresh++;
  box = tableBox();
  const key = box ? `${Math.round(box.w)}x${Math.round(box.h)}` : "";
  if (key !== sizeKey) { sizeKey = key; clearFx(); }
  const same = p && p.owner === o.owner && p.me === o.me;
  if (box && !doc.hidden && !o.mute && (mode === "fresh" || (same && mode !== "rebase"))) {
    const fx = !RM.matches && !o.quiet && typeof doc.body.animate === "function";
    if (!fx) clearFx(); // 움직임만 지운다 (예약한 소리는 그대로)
    try { play(mode === "fresh" ? null : p, h, m, o.me, fx); }
    catch (e) { stats.errors++; stats.lastError = String(e && e.stack || e); cancel(); }
  } else cancel();
  try { remember(h); } catch { seen = { holes: {}, chips: {}, amts: {}, pot: null }; }
}

function clearFx() {
  for (const a of [...anims]) { try { a.cancel(); } catch {} }
  anims.clear();
  if (layer) layer.textContent = "";
  $("table")?.classList.remove("fx-hold");
  busyUntil = 0;
  dealt = {};
}

function cancel() {
  clearFx();
  for (const id of timers) clearTimeout(id);
  timers.clear();
}

// 다른 탭으로 가면 효과 · 예약한 소리를 모두, 화면 크기 · 동작 줄이기가 바뀌면 효과만 지운다 (진짜 화면은 그대로)
if (doc) {
  doc.addEventListener("visibilitychange", () => { if (doc.hidden) cancel(); });
  root.addEventListener("resize", () => {
    const b = tableBox(), key = b ? `${Math.round(b.w)}x${Math.round(b.h)}` : "";
    if (key === sizeKey) return;
    sizeKey = key;
    clearFx(); // 자리가 옮겨졌다: 움직임만 지운다 (이미 일어난 일의 소리는 마저)
    box = b; // 기억해 둔 자리도 새 크기로
    try { if (lastH) remember(lastH); } catch { seen = { holes: {}, chips: {}, amts: {}, pot: null }; }
  });
  RM.addEventListener?.("change", clearFx);
}

root.PokerMotion = {
  sync, cancel, clear: clearFx,
  rebase() { next = "rebase"; },
  fresh() { next = "fresh"; },
  active: () => (layer ? layer.childElementCount : 0) + timers.size,
  stats, log,
};
})(globalThis);
