// ===== 이번 게임 상대 읽기 (뻥카 · 접는 성향) =====
// 지금 하고 있는 게임(매치) 안에서 본 것만 쓴다. 새 게임이면 create()로 0부터 다시 시작하고, 사람(이름·기기)에 묶어 두지 않는다.
// 같은 게임을 이어하면(새로고침) 저장해 둔 상태를 그대로 이어 쓴다. 상태는 JSON으로 저장할 수 있는 순수 데이터다.
// 공개 정보만 읽는다: 모두가 본 액션(베팅 크기 · 폴드 · 누가 쇼다운 없이 가져갔는지)과,
// 테이블에 실제로 공개된 카드(h.shown[s]가 참인 자리: 쇼다운 · 올인 공개)뿐. 폴드 · 머크 · 쇼다운 없이 이긴 자리의 카드, 덱은 읽지 않는다.
//   PokerReads.create(nSeats) → reads · PokerReads.valid(reads, nSeats) → 저장해 둔 읽기 모양 검사
//   PokerReads.record(reads, m, h) → 끝난 핸드 하나를 더한다 (같은 핸드 번호를 두 번 부르면 무시하고 false)
//   PokerReads.revealed(h) → 공개된 카드로 판정한 플롭 이후 벳·레이즈 목록 (방장의 전체 핸드 · 손님이 받은 화면 모두)
//   PokerReads.profile(reads, seat) → 표본이 적으면 GTO 기준값과 같아지는(수축) 추정치 · 신뢰도
//   PokerReads.summaryKo(reads, seat) · summaryEn(reads, seat, name) → 화면용 짧은 한국어 · Claude 프롬프트용 영어 (표본 수 포함)
// 브라우저 전역 PokerReads 하나만 만든다. node에서는 require('./reads.js'). engine.js(evaluate · straightHigh · describe)만 쓴다.
(function (root) {
"use strict";
const PK = typeof module !== "undefined" && typeof require === "function" ? require("./engine.js") : root;

// ===== 기준값: GTO 엔진끼리 둔 결과(헤즈업 · 3인 · 6인 각 3000핸드, 100bb)에 맞췄다 =====
// 세 가지 신호 모두 '관찰 − GTO 기대'를 쌓는다. GTO처럼 두는 상대는 초과분이 0 근처라 엔진이 거의 조정하지 않는다
const V = 1;
const DECAY = 0.99;   // 핸드마다 지난 기록의 무게를 이만큼 줄인다 (69핸드 전 기록이 절반). 이번 게임 안에서만
const K_FOLD = 16;    // 가상 표본(이만큼은 GTO처럼 했다고 보고 시작한다): 베팅을 맞은 횟수
const K_AGGR = 20;    //   먼저 벳할 수 있었던 횟수
const K_SHOW = 10;    //   공개된 벳·레이즈
const K_RIVER = 8;    //   공개된 리버 벳·레이즈
const HANDS_FULL = 20; // 엔진이 쓰는 읽기(bluffy · foldAdj)는 이 자리와 함께 둔 핸드 수 / 20 만큼만 믿는다 → 몇 핸드로는 극단적인 일이 있어도 크게 움직이지 않는다
// 1) 베팅을 맞았을 때 기대 폴드 = 1 − (gto.js postPlan의 MDF 방어 빈도) + 보정(GTO 엔진이 실제로 접은 몫과의 차이). [-, 플롭, 턴, 리버]
const FOLD_OFFSET = [0, -0.06, 0, 0.01];
// 2) 먼저 벳할 수 있을 때 GTO 엔진의 벳 빈도: 역할(gto.js postCtx와 같은 구분) × 살아 있는 상대 수(1 · 2 · 3+)
const BET_BASE = {
  cbet: [0.6, 0.32, 0.2],    // 앞 스트리트 마지막 공격자
  donk: [0.05, 0.025, 0.02], // 앞 스트리트 공격자보다 먼저
  stab: [0.42, 0.24, 0.12],  // 체크를 받았거나 공격자가 체크한 뒤
  lead: [0.37, 0.21, 0.13],  // 앞 스트리트에 공격이 없었다
};
// 3) 공개된 벳·레이즈의 뻥카 점수(뻥카 1 · 세미 0.5 · 밸류 0) 평균. 헤즈업 테이블은 레인지가 넓어 뻥카가 조금 더 많다
const SHOW_BASE = { hu: 0.295, multi: 0.26 }, RIVER_BASE = { hu: 0.26, multi: 0.23 };
// 뻥카 지수 (−1 ~ 1) = 0.5 × 먼저 벳 초과분 / 0.3 + 1 × 공개 뻥카 초과분 / (위로 0.35 · 아래로 기준값)
// 공개된 패가 가장 직접적인 증거라 무게가 크다. '한 번도 뻥카가 없었다'가 −1 쪽까지 갈 수 있게 아래쪽은 기준값으로 나눈다
//   bluffyFirst : 먼저 벳 초과분 그대로 + 공개된 패 → 첫 벳을 맞았을 때 (먼저 벳이 드문 사람의 벳은 밸류가 많다)
//   bluffy      : 먼저 벳은 GTO보다 자주 할 때만 + 공개된 패 → 요약의 성향 이름. 먼저 벳을 덜 하는 건 뻥카가 없어서인지 모르니
//                 (예: 먼저 벳은 안 하고 체크 레이즈로 뻥카를 치는 사람) '뻥카 거의 없음'은 공개된 패로만 붙인다
//   bluffyShown : 공개된 패만 → 레이즈를 맞았을 때 (레이즈는 먼저 벳 빈도와 상관없다)
//   리버는 각각 리버 공개 표본을 먼저 믿는 리버 지수(bluffyRiver · bluffyRiverFirst · bluffyRiverShown)
const W_AGGR = 0.5, AGGR_SCALE = 0.3, W_SHOW = 1, SHOW_SCALE = 0.35;
// 성향 이름(요약 · 엔진 손잡이 공통): GTO처럼 두는 상대의 표본 잡음(150핸드 뒤 뻥카 지수 표준편차 약 0.2 · 폴드 초과 약 0.05) 밖일 때만
const TRAIT_BLUFFY = 0.45, TRAIT_FOLD = 0.12;

// ===== 공개된 벳·레이즈 판정 기준 =====
// hs = 그 스트리트 보드에서 남은 모든 조합(내 카드·보드와 겹치는 것 제외) 상대 지금 족보의 승률(비김 1/2)을 그때 살아 있던 상대 수만큼 거듭제곱
//   value: hs ≥ VALUE_HS (플롭·턴 0.6, 리버 0.5 — 리버는 '무작위 패 절반도 못 이기는 패'면 약한 패)
//   semi : 약한 패지만 플롭·턴에서 진짜 드로우 (플러시 드로우 · 양방 이상 스트레이트 드로우 = 8아웃 이상)
//   bluff: 그 밖의 약한 패. 리버의 약한 벳·레이즈는 모두
// GTO 엔진이 스스로 붙이는 이름(밸류 / 블러프 · 세미 · 얇은 벳)과 가장 잘 맞는 값이다 (일치율 플롭 95% · 턴 94% · 리버 95%)
const VALUE_HS = [1, 0.6, 0.6, 0.5];
const LABEL_KO = { value: "밸류", semi: "세미 블러프", bluff: "뻥카" };

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const r3 = (x) => Math.round(x * 1000) / 1000;

// ===== 상태 =====
function newSeat() {
  return {
    hands: 0, vpip: 0, pfr: 0,                         // 받은 핸드 · 프리플롭 자발적 참여 · 레이즈 (횟수)
    bets: 0, raises: 0, calls: 0, checks: 0, folds: 0, // 플롭 이후 행동 수
    faced: 0, foldFaced: 0,                            // 플롭 이후 벳·레이즈를 맞은 횟수 · 그때 폴드
    betOpp: 0,                                         // 플롭 이후 먼저 벳할 수 있었던 횟수 (그때 벳한 수 = bets)
    takedowns: 0, showdowns: 0,                        // 마지막 공격자로 쇼다운 없이 가져간 팟 · 쇼다운까지 간 횟수
    shown: { value: 0, semi: 0, bluff: 0 },            // 공개된 벳·레이즈 판정
    river: { value: 0, bluff: 0 },                     // 그중 리버
    // 추정용 가중 합 (핸드마다 DECAY를 곱한다). N 표본 · X (관찰 − GTO 기대) 합 · E GTO 기대 합
    //   f 베팅을 맞았을 때 폴드 · a 먼저 벳할 수 있을 때 벳 · s 공개된 벳·레이즈의 뻥카 점수 · r 그중 리버
    w: { fN: 0, fX: 0, fE: 0, aN: 0, aX: 0, aE: 0, sN: 0, sX: 0, sE: 0, rN: 0, rX: 0, rE: 0 },
  };
}

function create(nSeats) {
  const n = clamp(Math.floor(Number(nSeats) || 0), 0, 10);
  return { v: V, last: 0, hands: 0, seats: Array.from({ length: n }, newSeat) };
}

// 저장해 둔 읽기(이어하기 · 방장 새로고침)가 이 모양이 맞는지. nSeats를 주면 자리 수도 같아야 한다. 틀리면 false → 부르는 쪽이 create()로 새로
function valid(reads, nSeats) {
  const cnt = (x) => Number.isInteger(x) && x >= 0 && x <= 1e7;
  const num = (x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1e7;
  if (!reads || typeof reads !== "object" || reads.v !== V || !cnt(reads.last) || !cnt(reads.hands) || !Array.isArray(reads.seats)) return false;
  if (reads.seats.length > 10 || (nSeats != null && reads.seats.length !== nSeats)) return false;
  const tmpl = newSeat();
  return reads.seats.every((z) => {
    if (!z || typeof z !== "object") return false;
    for (const k of Object.keys(tmpl)) {
      const t = tmpl[k], o = z[k];
      if (typeof t === "number") { if (!cnt(o)) return false; continue; }
      if (!o || typeof o !== "object") return false;
      for (const kk of Object.keys(t)) if (!(k === "w" ? num(o[kk]) && (kk.endsWith("X") || o[kk] >= 0) : cnt(o[kk]))) return false;
    }
    return true;
  });
}

// ===== 액션 재생 (공개된 액션만) =====
// 각 행동 직전의 상황을 visit(a, ctx)로 알려 준다. ctx: street · toCall · pot · maxBet · nBets · opps(살아 있는 상대) · role · kResp
function walk(h, visit) {
  const N = h.start.length;
  const stack = h.start.slice(), bets = new Array(N).fill(0), contrib = new Array(N).fill(0);
  const folded = new Array(N).fill(true), acted = new Array(N).fill(false), aggr = [-1, -1, -1, -1];
  for (const s of h.seats) folded[s] = false;
  let street = 0, maxBet = 0, nBets = 0;
  const pay = (s, x) => { stack[s] -= x; bets[s] += x; contrib[s] += x; };
  for (const a of h.actions) {
    if (a.street > street) { street = a.street; bets.fill(0); maxBet = 0; nBets = 0; acted.fill(false); }
    const s = a.seat;
    if (a.type === "sb" || a.type === "bb") { pay(s, a.amount); maxBet = Math.max(maxBet, bets[s]); continue; }
    if (a.type === "return") {
      stack[s] += a.amount; bets[s] -= a.amount; contrib[s] -= a.amount;
      maxBet = Math.max(0, ...h.seats.map((x) => bets[x]));
      continue;
    }
    const opps = [];
    let pot = 0;
    for (const o of h.seats) { pot += contrib[o]; if (o !== s && !folded[o]) opps.push(o); }
    const need = street === 0 ? Math.max(maxBet, h.bb) : maxBet;
    const toCall = Math.max(0, Math.min(need - bets[s], stack[s]));
    let role = "";
    if (street > 0) { // gto.js postCtx와 같은 역할 구분
      const prev = aggr[street - 1];
      const prevLive = prev >= 0 && prev !== s && !folded[prev] && stack[prev] > 0;
      if (prev === s) role = "cbet";
      else if (prevLive && !acted[prev]) role = "donk";
      else if (prevLive || opps.some((o) => acted[o])) role = "stab";
      else role = "lead";
    }
    let kResp = 0;
    for (const o of h.seats) if (!folded[o] && o !== aggr[street] && stack[o] > 0 && bets[o] < maxBet) kResp++;
    visit(a, { street, toCall, pot, maxBet, nBets, opps, role, kResp: Math.max(1, kResp) });
    if (a.type === "fold") folded[s] = true;
    else if (a.type === "call") pay(s, a.amount || 0);
    else if (a.type === "bet" || a.type === "raise") {
      pay(s, a.to - bets[s]);
      maxBet = Math.max(maxBet, a.to);
      aggr[street] = s;
      nBets++;
    }
    acted[s] = true;
  }
}

// gto.js postPlan의 MDF와 같은 식으로 본 'GTO 엔진이라면 이 베팅에 접는 몫'
function expectFold(ctx) {
  const alpha = clamp(ctx.maxBet / Math.max(ctx.pot, 1), 0.05, 0.85);
  let d = 1 - Math.pow(alpha, 1 / ctx.kResp);
  if (ctx.nBets >= 2) d *= 0.85;
  return clamp(1 - d + FOLD_OFFSET[ctx.street], 0, 1);
}
const expectBet = (ctx) => BET_BASE[ctx.role][Math.min(ctx.opps.length, 3) - 1];

// ===== 공개된 패 판정 =====
// 남은 모든 조합 상대 지금 족보의 승률 (비김 1/2)
function handStrength(hole, board) {
  const dead = new Uint8Array(52);
  for (const c of hole) dead[c] = 1;
  for (const c of board) dead[c] = 1;
  const mine = PK.evaluate(hole.concat(board)), cards = [0, 0, ...board];
  let win = 0, tie = 0, n = 0;
  for (let a = 1; a < 52; a++) {
    if (dead[a]) continue;
    cards[0] = a;
    for (let b = 0; b < a; b++) {
      if (dead[b]) continue;
      cards[1] = b;
      const sc = PK.evaluate(cards);
      if (sc < mine) win++; else if (sc === mine) tie++;
      n++;
    }
  }
  return { hs: n ? (win + 0.5 * tie) / n : 0.5, nuts: n > 0 && win + tie === n, score: mine };
}

// 진짜 드로우: 플러시 드로우(내 카드 한 장 이상 포함 4장) · 양방 이상 스트레이트 드로우(보드만으로는 안 되는 스트레이트를 만드는 랭크가 2개 이상)
function drawOf(hole, board) {
  if (board.length >= 5) return null;
  const sc = [0, 0, 0, 0], own = [0, 0, 0, 0];
  let mask = 0, bMask = 0;
  for (const c of hole) { sc[c & 3]++; own[c & 3]++; mask |= 1 << (c >> 2); }
  for (const c of board) { sc[c & 3]++; mask |= 1 << (c >> 2); bMask |= 1 << (c >> 2); }
  let flush = false;
  for (let s = 0; s < 4; s++) if (sc[s] === 4 && own[s] > 0) flush = true;
  let outs = 0;
  if (PK.straightHigh(mask) < 0) {
    for (let r = 0; r < 13; r++) {
      if ((mask >> r) & 1) continue;
      const sh = PK.straightHigh(mask | (1 << r));
      if (sh >= 0 && PK.straightHigh(bMask | (1 << r)) < sh) outs++;
    }
  }
  const straight = outs >= 2;
  return flush && straight ? "combo" : flush ? "flush" : straight ? "straight" : null;
}

// hole: 공개된 두 장, board: 그 스트리트의 보드, k: 그때 살아 있던 상대 수
// 어떤 조합에도 지지 않는 패(넛 · 보드가 넛이라 나눠 갖는 패)는 상대가 몇이든 밸류
function classify(hole, board, k) {
  const { hs, nuts, score } = handStrength(hole, board);
  const hsk = Math.pow(hs, Math.max(1, k));
  const street = board.length === 3 ? 1 : board.length === 4 ? 2 : 3;
  const draw = street < 3 ? drawOf(hole, board) : null;
  const label = nuts || hsk >= VALUE_HS[street] ? "value" : draw ? "semi" : "bluff";
  return { label, hs: r3(hsk), draw, score };
}

// 공개된(shown) 자리의 카드만 꺼낸다. 공개되지 않은 자리의 hole은 읽지도 않는다
function shownHole(h, s) {
  if (!h.shown || !h.shown[s] || !h.hole) return null;
  const cs = h.hole[s];
  return cs && cs.length === 2 && Number.isInteger(cs[0]) && Number.isInteger(cs[1]) ? [cs[0], cs[1]] : null;
}

// 끝난(또는 올인으로 카드가 공개된) 핸드에서 공개된 자리의 플롭 이후 벳·레이즈를 판정한다.
// → [{ seat, street(1~3), type("bet"|"raise"), to, label("value"|"semi"|"bluff"), labelKo, hs, draw, hand(한국어 족보), handEn, score(그때 족보 점수), weakEnd }]
//   연결이 끊긴 손님 자리를 AI가 대신 둔 벳(a.auto)은 그 사람의 벳이 아니라 판정하지 않는다
//   weakEnd: 보드 다섯 장이 다 깔렸을 때 그 자리의 마지막 패가 여전히 약한지 (무작위 패 절반도 못 이김 = 들킨 뻥카). 보드가 덜 깔렸으면 null.
//   플롭 뻥카였어도 나중에 맞아서 강해졌으면 false (화면에서 '뻥카!' 도장은 찍지 않는다)
const REV = new WeakMap();
function revealed(h) {
  if (!h || !Array.isArray(h.actions) || !Array.isArray(h.board) || !Array.isArray(h.seats) || !Array.isArray(h.start) || !Array.isArray(h.shown)) return [];
  const key = `${h.no}|${h.actions.length}|${h.board.length}|${h.shown.join()}`;
  const hit = REV.get(h);
  if (hit && hit.key === key) return hit.list.map((x) => Object.assign({}, x));
  const holes = {};
  let any = false;
  for (const s of h.seats) { const cs = shownHole(h, s); if (cs) { holes[s] = cs; any = true; } }
  const list = [], weakEnd = {};
  if (any && h.board.length === 5) for (const s in holes) weakEnd[s] = handStrength(holes[s], h.board).hs < VALUE_HS[3];
  if (any) {
    walk(h, (a, ctx) => {
      if (ctx.street === 0 || (a.type !== "bet" && a.type !== "raise")) return;
      const hole = holes[a.seat];
      const board = h.board.slice(0, ctx.street + 2);
      if (!hole || a.auto || board.length !== ctx.street + 2) return;
      const c = classify(hole, board, ctx.opps.length);
      list.push({
        seat: a.seat, street: ctx.street, type: a.type, to: a.to, label: c.label, labelKo: LABEL_KO[c.label],
        hs: c.hs, draw: c.draw, hand: PK.describe(c.score), handEn: PK.describeEn(c.score), score: c.score,
        weakEnd: h.board.length === 5 ? weakEnd[a.seat] : null,
      });
    });
  }
  REV.set(h, { key, list });
  return list.map((x) => Object.assign({}, x));
}

// ===== 기록 =====
// 핸드가 끝났을 때(h.phase === "done") 한 번. 같은 번호(또는 더 앞 번호)의 핸드는 무시한다 → 두 번 불러도 두 번 세지 않는다
function record(reads, m, h) {
  if (!reads || !Array.isArray(reads.seats) || !h || h.phase !== "done" || !h.result || !Number.isFinite(h.no)) return false;
  if (!Array.isArray(h.actions) || !Array.isArray(h.seats) || !Array.isArray(h.start) || !Array.isArray(h.shown) || !Array.isArray(h.result.won)) return false;
  if (h.no <= reads.last) return false;
  reads.last = h.no;
  reads.hands++;
  const N = Math.max(h.start.length, (m && m.players && m.players.length) || 0);
  while (reads.seats.length < N) reads.seats.push(newSeat());
  const flags = {};
  for (const s of h.seats) {
    const z = reads.seats[s], w = z.w;
    for (const k in w) w[k] *= DECAY;
    z.hands++;
    flags[s] = { vpip: false, pfr: false };
  }
  let lastAggr = -1;
  walk(h, (a, ctx) => {
    const z = reads.seats[a.seat], w = z.w, t = a.type;
    if (t === "bet" || t === "raise") lastAggr = a.seat;
    if (a.timeout || a.auto) return; // 시간 초과로 자동 체크·폴드 · 연결이 끊겨 AI가 대신 둔 수는 그 사람의 성향이 아니다
    if (ctx.street === 0) {
      if (t === "call" || t === "raise") flags[a.seat].vpip = true;
      if (t === "raise") flags[a.seat].pfr = true;
      return;
    }
    if (t === "bet") z.bets++;
    else if (t === "raise") z.raises++;
    else if (t === "call") z.calls++;
    else if (t === "check") z.checks++;
    else if (t === "fold") z.folds++;
    if (ctx.toCall > 0 && (t === "fold" || t === "call" || t === "raise")) {
      const fold = t === "fold" ? 1 : 0, e = expectFold(ctx);
      z.faced++;
      z.foldFaced += fold;
      w.fN += 1; w.fX += fold - e; w.fE += e;
    } else if (ctx.toCall === 0 && (t === "check" || t === "bet") && ctx.opps.length) {
      const bet = t === "bet" ? 1 : 0, e = expectBet(ctx);
      z.betOpp++;
      w.aN += 1; w.aX += bet - e; w.aE += e;
    }
  });
  for (const s of h.seats) {
    if (flags[s].vpip) reads.seats[s].vpip++;
    if (flags[s].pfr) reads.seats[s].pfr++;
  }
  const r = h.result;
  if (r.showdown) {
    for (const s of h.seats) if (h.shown[s] && !h.folded[s]) reads.seats[s].showdowns++;
  } else {
    const winner = h.seats.find((s) => r.won[s] > 0);
    if (winner != null && winner === lastAggr) reads.seats[winner].takedowns++;
  }
  const hu = h.seats.length === 2;
  for (const x of revealed(h)) {
    const z = reads.seats[x.seat], w = z.w;
    const score = x.label === "bluff" ? 1 : x.label === "semi" ? 0.5 : 0;
    const base = hu ? SHOW_BASE.hu : SHOW_BASE.multi;
    z.shown[x.label]++;
    w.sN += 1; w.sX += score - base; w.sE += base;
    if (x.street === 3) {
      const rb = hu ? RIVER_BASE.hu : RIVER_BASE.multi;
      z.river[x.label === "bluff" ? "bluff" : "value"]++;
      w.rN += 1; w.rX += score - rb; w.rE += rb;
    }
  }
  return true;
}

// ===== 추정 =====
// 초과분 X = Σ(관찰 − GTO 기대) / (표본 + 가상 표본). 표본이 없으면 정확히 0 (GTO 기준값 그대로), 쌓일수록 관찰값 쪽으로 간다.
// 엔진(gto.js)과 요약이 쓰는 값(bluffy · bluffyRiver · foldAdj)에는 핸드 수 신뢰도 trust = min(1, 핸드 / 20)를 한 번 더 곱한다
function profile(reads, seat) {
  const z = (reads && Array.isArray(reads.seats) && reads.seats[seat]) || null;
  const w = z ? z.w : newSeat().w;
  const foldX = w.fX / (w.fN + K_FOLD);
  const aggrX = w.aX / (w.aN + K_AGGR);
  const bluffX = w.sX / (w.sN + K_SHOW);
  const riverX = w.rX / (w.rN + K_RIVER);
  const conf = { fold: w.fN / (w.fN + K_FOLD), aggr: w.aN / (w.aN + K_AGGR), bluff: w.sN / (w.sN + K_SHOW), river: w.rN / (w.rN + K_RIVER) };
  const fBase = w.fN > 0 ? w.fE / w.fN : 0.35, aBase = w.aN > 0 ? w.aE / w.aN : 0.4;
  const sBase = w.sN > 0 ? w.sE / w.sN : SHOW_BASE.multi, rBase = w.rN > 0 ? w.rE / w.rN : RIVER_BASE.multi;
  const sx = (v, base) => (v >= 0 ? v / SHOW_SCALE : v / base);
  const ax = W_AGGR * aggrX / AGGR_SCALE, axUp = Math.max(0, ax);
  const hands = z ? z.hands : 0, sh = z ? z.shown : { value: 0, semi: 0, bluff: 0 };
  const trust = Math.min(1, hands / HANDS_FULL);
  // 리버: 리버 공개 표본을 먼저 믿고, 모자란 만큼 전체 공개 표본으로 채운다
  const showIdx = W_SHOW * sx(bluffX, sBase), riverIdx = W_SHOW * sx(riverX + (1 - conf.river) * bluffX, rBase);
  const idx = (a, b) => trust * clamp(a + b, -1, 1);
  const bluffy = idx(axUp, showIdx), bluffyRiver = idx(axUp, riverIdx);
  const bluffyFirst = idx(ax, showIdx), bluffyRiverFirst = idx(ax, riverIdx);
  const bluffyShown = idx(0, showIdx), bluffyRiverShown = idx(0, riverIdx);
  return {
    seat, hands,
    vpip: hands ? z.vpip / hands : null, pfr: hands ? z.pfr / hands : null,
    // 플롭 이후 베팅을 맞았을 때 폴드: 횟수 · 원래 비율 · 수축 추정 · GTO라면 · 초과분
    faced: z ? z.faced : 0, foldRaw: z && z.faced ? z.foldFaced / z.faced : null,
    foldToBet: clamp(fBase + foldX, 0, 1), foldBase: fBase, foldX, foldAdj: trust * foldX,
    // 플롭 이후 먼저 벳할 수 있을 때 벳
    betOpp: z ? z.betOpp : 0, betRaw: z && z.betOpp ? z.bets / z.betOpp : null,
    aggr: clamp(aBase + aggrX, 0, 1), aggrBase: aBase, aggrX,
    // 공개된 벳·레이즈: 판정 수 · 뻥카 점수(수축) · GTO 기준 · 초과분, 리버만 따로
    shownN: sh.value + sh.semi + sh.bluff, shown: { value: sh.value, semi: sh.semi, bluff: sh.bluff },
    bluff: clamp(sBase + bluffX, 0, 1), bluffBase: sBase, bluffX,
    riverN: z ? z.river.value + z.river.bluff : 0, riverBluff: clamp(rBase + riverX, 0, 1), riverBase: rBase, riverX,
    bluffy, bluffyRiver, bluffyFirst, bluffyRiverFirst, bluffyShown, bluffyRiverShown, trust,
    takedowns: z ? z.takedowns : 0, showdowns: z ? z.showdowns : 0,
    conf,
  };
}

// ===== 요약 =====
const pctTxt = (x) => `${Math.round(x * 100)}%`;
// 뚜렷한 성향만 (수축된 추정치 기준이라 표본이 적으면 나오지 않고, GTO처럼 두는 상대의 잡음 폭 안쪽도 나오지 않는다)
function traits(p) {
  const t = [];
  if (p.bluffy >= TRAIT_BLUFFY) t.push(["bluffs often", "뻥카 잦음"]);
  else if (p.bluffy <= -TRAIT_BLUFFY) t.push(["rarely bluffs", "뻥카 거의 없음"]);
  if (p.foldAdj >= TRAIT_FOLD) t.push(["over-folds to bets", "베팅에 잘 접음"]);
  else if (p.foldAdj <= -TRAIT_FOLD) t.push(["rarely folds to bets", "잘 안 접음"]);
  return t;
}

// 화면용: "뻥카 잦음 · 베팅에 잘 접음 (24판 · 공개된 벳 5번 중 뻥카 2)". 세는 단위는 벳 · 레이즈 하나하나 (한 핸드에 여러 번일 수 있다). 이번 게임에 이 자리 핸드가 아직 없으면 ""
function summaryKo(reads, seat) {
  const p = profile(reads, seat);
  if (!p.hands) return "";
  const t = traits(p).map((x) => x[1]);
  const shown = p.shownN ? ` · 공개된 벳 ${p.shownN}번 중 뻥카 ${p.shown.bluff}` : "";
  return `${t.length ? t.join(" · ") : "아직 뚜렷한 성향 없음"} (${p.hands}판${shown})`;
}

// Claude 프롬프트용 한 줄 (표본 수 포함). 이번 게임에 이 자리 핸드가 아직 없으면 ""
function summaryEn(reads, seat, name) {
  const p = profile(reads, seat);
  if (!p.hands) return "";
  const bits = [];
  if (p.faced) bits.push(`folded to ${pctTxt(p.foldRaw)} of ${p.faced} postflop bets faced (GTO-like ~${pctTxt(p.foldBase)})`);
  if (p.betOpp) bits.push(`bet first in ${pctTxt(p.betRaw)} of ${p.betOpp} chances (GTO-like ~${pctTxt(p.aggrBase)})`);
  if (p.shownN) bits.push(`bets/raises revealed at showdown: ${p.shown.bluff} bluff, ${p.shown.semi} semi-bluff, ${p.shown.value} value`);
  const t = traits(p).map((x) => x[0]);
  return `${name || `Seat ${seat}`} (this game only, ${p.hands} hand${p.hands === 1 ? "" : "s"}): ${bits.join("; ") || "no postflop data yet"}. ` +
    `Read: ${t.length ? t.join(", ") : "no clear tendency yet"}.`;
}

const api = {
  create, valid, record, revealed, profile, summaryKo, summaryEn,
  // 테스트·조정용
  _internal: {
    walk, handStrength, drawOf, classify, expectFold, expectBet, traits,
    VALUE_HS, BET_BASE, FOLD_OFFSET, SHOW_BASE, RIVER_BASE, K_FOLD, K_AGGR, K_SHOW, K_RIVER, HANDS_FULL, DECAY, W_AGGR, W_SHOW, AGGR_SCALE, SHOW_SCALE, TRAIT_BLUFFY, TRAIT_FOLD,
  },
};
if (typeof module !== "undefined") module.exports = api;
else root.PokerReads = api;
})(globalThis);
