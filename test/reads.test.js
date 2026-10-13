// 상대 읽기 테스트: node test/reads.test.js  (실패하면 종료 코드 1)
// a) 판정: 만든 핸드로 리버 에어 = 뻥카 · 넛 = 밸류 · 턴 플러시 드로우 = 세미 · 쇼다운 없는 승리 = 판정 없음
// b) 공개 정보만: 폴드한 자리 카드를 바꿔도 record · revealed가 같고, 공개되지 않은 카드 · 덱은 읽지도 않는다. 손님 화면에서도 같은 판정
// c) 같은 핸드 두 번 · JSON 저장/복원 · 새 게임 · 몇 핸드로는 거의 움직이지 않음 · 요약 글
// d) 읽기가 없거나 관련 상대 표본이 없으면 결정이 완전히 같다 (무작위 스팟 수백 개)
// e) 안전: 합법 · NaN 없음 · 넛 폴드 없음 · 공개되지 않은 카드를 바꿔도 같은 결정 · 속도 (읽기가 있어도 1.3배 이내)
// f) 착취: 헤즈업 100bb, 게임(150핸드)마다 읽기를 새로 쌓는다. 같은 덱 · 같은 시드로 읽기 엔진과 그냥 GTO 엔진을 둔다
//    매니악 · 콜링 스테이션 · 오버폴더 상대로는 읽기 엔진이 더 벌고(차이 > 표준오차),
//    GTO 엔진 상대로는 손해가 없고(시드 세 개를 합쳐 차이 > −2bb/100 · > −2 표준오차),
//    체크 레이즈로 뻥카를 치는 상대를 '뻥카 거의 없음'으로 읽지 않고 손해도 없다 (차이 > −2bb/100 · > −2 표준오차)
//    READS_FULL=1이면 GTO · 체크 레이저 줄을 더 길게 (시드 다섯 개 · 판 수 두 배)
const T = require("../table.js");
const E = require("../engine.js");
const AI = require("../gto.js");
const RD = require("../reads.js");
const N = require("../net.js");
const I = AI._internal, RI = RD._internal;

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL:", msg); } };
const t0 = Date.now();

