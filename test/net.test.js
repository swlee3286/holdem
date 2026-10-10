// 온라인 프로토콜 테스트: node test/net.test.js  (실패하면 종료 코드 1)
// a) viewFor가 덱 · 남의 카드를 절대 보내지 않는지 (2~6인 무작위 매치, 모든 단계 · 모든 자리)
// b) 공개된 카드(쇼다운 · 올인)는 보이는지  c) 메시지 검사 (깨진 · 너무 큰 · 늦은 · 차례가 아닌 수)
// d) view → 매치 모양 변환이 규칙 함수와 맞는지  e) 자리 배정 · 이름 · 코드
const T = require("../table.js");
const N = require("../net.js");
const AI = require("../gto.js");

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL:", msg); } };

function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = mulberry32(20261010);
function deck() {
  const d = [...Array(52).keys()];
  for (let i = 51; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
const LEVELS = [[10, 20], [15, 30], [20, 40], [30, 60], [50, 100], [100, 200], [200, 400], [400, 800], [800, 1600]];
function newMatch(n) {
  const kinds = ["human", "remote", "bot", "remote", "bot", "bot"];
  return T.createMatch({ players: Array.from({ length: n }, (_, i) => ({ name: "P" + i, kind: kinds[i] })), startStack: 1000, levels: LEVELS, handsPerLevel: 6 });
}
// 무작위지만 올인이 자주 나오게
function randomAct(m, s) {
  const L = T.legal(m, s), r = R();
  if (L.canRaise && r < 0.06) return ["raise", L.maxTo];
  if (L.canRaise && r < 0.35) return ["raise", L.minTo + Math.floor(R() * (L.maxTo - L.minTo + 1))];
  if (L.toCall > 0 && r > 0.85) return ["fold"];
  return [L.toCall ? "call" : "check"];
}

// ---- a) b) 정보 누출 검사 ----
const CARD_KEYS = new Set(["hole", "board", "best"]);
function cardsUnder(o, key, out) {
  if (Array.isArray(o)) { for (const x of o) cardsUnder(x, key, out); return; }
  if (o && typeof o === "object") { for (const [k, v] of Object.entries(o)) cardsUnder(v, k, out); return; }
  if (CARD_KEYS.has(key) && typeof o === "number") out.push(o);
}
function keysOf(o, out = new Set()) {
  if (Array.isArray(o)) for (const x of o) keysOf(x, out);
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { out.add(k); keysOf(v, out); }
  return out;
}
let views = 0, shownChecks = 0, runoutViews = 0, sdViews = 0;
function checkViews(m, extra) {
  const h = m.hand, n = m.players.length;
  for (let seat = -1; seat < n; seat++) {
    const v = N.viewFor(m, seat, extra);
    const json = JSON.stringify(v);
    views++;
    // 숨겨야 하는 카드: 아직 안 깐 덱(번 카드 포함) + 공개되지 않은 남의 카드
    const hidden = new Set(h.deck);
    for (const s of h.seats) if (s !== seat && !h.shown[s]) for (const c of h.hole[s]) hidden.add(c);
    const seen = [];
    cardsUnder(v, "", seen);
    const leak = seen.filter((c) => hidden.has(c));
    if (leak.length) { ok(false, `카드 누출 seat ${seat} hand ${h.no}: ${leak}`); return; }
    const keys = keysOf(v);
    if (keys.has("deck")) { ok(false, "view에 deck 키"); return; }
    for (const s of h.seats) {
      const mine = s === seat, shown = h.shown[s];
      if (!mine && !shown && v.hand.hole[s] !== null) { ok(false, `숨겨야 할 카드 seat ${s} → ${seat}`); return; }
      if ((mine || shown) && JSON.stringify(v.hand.hole[s]) !== JSON.stringify(h.hole[s])) { ok(false, `보여야 할 카드 seat ${s} → ${seat}`); return; }
      if (shown && !mine) shownChecks++;
    }
    // 남은 덱 순서가 통째로 들어 있지 않은지 (숫자 배열 문자열로)
    if (h.deck.length >= 3 && json.includes(JSON.stringify(h.deck.slice(-3)).slice(1, -1))) { ok(false, "덱 순서 누출"); return; }
    if (h.phase === "runout") runoutViews++;
    if (h.phase === "done" && h.result.showdown) {
      sdViews++;
      for (const [s, x] of v.hand.result.hands.entries()) if (x && !h.shown[s]) ok(false, "쇼다운 족보가 공개 안 된 자리");
    }
    // 손님 쪽 검사도 통과해야 한다 (JSON 왕복)
    const back = N.parseHostMsg(JSON.stringify({ t: "state", view: v }));
    if (seat >= 0 && !back) { ok(false, `parseHostMsg가 정상 view를 거부 seat ${seat} phase ${h.phase}`); return; }
    if (back && seat >= 0) {
      const vm = N.viewToMatch(back.view);
      if (T.potTotal(vm.hand) !== T.potTotal(h)) ok(false, "viewToMatch 팟");
      if (JSON.stringify(T.positionsOf(vm.hand)) !== JSON.stringify(T.positionsOf(h))) ok(false, "viewToMatch 포지션");
      if (h.phase === "bet" && h.toAct === seat) {
        const L1 = T.legal(vm, seat), L0 = T.legal(m, seat);
        if (JSON.stringify(L1) !== JSON.stringify(L0) || JSON.stringify(v.legal) !== JSON.stringify(L0)) ok(false, `viewToMatch legal ${JSON.stringify(L1)} vs ${JSON.stringify(L0)}`);
      } else if (v.legal !== null) ok(false, "차례가 아닌데 legal");
    }
  }
}

let hands = 0, matches = 0;
for (let n = 2; n <= 6; n++) {
  for (let k = 0; k < 10; k++) {
    const m = newMatch(n);
    let guard = 0;
    while (!m.over && guard++ < 400) {
      T.startHand(m, deck());
      hands++;
      const h = m.hand;
      const extra = { match: "abc", code: "ABCDE", connected: m.players.map((_, s) => s !== 1), turn: { seat: h.toAct, left: 12345, total: 30000 }, next: null };
      checkViews(m, extra);
      let steps = 0;
      while (h.phase !== "done" && steps++ < 500) {
        if (h.phase === "runout") T.runoutStep(m);
        else { const [type, to] = randomAct(m, h.toAct); T.act(m, h.toAct, type, to); }
        checkViews(m, extra);
      }
    }
    matches++;
  }
}
ok(shownChecks > 100 && runoutViews > 50 && sdViews > 50, `공개 카드 경우가 충분히 나와야 함 shown ${shownChecks} runout ${runoutViews} showdown ${sdViews}`);
console.log(`viewFor: ${matches} matches, ${hands} hands, ${views} views (runout ${runoutViews}, showdown ${sdViews}, shown-card checks ${shownChecks})`);

// GTO 엔진이 view로 만든 매치로도 둘 수 있다 (손님의 GTO 힌트)
{
  let tried = 0, legalOk = 0;
  for (let t = 0; t < 30; t++) {
    const m = newMatch(2 + (t % 5));
    T.startHand(m, deck());
    for (let st = 0; st < 6 && m.hand.phase === "bet"; st++) {
      const s = m.hand.toAct;
      const vm = N.viewToMatch(N.parseHostMsg(JSON.stringify({ t: "state", view: N.viewFor(m, s) })).view);
      const d = AI.decide(vm, s, { rng: R });
      tried++;
      const L = T.legal(m, s);
      if (d && d.mix && (d.action !== "check" || L.toCall === 0) && (d.action !== "raise" || L.canRaise)) legalOk++;
      const [type, to] = randomAct(m, s);
      T.act(m, s, type, to);
    }
  }
  ok(tried > 50 && legalOk === tried, `view로 만든 매치에서 GTO 결정 ${legalOk}/${tried}`);
}

// ---- c) 손님 → 방장 메시지 검사 ----
{
  const G = N.parseGuestMsg;
  const good = { t: "hello", v: 1, name: "  민지 ", token: "abcdEFGH1234" };
  ok(G(JSON.stringify(good))?.name === "민지", "hello 정상");
  ok(G(JSON.stringify({ ...good, name: "가나다라마바사아자차카타파하" }))?.name === "가나다라마바사아자차", "이름 10자로 자름");
  ok(G(JSON.stringify({ ...good, name: "<b>x</b>​\u0007" }))?.name === "<b>x</b>", "제어문자 제거 (꺾쇠는 화면에서 escape)");
  ok(G(JSON.stringify({ ...good, name: "x".repeat(65) })) === null, "이름 너무 김");
  ok(G(JSON.stringify({ ...good, token: "short" })) === null, "토큰 짧음");
  ok(G(JSON.stringify({ ...good, token: "bad token with spaces" })) === null, "토큰 글자");
  ok(G(JSON.stringify({ ...good, v: "1" })) === null, "버전 문자열");
  ok(G(JSON.stringify({ t: "ping" }))?.t === "ping", "ping");
  for (const junk of [null, undefined, 42, {}, [], "", "{", "null", "[]", "[1,2]", '"str"', "{\"t\":\"hack\"}", "{\"t\":\"act\"}"]) {
    ok(G(junk) === null, "쓰레기 거부 " + JSON.stringify(junk));
  }
  ok(G(JSON.stringify({ t: "ping", pad: "x".repeat(N.MAX_IN) })) === null, "너무 큰 메시지 거부");
  const act = (o) => G(JSON.stringify({ t: "act", hand: 3, n: 7, type: "call", ...o }));
  ok(act({})?.type === "call", "act 정상");
  ok(act({ type: "raise", to: 120.4 })?.to === 120, "raise 반올림");
  ok(act({ type: "raise" }) === null, "raise인데 to 없음");
  ok(act({ type: "raise", to: "100" }) === null, "to 문자열");
  ok(act({ type: "raise", to: 1e12 }) === null, "to 너무 큼");
  ok(act({ type: "raise", to: -5 }) === null, "to 음수");
  ok(G('{"t":"act","hand":3,"n":7,"type":"raise","to":1e400}') === null, "to 무한대");
  ok(act({ type: "allin" }) === null, "모르는 행동");
  ok(act({ to: 50 }) === null, "call에 to");
  ok(act({ hand: 1.5 }) === null && act({ n: -1 }) === null && act({ hand: "3" }) === null, "hand · n 정수");
}

// checkAct: 늦은 · 차례가 아닌 · 규칙에 맞지 않는 수
{
  const m = newMatch(4);
  T.startHand(m, deck());
  const h = m.hand, s = h.toAct, other = h.seats.find((x) => x !== s);
  const msg = (o) => ({ t: "act", hand: h.no, n: h.actions.length, type: "call", ...o });
  ok(N.checkAct(m, s, msg({})).ok, "정상 콜");
  ok(N.checkAct(m, other, msg({})).why === "turn", "차례가 아님");
  ok(N.checkAct(m, s, msg({ n: h.actions.length - 1 })).why === "stale", "늦은 수 (n)");
  ok(N.checkAct(m, s, msg({ hand: h.no + 1 })).why === "stale", "다른 핸드");
  ok(N.checkAct(m, s, msg({ type: "check" })).why === "illegal", "베팅 앞에서 체크");
  const L = T.legal(m, s);
  const r = N.checkAct(m, s, msg({ type: "raise", to: 5 }));
  ok(r.ok && r.to === L.minTo, "작은 레이즈는 최소 레이즈로");
  ok(N.checkAct(m, s, msg({ type: "raise", to: 1e8 })).to === L.maxTo, "큰 레이즈는 올인으로");
  // 프리플롭에서 모두 콜 → BB 체크 가능: 폴드는 거부
  while (h.phase === "bet" && !(h.toAct === h.bbSeat && T.legal(m, h.toAct).toCall === 0)) T.act(m, h.toAct, "call");
  if (h.phase === "bet") {
    const b = h.toAct;
    ok(N.checkAct(m, b, { t: "act", hand: h.no, n: h.actions.length, type: "fold" }).why === "illegal", "체크할 수 있는데 폴드");
    const c = N.checkAct(m, b, { t: "act", hand: h.no, n: h.actions.length, type: "call" });
    ok(c.ok && c.type === "check", "콜 0 → 체크");
  }
  // 끝난 핸드 · 카드 펼치는 중에는 거부
  const m2 = newMatch(2);
  T.startHand(m2, deck());
  T.act(m2, m2.hand.toAct, "raise", 1e9);
  T.act(m2, m2.hand.toAct, "call");
  ok(m2.hand.phase === "runout", "올인 → runout");
  ok(!N.checkAct(m2, 0, { t: "act", hand: m2.hand.no, n: m2.hand.actions.length, type: "check" }).ok, "runout 중 거부");
  ok(!N.checkAct({ hand: null }, 0, { t: "act", hand: 1, n: 0, type: "check" }).ok, "핸드 없음");
}

// 방장 → 손님 메시지 검사
{
  const P = N.parseHostMsg;
  const m = newMatch(3);
  T.startHand(m, deck());
  const v = N.viewFor(m, 1, { match: "x", code: "ABCDE" });
  const enc = (o) => JSON.stringify(o);
  ok(P(enc({ t: "state", view: v }))?.view.seat === 1, "state 정상");
  const bad = (f) => { const w = JSON.parse(JSON.stringify(v)); f(w); return P(enc({ t: "state", view: w })); };
  ok(bad((w) => { w.hand.hole[0] = [1, 99]; }) === null, "카드 범위");
  ok(bad((w) => { w.hand.bets = [1, 2]; }) === null, "배열 길이");
  ok(bad((w) => { w.players = "x"; }) === null, "players 모양");
  ok(bad((w) => { w.players[0].name = { x: 1 }; }) === null, "이름 타입");
  ok(bad((w) => { w.hand.actions.push({ street: 0, seat: 9, type: "call" }); }) === null, "행동 좌석 범위");
  ok(bad((w) => { w.hand.phase = "boom"; }) === null, "phase");
  ok(bad((w) => { w.v = 2; }) === null, "버전");
  ok(bad((w) => { w.players[0].name = "아주아주긴이름입니다정말로"; })?.view.players[0].name.length === 10, "이름 정리");
  ok(P(enc({ t: "state", view: v, pad: "x".repeat(N.MAX_OUT) })) === null, "너무 큼");
  ok(P(enc({ t: "welcome", seat: 7 })) === null && P(enc({ t: "welcome", seat: 2 }))?.seat === 2, "welcome");
  ok(P(enc({ t: "error", msg: "x".repeat(201) })) === null && P(enc({ t: "error", msg: "꽉 참", fatal: true }))?.fatal === true, "error");
  ok(P(enc({ t: "bye", reason: "zzz" }))?.reason === "left" && P(enc({ t: "bye", reason: "closed" }))?.reason === "closed", "bye");
  ok(P(enc({ t: "lobby", code: "ABCDE", seats: 4, started: false, players: [{ seat: 0, name: "방장", kind: "human", connected: true, isHost: true }], you: 1 }))?.players.length === 1, "lobby");
  ok(P(enc({ t: "lobby", code: "ABCDE", seats: 9, players: [] })) === null, "lobby 인원 범위");
  for (const junk of ["", "{}", "[]", "nope", enc({ t: "state" }), enc({ t: "state", view: null })]) ok(P(junk) === null, "쓰레기 거부 " + junk);
}

// ---- e) 자리 배정 · 이름 · 코드 ----
{
  const room = N.createRoom(4, "  방장이름  ");
  ok(room.hostName === "방장이름", "방장 이름 정리");
  const hello = (name, token) => ({ t: "hello", v: 1, name, token });
  const a = N.roomJoin(room, hello("민지", "tokenAAAAAA1"), "c1", ["민지", "준호"]);
  ok(a.ok && a.seat === 1 && room.guests[0].name === "민지2", "첫 손님 1번 · AI 이름과 겹치면 숫자");
  const b = N.roomJoin(room, hello("방장이름", "tokenBBBBBB2"), "c2");
  ok(b.ok && b.seat === 2 && room.guests[1].name === "방장이름2", "둘째 손님 2번 · 방장과 같은 이름");
  const c = N.roomJoin(room, hello("셋", "tokenCCCCCC3"), "c3");
  ok(c.ok && c.seat === 3, "셋째 손님");
  ok(!N.roomJoin(room, hello("넷", "tokenDDDDDD4"), "c4").ok, "4인 방이 가득 참");
  ok(N.roomLeave(room, "c1") === 1 && room.guests.map((g) => g.seat).join() === "1,2", "시작 전 나가면 자리를 당긴다");
  const back = N.roomJoin(room, hello("셋", "tokenCCCCCC3"), "c5");
  ok(back.ok && back.back && back.seat === 2 && back.replaced === "c3", "같은 토큰 → 같은 자리, 예전 연결은 교체");
  room.started = true;
  ok(N.roomLeave(room, "c5") === 2 && room.guests.find((g) => g.seat === 2).connected === false, "시작 뒤 끊기면 자리는 남는다");
  const re = N.roomJoin(room, hello("다른이름", "tokenCCCCCC3"), "c6");
  ok(re.ok && re.seat === 2 && room.guests.find((g) => g.seat === 2).name === "셋", "시작 뒤 재접속: 자리 · 이름 유지");
  ok(!N.roomJoin(room, hello("새손님", "tokenEEEEEE5"), "c7").ok, "시작 뒤 새 손님 거부");
  ok(N.roomLeave(room, "c-없음") === -1, "모르는 연결");
  ok(N.roomGuestAt(room, 2).token === "tokenCCCCCC3" && N.roomGuestAt(room, 5) === null, "roomGuestAt");

  const codes = new Set();
  for (let i = 0; i < 500; i++) {
    const code = N.makeCode();
    codes.add(code);
    if (!/^[A-Z2-9]{5}$/.test(code) || /[01OIL]/.test(code) || N.normCode(code) !== code) ok(false, "코드 모양 " + code);
  }
  ok(codes.size > 490, "코드가 고르게");
  ok(N.normCode(" ab-cde ") === "ABCDE" && N.normCode("ABCD") === null && N.normCode("ABCD0") === null && N.normCode("ABCDO") === null, "normCode");
  ok(N.cleanName("   ", "손님") === "손님" && N.cleanName("a\n\tb") === "a b", "cleanName");
  ok(N.uniqueName("가나다라마바사아자차", ["가나다라마바사아자차"]) === "가나다라마바사아자2", "긴 이름에 숫자");
  ok(/^[A-Za-z0-9]{20}$/.test(N.newToken()), "토큰 모양");
}

console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