// ===== 공통 도구 =====
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = mulberry32(20261012);
function deck(rng = R) {
  const d = [...Array(52).keys()];
  for (let i = 51; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
const C = (str) => str.split(" ").filter(Boolean).map((t) => E.RANKS.indexOf(t[0]) * 4 + E.SUITS.indexOf(t[1]));
function newMatch(n, { stack = 2000, button = 0 } = {}) {
  const m = T.createMatch({ players: Array.from({ length: n }, (_, i) => ({ name: "P" + i, kind: i ? "bot" : "human" })), startStack: stack, levels: [[10, 20]], handsPerLevel: 1e9 });
  const live = T.liveSeats(m);
  m.button = live[(live.indexOf(button) - 1 + live.length) % live.length]; // 다음 핸드에서 button이 버튼
  return m;
}
// 딜 순서대로 pop 되는 덱. holes[seat] = "As Kd" (빈 자리는 무작위), board = 5장
function deckFor(m, holes, board, rng = R) {
  const live = T.liveSeats(m), button = T.nextIn(live, m.button);
  const order = [];
  for (let s = T.nextIn(live, button), k = 0; k < live.length; k++, s = T.nextIn(live, s)) order.push(s);
  const fixed = {}, used = new Set();
  for (const s of live) if (holes[s]) { fixed[s] = C(holes[s]); fixed[s].forEach((c) => used.add(c)); }
  const b = board ? C(board) : [];
  b.forEach((c) => used.add(c));
  const spare = deck(rng).filter((c) => !used.has(c));
  for (const s of live) if (!fixed[s]) fixed[s] = [spare.pop(), spare.pop()];
  while (b.length < 5) b.push(spare.pop());
  const seq = [];
  for (let r = 0; r < 2; r++) for (const s of order) seq.push(fixed[s][r]);
  seq.push(spare.pop(), b[0], b[1], b[2], spare.pop(), b[3], spare.pop(), b[4]);
  return [...spare, ...seq.reverse()];
}
// 정해진 수순으로 한 핸드: script = [[seat, "raise", to] | [seat, "call" | "check" | "fold"]]
function scripted(n, holes, board, script) {
  const m = newMatch(n);
  T.startHand(m, deckFor(m, holes, board));
  const h = m.hand;
  for (const [s, type, to] of script) {
    if (h.toAct !== s) throw new Error(`script: seat ${h.toAct} to act, not ${s} (${type})`);
    T.act(m, s, type, to);
  }
  while (h.phase === "runout") T.runoutStep(m);
  return m;
}
function checkDecision(m, s, d, where) {
  const L = T.legal(m, s);
  const legalOne = (x) => {
    if (x.action === "fold") return L.toCall > 0;
    if (x.action === "check") return L.toCall === 0;
    if (x.action === "call") return L.toCall > 0;
    if (x.action === "raise") return L.canRaise && Number.isFinite(x.to) && x.to >= L.minTo && x.to <= L.maxTo;
    return false;
  };
  const sum = d.mix.reduce((t, x) => t + x.freq, 0);
  const good = legalOne(d) && d.mix.length > 0 && Math.abs(sum - 1) < 1e-6 && d.mix.every((x) => legalOne(x) && Number.isFinite(x.freq) && x.freq > 0) &&
    d.mix.some((x) => x.action === d.action && x.to === d.to) && !d.info.error && Number.isFinite(d.info.equity);
  if (!good) ok(false, `${where}: 잘못된 결정 ${JSON.stringify({ action: d.action, to: d.to, mix: d.mix, info: d.info })}`);
  return good;
}
// 표본을 꾸며 넣은 읽기 (테스트용): kind = maniac(뻥카 많음 · 안 접음) | nit(뻥카 없음 · 잘 접음)
function fakeReads(n, seats, kind) {
  const r = RD.create(n);
  for (const s of seats) {
    const z = r.seats[s];
    z.hands = 80;
    z.faced = 40; z.foldFaced = kind === "nit" ? 32 : 4;
    z.betOpp = 60; z.bets = kind === "nit" ? 10 : 50;
    z.shown = kind === "nit" ? { value: 20, semi: 0, bluff: 0 } : { value: 6, semi: 2, bluff: 12 };
    z.river = kind === "nit" ? { value: 8, bluff: 0 } : { value: 2, bluff: 6 };
    Object.assign(z.w, kind === "nit"
      ? { fN: 40, fX: 16, fE: 14, aN: 60, aX: -12, aE: 22, sN: 20, sX: -5.9, sE: 5.9, rN: 8, rX: -2.1, rE: 2.1 }
      : { fN: 40, fX: -10, fE: 14, aN: 60, aX: 25, aE: 22, sN: 20, sX: 7, sE: 5.9, rN: 8, rX: 4.5, rE: 2.1 });
  }
  return r;
}
const sameDecision = (a, b) => JSON.stringify([a.action, a.to, a.mix, a.info]) === JSON.stringify([b.action, b.to, b.mix, b.info]);

// 리버 에어 벳이 콜당해 공개되는 헤즈업 핸드 (0번 7♣2♦ vs 1번 K♥Q♦)
const m1Bluff = () => scripted(2, { 0: "7c 2d", 1: "Kh Qd" }, "As Jd 9c 4s 3h", [
  [0, "raise", 50], [1, "call"], [1, "check"], [0, "check"], [1, "check"], [0, "check"], [1, "check"], [0, "raise", 100], [1, "call"]]);

// ===== a) 판정 =====
{
  // 1) 리버 에어 벳이 콜당해 공개 = 뻥카
  const m1 = scripted(2, { 0: "7c 2d", 1: "Kh Qd" }, "As Jd 9c 4s 3h", [
    [0, "raise", 50], [1, "call"], [1, "check"], [0, "check"], [1, "check"], [0, "check"], [1, "check"], [0, "raise", 100], [1, "call"]]);
  const r1 = RD.revealed(m1.hand);
  ok(r1.length === 1 && r1[0].seat === 0 && r1[0].street === 3 && r1[0].label === "bluff" && r1[0].labelKo === "뻥카" && r1[0].hs < 0.5,
    "리버 에어 = 뻥카 " + JSON.stringify(r1));
  ok(r1[0] && r1[0].weakEnd === true, "리버 에어는 끝까지 약함(들킨 뻥카) " + JSON.stringify(r1[0]));
  // 1-2) 플롭 에어 벳(뻥카)이었지만 리버에 스트레이트가 맞았다: 판정은 뻥카, 끝에는 강함(weakEnd false → 화면 도장 없음)
  const m1b = scripted(2, { 0: "6h 5h", 1: "Ac 9d" }, "Ks Qd 2c 4d 3s", [
    [0, "raise", 50], [1, "call"], [1, "check"], [0, "raise", 40], [1, "call"], [1, "check"], [0, "check"], [1, "check"], [0, "check"]]);
  const r1b = RD.revealed(m1b.hand);
  ok(r1b.length === 1 && r1b[0].street === 1 && r1b[0].label === "bluff" && r1b[0].weakEnd === false, "플롭 뻥카 뒤 맞음 " + JSON.stringify(r1b));
  // 2) 리버 넛급(셋) 벳 = 밸류
  const m2 = scripted(2, { 0: "As Ad", 1: "Kh Kd" }, "Ah 7c 2d 9s 4h", [
    [0, "raise", 50], [1, "call"], [1, "check"], [0, "check"], [1, "check"], [0, "check"], [1, "check"], [0, "raise", 100], [1, "call"]]);
  const r2 = RD.revealed(m2.hand);
  ok(r2.length === 1 && r2[0].label === "value" && r2[0].hs > 0.9, "셋 리버 벳 = 밸류 " + JSON.stringify(r2));
  // 3) 턴에서 K 하이 + 플러시 드로우로 벳 = 세미, 리버는 체크
  const m3 = scripted(2, { 0: "Kh Qh", 1: "Ac 9d" }, "9h 4h 2c 7s 3d", [
    [0, "raise", 50], [1, "call"], [1, "check"], [0, "check"], [1, "check"], [0, "raise", 60], [1, "call"], [1, "check"], [0, "check"]]);
  const r3 = RD.revealed(m3.hand);
  ok(r3.length === 1 && r3[0].street === 2 && r3[0].label === "semi" && r3[0].draw === "flush", "턴 플러시 드로우 = 세미 " + JSON.stringify(r3));
  // 같은 패라도 리버에서 벳했다면 뻥카 (리버에는 세미가 없다)
  ok(RI.classify(C("Kh Qh"), C("9h 4h 2c 7s 3d"), 1).label === "bluff", "리버 약한 벳 = 뻥카");
  ok(RI.classify(C("8c 7c"), C("9h 6d 2s"), 1).draw === "straight" && RI.classify(C("8c 7c"), C("9h 6d 2s"), 1).label === "semi", "양방 = 세미");
  ok(RI.classify(C("Ac 5d"), C("9h 8d 2s"), 1).label === "bluff", "거트샷도 없는 에이스 하이 = 뻥카");
  // 지는 조합이 하나도 없는 패(보드가 넛이라 나눠 갖는 패 포함)는 상대가 여럿이어도 밸류
  ok(RI.classify(C("2c 3d"), C("Ah Kh Qh Jh Th"), 2).label === "value", "보드 로열 플러시 3인 = 밸류");
  ok(RI.classify(C("2c 3d"), C("As Ks Qd Jh Th"), 3).label === "value", "보드 브로드웨이 4인 = 밸류");
  ok(RI.classify(C("7h 7c"), C("Kd Js 8c 3h 2d"), 2).label === "bluff", "멀티웨이 약한 페어 리버 = 뻥카 (그대로)");
  // 4) 쇼다운 없이 이긴 리버 벳: 판정 없음, 마지막 공격자의 무쇼다운 승리로만 센다
  const m4 = scripted(2, { 0: "7c 2d", 1: "Kh Qd" }, "As Jd 9c 4s 3h", [
    [0, "raise", 50], [1, "call"], [1, "check"], [0, "check"], [1, "check"], [0, "check"], [1, "check"], [0, "raise", 100], [1, "fold"]]);
  const reads4 = RD.create(2);
  ok(RD.revealed(m4.hand).length === 0, "쇼다운 없는 승리는 판정하지 않는다");
  ok(RD.record(reads4, m4, m4.hand) && reads4.seats[0].takedowns === 1 && RD.profile(reads4, 0).shownN === 0 && reads4.seats[0].w.sN === 0, "무쇼다운 승리 기록");
  // 기록: 공개된 뻥카 · 베팅 맞음 · 먼저 벳
  const reads1 = RD.create(2);
  RD.record(reads1, m1, m1.hand);
  const z0 = reads1.seats[0], z1 = reads1.seats[1];
  ok(z0.shown.bluff === 1 && z0.river.bluff === 1 && z0.bets === 1 && z0.betOpp === 3 && z0.vpip === 1 && z0.pfr === 1 && z0.showdowns === 1, "기록 0 " + JSON.stringify(z0));
  ok(z1.faced === 1 && z1.foldFaced === 0 && z1.calls === 1 && z1.betOpp === 3 && z1.vpip === 1 && z1.pfr === 0, "기록 1 " + JSON.stringify(z1));
  console.log(`a) classification: river air ${r1[0] && r1[0].label} (hs ${r1[0] && r1[0].hs}), set ${r2[0] && r2[0].label}, turn flush draw ${r3[0] && r3[0].label}, uncontested → none`);
}

// ===== b) 공개 정보만 =====
{
  // 3인: 2번이 플롭에 벳하고 턴에 폴드, 0 · 1번이 쇼다운
  const holes = { 0: "Ah Kh", 1: "Qd Qs", 2: "7c 6c" };
  const script = [[0, "raise", 60], [1, "call"], [2, "call"],
    [1, "check"], [2, "raise", 100], [0, "call"], [1, "call"],
    [1, "check"], [2, "check"], [0, "raise", 300], [1, "call"], [2, "fold"],
    [1, "check"], [0, "check"]];
  const m = scripted(3, holes, "Kd 8c 5c 2h 9s", script);
  const h = m.hand;
  ok(h.result.showdown && h.shown[0] && h.shown[1] && !h.shown[2], "3인 시나리오 구성");
  const base = RD.revealed(h);
  ok(base.length === 1 && base[0].seat === 0 && base[0].street === 2 && base[0].label === "value", "공개된 자리만 판정 " + JSON.stringify(base));
  // 폴드한 2번 카드를 바꿔도 같다 (다른 객체로 복사해 캐시를 피한다)
  const recOf = (mm) => { const r = RD.create(3); RD.record(r, mm, mm.hand); return JSON.stringify(r); };
  const baseRec = recOf(m);
  let same = 0;
  for (const alt of ["As Ad", "2d 3d", "9c 9d"]) {
    const m2 = JSON.parse(JSON.stringify(m));
    m2.hand.hole[2] = C(alt);
    m2.hand.deck = deck();
    if (JSON.stringify(RD.revealed(m2.hand)) === JSON.stringify(base) && recOf(m2) === baseRec) same++;
  }
  ok(same === 3, "폴드한 자리 카드 · 덱을 바꿔도 같은 결과 " + same);
  // 공개되지 않은 자리의 hole · 덱 · 족보 결과를 읽지 않는다
  let touched = 0;
  const m3 = JSON.parse(JSON.stringify(m)), h3 = m3.hand, realHole = h3.hole, realDeck = h3.deck;
  h3.hole = new Proxy(realHole, { get(t, k) { if (/^\d+$/.test(String(k)) && !h3.shown[+k]) touched++; return t[k]; } });
  Object.defineProperty(h3, "deck", { get() { touched++; return realDeck; }, enumerable: true });
  const res = h3.result;
  h3.result = Object.assign({}, res);
  Object.defineProperty(h3.result, "hands", { get() { touched++; return res.hands; }, enumerable: true });
  RD.revealed(h3);
  RD.record(RD.create(3), m3, h3);
  ok(touched === 0, "공개되지 않은 카드 · 덱을 읽음: " + touched);
  // 손님이 받은 화면(net.js viewFor → viewToMatch)에서도 같은 판정 · 같은 기록
  let views = 0;
  for (const seat of [0, 1, 2]) {
    const vm = N.viewToMatch(N.viewFor(m, seat));
    if (JSON.stringify(RD.revealed(vm.hand)) === JSON.stringify(base) && recOf(vm) === baseRec) views++;
  }
  ok(views === 3, "손님 화면에서 같은 판정 " + views);
  // 올인 공개(런아웃)도 공개로 친다
  const m5 = scripted(2, { 0: "9h 8h", 1: "Ac Ad" }, "Th 7d 2h Kc 3s", [[0, "raise", 50], [1, "call"], [1, "check"], [0, "raise", 2000 - 50], [1, "call"]]);
  const r5 = RD.revealed(m5.hand);
  ok(r5.length === 1 && r5[0].label === "semi" && r5[0].draw === "combo", "올인 공개된 콤보 드로우 = 세미 " + JSON.stringify(r5));
  console.log(`b) public info only: folded seat's cards/deck scrambled 3x → same record/revealed; forbidden reads ${touched}; guest views identical ${views}/3`);
  // 시간 초과로 자동 폴드 · 체크된 수와 AI가 대신 둔 수는 그 사람의 성향으로 세지 않는다
  const mt = scripted(2, { 0: "Kd Jc", 1: "8s 3h" }, "Qs 9d 4c 2h 7s", [[0, "raise", 50], [1, "call"], [1, "check"], [0, "raise", 40], [1, "fold"]]);
  const rPlain = RD.create(2);
  RD.record(rPlain, mt, mt.hand);
  const mt2 = JSON.parse(JSON.stringify(mt));
  mt2.hand.actions.find((a) => a.street === 1 && a.type === "fold").timeout = true;
  mt2.hand.actions.find((a) => a.street === 1 && a.type === "check").timeout = true;
  const rTime = RD.create(2);
  RD.record(rTime, mt2, mt2.hand);
  const zp = rPlain.seats[1], zt = rTime.seats[1];
  ok(zp.faced === 1 && zp.foldFaced === 1 && zp.w.fN > 0 && zt.faced === 0 && zt.foldFaced === 0 && zt.folds === 0 && zt.w.fN === 0 && zt.w.fX === 0 && zt.betOpp === 0 && zt.w.aN === 0,
    "시간 초과 폴드 · 체크는 세지 않는다 " + JSON.stringify([zp, zt]));
  ok(rTime.seats[0].bets === 1 && rTime.seats[0].takedowns === 1, "시간 초과여도 상대의 벳 · 무쇼다운 승리는 센다");
  // AI가 대신 친 리버 벳(쇼다운에서 공개)은 판정하지도 · 세지도 않는다
  const plainRev = RD.revealed(m1Bluff().hand).length;
  const ma = JSON.parse(JSON.stringify(m1Bluff()));
  ma.hand.actions.find((a) => a.street === 3 && (a.type === "bet" || a.type === "raise")).auto = true;
  const ra = RD.create(2);
  RD.record(ra, ma, ma.hand);
  ok(plainRev === 1 && RD.revealed(ma.hand).length === 0 && ra.seats[0].shown.bluff === 0 && ra.seats[0].bets === 0 && ra.seats[0].w.sN === 0, "AI가 대신 친 벳은 뻥카로 판정하지 않는다");
}

// ===== 아키타입 봇 (PokerTable 합법 수만) =====
const top = (w) => I.rankTop(w);
const inTop = (h, s, w) => top(w)[I.CLS[I.comboOf(h.hole[s][0], h.hole[s][1])]] > 0.5;
const hsOf = (h, s) => RI.handStrength(h.hole[s], h.board).hs;
const potBet = (m, s, f) => { const h = m.hand, L = T.legal(m, s); return Math.max(L.minTo, Math.min(L.maxTo, Math.round((L.maxBet + f * (T.potTotal(h) + L.toCall)) / 10) * 10)); };
const BOTS = {
  // 매니악: 프리플롭은 70%로 3배 레이즈 · 20%로 다시 올림, 플롭 이후엔 체크를 받으면 아무 패로나 80% 벳, 베팅을 맞으면 넓게 콜 · 가끔 블러프 레이즈
  maniac(m, s, rng) {
    const h = m.hand, L = T.legal(m, s);
    if (h.street === 0) {
      if (L.canRaise && inTop(h, s, L.maxBet <= h.bb ? 0.7 : 0.2) && L.maxBet < 8 * h.bb) return { action: "raise", to: Math.max(L.minTo, L.maxBet * 3) };
      if (L.toCall === 0) return { action: "check" };
      return inTop(h, s, 0.65) ? { action: "call" } : { action: "fold" };
    }
    const hs = hsOf(h, s);
    if (L.toCall === 0) return L.canRaise && rng() < 0.8 ? { action: "raise", to: potBet(m, s, 0.75) } : { action: "check" };
    if (L.canRaise && (hs > 0.85 || rng() < 0.12)) return { action: "raise", to: potBet(m, s, 1) };
    if (hs > 0.45 || rng() < 0.3) return { action: "call" };
    return { action: "fold" };
  },
  // 콜링 스테이션: 언제나 콜 · 체크
  station: (m, s) => ({ action: T.legal(m, s).toCall > 0 ? "call" : "check" }),
  // 오버폴더: 프리플롭은 GTO 엔진 그대로, 플롭 이후엔 강한 패로만 벳하고 강한 패가 아니면 어떤 베팅에도 접는다
  folder(m, s, rng) {
    const h = m.hand, L = T.legal(m, s);
    if (h.street === 0) return AI.decide(m, s, { rng });
    const hs = hsOf(h, s);
    if (L.toCall === 0) return L.canRaise && hs > 0.75 ? { action: "raise", to: potBet(m, s, 0.66) } : { action: "check" };
    if (L.canRaise && hs > 0.92) return { action: "raise", to: potBet(m, s, 1) };
    return hs > 0.65 ? { action: "call" } : { action: "fold" };
  },
  gto: (m, s, rng) => AI.decide(m, s, { rng }),
  // 체크 레이저: 프리플롭은 GTO 엔진, 플롭 이후 먼저 벳은 하지 않고, 베팅을 맞으면 강한 패와 에어의 45%로 팟 레이즈 (먼저 벳 빈도는 낮지만 레이즈엔 뻥카가 많다)
  checkraiser(m, s, rng) {
    const h = m.hand, L = T.legal(m, s);
    if (h.street === 0) return AI.decide(m, s, { rng });
    const hs = hsOf(h, s);
    if (L.toCall === 0) return { action: "check" };
    if (L.canRaise && (hs > 0.85 || (hs < 0.35 && rng() < 0.45))) return { action: "raise", to: potBet(m, s, 1) };
    return hs > 0.5 ? { action: "call" } : { action: "fold" };
  },
};
// 결정 지점마다 고정된 난수 (두 팔이 같은 지점에서는 같은 난수를 쓴다)
const pointRng = (hseed, h, s) => mulberry32((hseed * 31 + h.actions.length * 7919 + s * 104729) >>> 0);
function headsUp() { const m = newMatch(2, { button: 0 }); return m; }
// 스택을 100bb로 되돌리고 한 핸드
function playHand(G, dk, hseed, opp, onDecide) {
  const m = G.m;
  m.players.forEach((p) => { p.stack = 2000; p.out = false; });
  m.over = false;
  T.startHand(m, dk.slice());
  const h = m.hand;
  while (h.phase !== "done") {
    if (h.phase === "runout") { T.runoutStep(m); continue; }
    const s = h.toAct, rng = pointRng(hseed, h, s);
    let d;
    if (s === G.hero) {
      d = AI.decide(m, s, { rng, reads: G.reads || undefined });
      if (onDecide) onDecide(m, s, d, G);
    } else d = BOTS[opp](m, s, rng);
    T.act(m, s, d.action, d.to);
  }
  if (G.reads) RD.record(G.reads, m, h);
  return (m.players[G.hero].stack - 2000) / 20;
}

// 한 핸드만 기록한 읽기
function ex1() {
  const r = RD.create(2), m = scripted(2, { 0: "7c 2d", 1: "Kh Qd" }, "As Jd 9c 4s 3h", [[0, "raise", 50], [1, "call"], [1, "check"], [0, "raise", 60], [1, "call"], [1, "check"], [0, "check"], [1, "check"], [0, "check"]]);
  RD.record(r, m, m.hand);
  return r;
}

// ===== c) 같은 핸드 두 번 · JSON · 새 게임 · 몇 핸드 · 요약 =====
{
  const G = { m: headsUp(), hero: 0, reads: RD.create(2) };
  for (let i = 0; i < 5; i++) playHand(G, deck(), 900 + i, "maniac");
  const snap = JSON.stringify(G.reads);
  ok(RD.record(G.reads, G.m, G.m.hand) === false && JSON.stringify(G.reads) === snap, "같은 핸드 두 번 기록 안 함");
  ok(G.reads.hands === 5 && G.reads.last === 5 && G.reads.seats[1].hands === 5, "핸드 수 " + G.reads.hands);
  // JSON 저장 → 복원 → 이어서 기록해도 원본과 같다
  const copy = JSON.parse(snap);
  ok(JSON.stringify(RD.profile(copy, 1)) === JSON.stringify(RD.profile(G.reads, 1)), "JSON 복원 후 같은 추정");
  playHand(G, deck(mulberry32(77)), 905, "maniac");
  RD.record(copy, G.m, G.m.hand);
  ok(JSON.stringify(copy) === JSON.stringify(G.reads), "JSON 복원 후 이어서 기록");
  // 새 게임: 새 상태는 GTO 기준값 그대로, 지난 게임 핸드 번호(1번부터)는 옛 상태에 다시 들어가지 않는다
  const fresh = RD.create(2), pf = RD.profile(fresh, 1);
  ok(pf.hands === 0 && pf.foldX === 0 && pf.aggrX === 0 && pf.bluffX === 0 && pf.riverX === 0 && pf.bluffy === 0 && pf.bluffyRiver === 0, "새 게임은 0 " + JSON.stringify(pf));
  const m1 = scripted(2, { 0: "7c 2d", 1: "Kh Qd" }, "As Jd 9c 4s 3h", [[0, "raise", 50], [1, "fold"]]);
  ok(RD.record(G.reads, m1, m1.hand) === false, "다른 게임의 1번 핸드는 옛 상태에 들어가지 않는다");
  ok(RD.summaryKo(fresh, 1) === "" && RD.summaryEn(fresh, 1) === "", "표본 없으면 요약 없음");
  // 저장해 둔 읽기 검사 (이어하기 · 방장 새로고침): 정상 · JSON 복원은 통과, 깨진 모양 · 다른 자리 수 · 이상한 숫자는 거른다
  ok(RD.valid(G.reads, 2) && RD.valid(copy, 2) && RD.valid(fresh, 2) && RD.valid(RD.create(6)), "읽기 모양 검사 통과");
  const broken = [null, {}, RD.create(3), Object.assign(RD.create(2), { v: 2 }), Object.assign(RD.create(2), { last: -1 }), Object.assign(RD.create(2), { last: 1.5 })];
  for (const [k, f] of [["hands", NaN], ["faced", "3"], ["shown", null], ["w", { fN: 1 }]]) { const r = JSON.parse(snap); r.seats[1][k] = f; broken.push(r); }
  { const r = JSON.parse(snap); r.seats[0].w.fX = Infinity; broken.push(r); }
  { const r = JSON.parse(snap); r.seats[0].w.fN = -2; broken.push(r); }
  { const r = JSON.parse(snap); r.seats[0].river.bluff = 0.5; broken.push(r); }
  ok(broken.every((r) => !RD.valid(r, 2)), "깨진 읽기는 거른다 " + broken.map((r) => RD.valid(r, 2)).join(","));
  ok(RD.valid(JSON.parse(snap)) && !RD.valid(JSON.parse(snap), 3), "자리 수가 다르면 거른다");
  ok(RD.summaryEn(ex1(), 1).includes("(this game only, 1 hand)"), "1핸드는 단수 " + RD.summaryEn(ex1(), 1));
  // 몇 핸드로는 크게 움직이지 않는다: 6핸드 내내 1번이 리버 에어 벳을 보여 주고(공개 뻥카 6/6) 0번 벳에는 한 번도 안 접어도 손잡이는 작다
  const ex = RD.create(2);
  for (let i = 0; i < 6; i++) {
    const m = scripted(2, { 0: "Kd Jc", 1: "8s 3h" }, "Qs 9d 4c 2h 7s", [[0, "raise", 50], [1, "call"], [1, "raise", 40], [0, "call"], [1, "check"], [0, "raise", 100], [1, "call"], [1, "raise", 300], [0, "call"]]);
    m.hand.no = i + 1;
    RD.record(ex, m, m.hand);
  }
  const p6 = RD.profile(ex, 1);
  let maxDs = 0, maxBs = 0;
  for (let i = 0; i < 20; i++) { // 리버에 1번의 벳을 맞는 스팟 · 0번이 체크를 받은 스팟
    const m = scripted(2, { 0: "Kd Jc", 1: "8s 3h" }, "Qs 9d 4c 2h 7s", [[0, "raise", 50], [1, "call"], [1, "check"], [0, "check"], [1, "check"], [0, "check"]].concat(i % 2 ? [[1, "raise", 60 + i * 20]] : [[1, "check"]]));
    const st = I.tracked(m.hand), adj = I.readAdj(ex, I.postCtx(st, m.hand.toAct), st);
    if (adj) { maxDs = Math.max(maxDs, Math.abs(adj.ds)); maxBs = Math.max(maxBs, Math.abs(adj.bs - 1)); }
  }
  console.log(`c) 6 hands of extreme evidence (river bluffs shown ${p6.shown.bluff}/${p6.shownN}, never folds): trust ${p6.trust.toFixed(2)}, river bluff index ${p6.bluffyRiver.toFixed(2)} → max |defend shift| ${maxDs.toFixed(3)} (cap 0.25), max |bluff scale − 1| ${maxBs.toFixed(3)}`);
  ok(p6.shown.bluff >= 6 && maxDs <= 0.06 && maxBs <= 0.1, `몇 핸드로 크게 움직임: ds ${maxDs} bs ${maxBs}`);
  ok(/6판 · 공개된 벳 \d+번 중 뻥카 \d+/.test(RD.summaryKo(ex, 1)), "요약에 표본 수 " + RD.summaryKo(ex, 1));
}

// ===== d) 읽기가 없거나 관련 상대 표본이 없으면 똑같다 =====
const spots = [];
{
  let k = 0;
  for (let n = 2; n <= 6; n++) {
    for (let g = 0; g < 6; g++) {
      const m = newMatch(n, { button: g % n });
      for (let hand = 0; hand < 12 && !m.over; hand++) {
        T.startHand(m, deck());
        const h = m.hand;
        while (h.phase !== "done") {
          if (h.phase === "runout") { T.runoutStep(m); continue; }
          const s = h.toAct, L = T.legal(m, s);
          let d;
          if (g % 2 && s % 2 && R() < 0.5) { // 가끔 무작위 수 (이상한 스팟도 섞는다)
            const r = R();
            d = L.toCall > 0 && r < 0.2 ? { action: "fold" } : L.canRaise && r < 0.45 ? { action: "raise", to: L.minTo + Math.floor(R() * (L.maxTo - L.minTo + 1)) } : { action: L.toCall > 0 ? "call" : "check" };
          } else d = AI.decide(m, s, { rng: R });
          if (++k % (h.street ? 3 : 9) === 0) spots.push({ json: JSON.stringify(m), s, n });
          T.act(m, s, d.action, d.to);
        }
      }
    }
  }
  let same = 0, total = 0, post = 0, changed = 0, changedPost = 0;
  for (const sp of spots) {
    const fresh = () => JSON.parse(sp.json);
    const m0 = fresh(), h0 = m0.hand, s = sp.s, seed = 1000 + total;
    // 이 결정과 관계없는 자리: 결정하는 자리 자신 · 이미 폴드한 자리 · 이번 핸드에 없는 자리
    const irrelevant = [];
    for (let o = 0; o < sp.n; o++) if (o === s || !h0.seats.includes(o) || h0.folded[o]) irrelevant.push(o);
    const base = AI.decide(m0, s, { rng: mulberry32(seed) });
    const variants = [undefined, RD.create(sp.n), fakeReads(sp.n, irrelevant, "maniac"), fakeReads(sp.n, irrelevant, "nit")];
    let allSame = true;
    for (const reads of variants) {
      const d = AI.decide(fresh(), s, { rng: mulberry32(seed), reads });
      if (!sameDecision(base, d)) { allSame = false; ok(false, "읽기 없음과 달라짐 " + JSON.stringify([base.mix, d.mix, d.info.read])); }
    }
    total++;
    if (allSame) same++;
    if (h0.street > 0) post++;
    // 대조군: 관련 상대에게 뚜렷한 표본이 있으면 플롭 이후 결정은 달라질 수 있어야 한다
    const all = Array.from({ length: sp.n }, (_, i) => i);
    const dm = AI.decide(fresh(), s, { rng: mulberry32(seed), reads: fakeReads(sp.n, all, "maniac") });
    const dn = AI.decide(fresh(), s, { rng: mulberry32(seed), reads: fakeReads(sp.n, all, "nit") });
    if (!sameDecision(base, dm) || !sameDecision(base, dn)) { changed++; if (h0.street > 0) changedPost++; }
    if (h0.street === 0 && (!sameDecision(base, dm) || !sameDecision(base, dn))) ok(false, "프리플롭은 읽기로 바뀌지 않는다");
  }
  console.log(`d) no-reads identity: ${same}/${total} spots (${post} postflop) identical with reads absent / empty / only irrelevant seats; with relevant reads ${changedPost}/${post} postflop decisions changed`);
  ok(total >= 300 && same === total, "읽기 없음 동일성 " + same + "/" + total);
  ok(changedPost >= post * 0.5, "대조군: 관련 읽기가 있으면 바뀐다 " + changedPost + "/" + post);
}

// ===== e) 안전 · 속도 =====
{
  // 극단적인 읽기로도 합법 · NaN 없음, 공개되지 않은 카드를 바꿔도 같은 결정
  let n = 0, hyg = 0, hygN = 0;
  for (const [i, sp] of spots.entries()) {
    const all = Array.from({ length: sp.n }, (_, k) => k);
    for (const kind of ["maniac", "nit"]) {
      const reads = fakeReads(sp.n, all, kind);
      const m = JSON.parse(sp.json), d = AI.decide(m, sp.s, { rng: mulberry32(i), reads });
      if (checkDecision(m, sp.s, d, `extreme ${kind}`)) n++;
      if (i % 4 === 0) { // 위생: 내 카드 · 보드는 그대로, 나머지 카드를 다시 나눠도 같은 결정
        const b = JSON.parse(sp.json), hb = b.hand, keep = new Set([...hb.hole[sp.s], ...hb.board]);
        const pool = deck().filter((c) => !keep.has(c));
        for (const o of hb.seats) if (o !== sp.s && hb.hole[o]) hb.hole[o] = [pool.pop(), pool.pop()];
        hb.deck = pool.slice(0, hb.deck.length);
        const db = AI.decide(b, sp.s, { rng: mulberry32(i), reads });
        hygN++;
        if (sameDecision(d, db)) hyg++;
      }
    }
  }
  ok(n === spots.length * 2, `극단적 읽기에서 합법 결정 ${n}/${spots.length * 2}`);
  ok(hyg === hygN, `읽기가 있어도 숨은 카드와 무관 ${hyg}/${hygN}`);
  // 넛은 절대 폴드하지 않는다: 리버에 '뻥카를 안 치는' 상대가 어떤 크기로 벳해도
  const nutSpots = [["As Ks", "Qd Qc", "Qs Js Ts 2h 3d"], ["Jc Tc", "As Ad", "9d 8s 2h Qc 3h"], ["Ah 2h", "Kd Kc", "Kh 7h 3c 9h 4s"], ["Ad Ac", "Kh Kd", "As 7c 2d Ah 9s"]];
  let nutN = 0, nutFold = 0;
  for (const [hero, villain, board] of nutSpots) for (const size of [60, 120, 300, 1950]) {
    const m = scripted(2, { 0: villain, 1: hero }, board, [[0, "raise", 50], [1, "call"], [1, "check"], [0, "check"], [1, "check"], [0, "check"], [1, "check"], [0, "raise", size]]);
    const d = AI.decide(m, 1, { rng: mulberry32(size), reads: fakeReads(2, [0], "nit") });
    nutN++;
    if (d.mix.some((x) => x.action === "fold")) { nutFold++; console.log("   nut fold:", board, size, JSON.stringify(d.mix), d.info.read && d.info.read.note); }
    ok(d.info.read && d.info.read.defendShift < 0, "넛 스팟에서 '더 접기' 읽기가 적용돼야 한다");
  }
  ok(nutFold === 0, "넛 폴드 " + nutFold);
  // 다른 사람이 이미 콜한 베팅: 베터를 '뻥카 잦음'으로 읽었어도 더 넓게 받지 않는다 (헤즈업이면 넓게 받는다)
  {
    const cont = (d) => d.mix.filter((x) => x.action !== "fold").reduce((t, x) => t + x.freq, 0);
    let wider = 0, notWider = 0, nOver = 0, nHu = 0;
    for (const hero of ["Qc 8d", "Ac 4c", "Ah Th"]) {
      const over = scripted(3, { 2: hero }, "Kh 8s 4d 2c 7h", [[0, "raise", 60], [1, "call"], [2, "call"], [1, "check"], [2, "check"], [0, "raise", 90], [1, "call"], [2, "call"],
        [1, "check"], [2, "check"], [0, "raise", 250], [1, "call"], [2, "call"], [1, "check"], [2, "check"], [0, "raise", 900], [1, "call"]]);
      const a = AI.decide(over, 2, { rng: mulberry32(5) }), b = AI.decide(over, 2, { rng: mulberry32(5), reads: fakeReads(3, [0], "maniac") });
      nOver++;
      if (cont(b) <= cont(a) + 1e-9 && !(b.info.read && b.info.read.defendShift > 0)) notWider++;
      const hu = scripted(3, { 2: hero }, "Kh 8s 4d 2c 7h", [[0, "raise", 60], [1, "fold"], [2, "call"], [2, "check"], [0, "raise", 90], [2, "call"], [2, "check"], [0, "raise", 250], [2, "call"], [2, "check"], [0, "raise", 640]]);
      const c = AI.decide(hu, 2, { rng: mulberry32(5), reads: fakeReads(3, [0], "maniac") });
      nHu++;
      if (c.info.read && c.info.read.defendShift > 0) wider++;
    }
    ok(notWider === nOver && wider === nHu, `콜한 사람이 있으면 넓게 받지 않는다 ${notWider}/${nOver} · 헤즈업은 넓게 ${wider}/${nHu}`);
    console.log(`   overcall after a caller vs 'bluffs often' bettor: not widened ${notWider}/${nOver}; heads-up widened ${wider}/${nHu}`);
  }
  // 설명: info.read와 describeMix
  {
    const m = scripted(2, { 0: "8s 3h", 1: "Kd Jc" }, "Qs 9d 4c 2h 7s", [[0, "raise", 50], [1, "call"], [1, "check"], [0, "check"], [1, "check"], [0, "check"], [1, "check"], [0, "raise", 60]]);
    const d = AI.decide(m, 1, { rng: mulberry32(1), reads: fakeReads(2, [0], "maniac") });
    const txt = AI.describeMix(d);
    ok(d.info.read && d.info.read.seat === 0 && d.info.read.defendShift > 0 && /P0 리버 뻥카 잦음/.test(d.info.read.noteKo) && /Adjusted by this game's reads: P0 bluffs more than GTO on the river/.test(txt), "읽기 설명 " + txt);
    console.log("   describeMix with read:", txt.replace(/^.*Adjusted/, "… Adjusted"));
  }
  // 속도: 같은 스팟에서 읽기 있음 / 없음 번갈아
  const post = spots.filter((sp) => JSON.parse(sp.json).hand.street > 0).slice(0, 160);
  let tPlain = 0, tReads = 0;
  for (let rep = 0; rep < 2; rep++) for (const [i, sp] of post.entries()) {
    const all = Array.from({ length: sp.n }, (_, k) => k), reads = fakeReads(sp.n, all, i % 2 ? "nit" : "maniac");
    const a = JSON.parse(sp.json), b = JSON.parse(sp.json);
    AI.decide(a, sp.s, { rng: mulberry32(i) }); AI.decide(b, sp.s, { rng: mulberry32(i) }); // 레인지 재생 · 보드 표는 미리 (결정 계산만 잰다)
    let q = performance.now();
    AI.decide(a, sp.s, { rng: mulberry32(i) });
    tPlain += performance.now() - q;
    q = performance.now();
    AI.decide(b, sp.s, { rng: mulberry32(i), reads });
    tReads += performance.now() - q;
  }
  const ratio = tReads / tPlain;
  console.log(`e) safety: ${n} extreme-read decisions legal, hidden-card scramble identical ${hyg}/${hygN}, river nuts vs 'never bluffs' read: ${nutN} spots, folds ${nutFold}; speed with reads ${ratio.toFixed(2)}x (${(tReads / post.length / 2).toFixed(2)} ms vs ${(tPlain / post.length / 2).toFixed(2)} ms)`);
  ok(ratio < 1.3, "읽기가 있을 때 느려짐 " + ratio.toFixed(2));
}

// ===== f) 착취 =====
// 게임마다(150핸드) 읽기를 새로 만든다. 한 판(deal)마다 같은 덱으로 네 게임: {그냥 GTO · 읽기 엔진} × {0번 자리 · 1번 자리}
// 결과는 hero 자리의 bb/100. 차이 = 같은 덱의 (읽기 − 그냥), 표준오차는 판별 차이로 계산
// (참고: 다른 시드 · 판 수로 돌린 차이 — 매니악 +64(시드 101), 스테이션 +64(202), 오버폴더 +10 · +17(101 · 41), GTO −1.3 · −1.4 · −0.2 · +1.9(101 · 202 · 303 · 606, 각 3000판),
//  체크 레이저 +0.2 · −1.5(101 · 303) bb/100. 데드존이 좁을 때는 GTO 상대로 시드에 따라 −3~−8bb/100을 잃었다)
function readsDuel(opp, matches, hands, seed) {
  const plain = [], withReads = [], diffs = [], lasts = [];
  let last = null;
  for (let g = 0; g < matches; g++) {
    const games = [];
    for (const arm of ["plain", "reads"]) for (const hero of [0, 1]) games.push({ arm, hero, m: headsUp(), reads: arm === "reads" ? RD.create(2) : null });
    const drng = mulberry32(seed * 1000003 + g);
    for (let i = 0; i < hands; i++) {
      const dk = deck(drng), hseed = (seed * 7919 + g * 131 + i) >>> 0, net = { plain: 0, reads: 0 };
      for (const G of games) net[G.arm] += playHand(G, dk, hseed, opp);
      plain.push(net.plain); withReads.push(net.reads); diffs.push(net.reads - net.plain);
    }
    last = games.find((G) => G.arm === "reads" && G.hero === 0).reads;
    lasts.push(...games.filter((G) => G.arm === "reads").map((G) => (G.hero === 0 ? G.reads : null)).filter(Boolean));
  }
  const stat = (a) => {
    const n = a.length, mean = a.reduce((t, x) => t + x, 0) / n, sd = Math.sqrt(a.reduce((t, x) => t + (x - mean) ** 2, 0) / n);
    return { bb100: (mean / 2) * 100, se: (sd / Math.sqrt(n) / 2) * 100 };
  };
  return { plain: stat(plain), reads: stat(withReads), diff: stat(diffs), last, lasts, deals: matches * hands };
}
// 시드 여러 개 합치기 (같은 판 수라 평균 · 표준오차를 그대로 묶는다)
const pool = (xs) => ({ bb100: xs.reduce((t, x) => t + x.bb100, 0) / xs.length, se: Math.sqrt(xs.reduce((t, x) => t + x.se * x.se, 0)) / xs.length });
{
  console.log("f) exploitation, heads-up 100bb, reads rebuilt every 150-hand game (hero bb/100 ± SE):");
  const f = (x) => `${x.bb100.toFixed(1).padStart(6)} ±${x.se.toFixed(1)}`;
  const full = process.env.READS_FULL === "1";
  // [상대, 게임 수, 시드들, 있어야 할 성향, 없어야 할 성향, 읽기 엔진 자리(GTO + 읽기)에 없어야 할 성향]
  // 스테이션: 모든 벳이 쇼다운까지 가도 GTO 엔진 자리를 '뻥카 잦음'으로 읽지 않는다
  const rows = [
    ["maniac", 8, [41], "뻥카 잦음"], ["station", 6, [41], "잘 안 접음", null, "뻥카 잦음"], ["folder", 8, [41], "베팅에 잘 접음"],
    ["gto", full ? 16 : 8, full ? [41, 101, 303, 505, 707] : [41, 101, 303]],
    ["checkraiser", full ? 16 : 8, full ? [41, 202] : [41], null, "뻥카 거의 없음"],
  ];
  for (const [opp, matches, seeds, trait, notTrait, heroNot] of rows) {
    const t1 = Date.now(), rs = seeds.map((seed) => readsDuel(opp, matches, 150, seed));
    const r = { plain: pool(rs.map((x) => x.plain)), reads: pool(rs.map((x) => x.reads)), diff: pool(rs.map((x) => x.diff)), last: rs[rs.length - 1].last, deals: rs.reduce((t, x) => t + x.deals, 0) };
    console.log(`   vs ${opp.padEnd(11)} plain GTO ${f(r.plain)} | with reads ${f(r.reads)} | difference ${f(r.diff)}  (${r.deals} deals × 2 seats, seeds ${seeds.join("/")}${seeds.length > 1 ? `: ${rs.map((x) => x.diff.bb100.toFixed(1)).join(" / ")}` : ""}, ${((Date.now() - t1) / 1000).toFixed(1)}s)`);
    console.log(`      read after a game: ${RD.summaryKo(r.last, 1)} | ${RD.summaryEn(r.last, 1, opp)}`);
    if (opp === "gto") ok(r.diff.bb100 > -2 && r.diff.bb100 > -2 * r.diff.se, `GTO 상대 손해: ${r.diff.bb100.toFixed(1)} ±${r.diff.se.toFixed(1)}`);
    else if (opp === "checkraiser") ok(r.diff.bb100 > -2 && r.diff.bb100 > -2 * r.diff.se, `체크 레이저 상대 손해: ${r.diff.bb100.toFixed(1)} ±${r.diff.se.toFixed(1)}`);
    else ok(r.diff.bb100 > r.diff.se, `vs ${opp}: 읽기 이득 ${r.diff.bb100.toFixed(1)} ±${r.diff.se.toFixed(1)}`);
    if (trait) ok(RD.summaryKo(r.last, 1).includes(trait) && /\(150판/.test(RD.summaryKo(r.last, 1)) && /this game only, 150 hands/.test(RD.summaryEn(r.last, 1)), `${opp} 요약 "${RD.summaryKo(r.last, 1)}"`);
    if (notTrait) {
      const bad = rs.reduce((t, x) => t + x.lasts.filter((g) => RD.summaryKo(g, 1).includes(notTrait)).length, 0), all = rs.reduce((t, x) => t + x.lasts.length, 0);
      console.log(`      games read as "${notTrait}": ${bad}/${all}`);
      ok(bad === 0, `${opp}를 "${notTrait}"로 읽음 ${bad}/${all}`);
    }
    if (heroNot) {
      const bad = rs.reduce((t, x) => t + x.lasts.filter((g) => RD.summaryKo(g, 0).includes(heroNot)).length, 0), all = rs.reduce((t, x) => t + x.lasts.length, 0);
      console.log(`      GTO+reads seat read as "${heroNot}": ${bad}/${all}`);
      ok(bad === 0, `vs ${opp}: GTO 엔진 자리를 "${heroNot}"로 읽음 ${bad}/${all}`);
    }
  }
}

// ===== g) 브라우저처럼 전역으로 불러도 (module · require 없이) 읽기가 연결된다 =====
{
  const vm = require("vm"), fs = require("fs"), path = require("path");
  const ctx = vm.createContext({ console, performance, Math });
  for (const f of ["engine.js", "table.js", "gto.js", "reads.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx, { filename: f });
  ctx.fake = fakeReads(2, [0], "maniac");
  ctx.dk = deckFor(newMatch(2), { 0: "8s 3h", 1: "Kd Jc" }, "Qs 9d 4c 2h 7s");
  const out = vm.runInContext(`(() => {
    const m = PokerTable.createMatch({ players: [{ name: "A" }, { name: "B" }], startStack: 2000, levels: [[10, 20]], handsPerLevel: 1e9 });
    m.button = 1;
    PokerTable.startHand(m, dk.slice());
    for (const [s, t, to] of [[0, "raise", 50], [1, "call"], [1, "check"], [0, "check"], [1, "check"], [0, "check"], [1, "check"], [0, "raise", 60]]) PokerTable.act(m, s, t, to);
    const reads = JSON.parse(JSON.stringify(fake));
    const d = PokerAI.decide(m, 1, { rng: () => 0.5, reads });
    PokerTable.act(m, 1, "call");
    const ok = PokerReads.record(reads, m, m.hand);
    return { read: d.info.read, rec: ok, rev: PokerReads.revealed(m.hand), sum: PokerReads.summaryKo(reads, 0) };
  })()`, ctx);
  ok(out.read && out.read.defendShift > 0 && out.rec && out.rev.length === 1 && out.rev[0].label === "bluff" && /뻥카 잦음/.test(out.sum), "브라우저 전역 연결 " + JSON.stringify(out));
  console.log(`g) browser globals (no require): PokerAI.decide picks up PokerReads → ${out.read && out.read.noteKo}; revealed ${out.rev.map((x) => x.labelKo).join(",")}; ${out.sum}`);
}

console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
