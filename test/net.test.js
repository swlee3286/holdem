// 온라인 프로토콜 테스트: node test/net.test.js  (실패하면 종료 코드 1)
// a) viewFor가 덱 · 남의 카드를 절대 보내지 않는지 (2~6인 무작위 매치, 모든 단계 · 모든 자리)
// b) 공개된 카드(쇼다운 · 올인)는 보이는지  c) 메시지 검사 (깨진 · 너무 큰 · 늦은 · 차례가 아닌 수)
// d) view → 매치 모양 변환이 규칙 함수와 맞는지  e) 자리 배정 · 이름 · 코드
// f) HMAC-SHA256 · 시그널링 서버 설정  g) 재접속 확인(방마다 자리 비밀값): 진짜 방장 · 가짜 방장 · 틀린 증명 · 연결 수 제한
//    (g는 BroadcastChannel 전송으로 node 안에서 방장과 손님을 직접 돌린다)
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
  const good = { t: "hello", v: 2, name: "  민지 " };
  const h0 = G(JSON.stringify(good));
  ok(h0?.name === "민지" && h0.gid === null && h0.nonce === null, "hello 정상 (처음 들어옴)");
  const h1 = G(JSON.stringify({ ...good, gid: "gidAAAA1111", nonce: "nonceBBBB2222" }));
  ok(h1?.gid === "gidAAAA1111" && h1.nonce === "nonceBBBB2222", "hello 되찾기 (gid · nonce)");
  ok(G(JSON.stringify({ ...good, token: "abcdEFGH1234" }))?.gid === null, "예전 token은 무시 (비밀값을 보내는 방식은 없다)");
  ok(G(JSON.stringify({ ...good, name: "가나다라마바사아자차카타파하" }))?.name === "가나다라마바사아자차", "이름 10자로 자름");
  ok(G(JSON.stringify({ ...good, name: "<b>x</b>​\u0007" }))?.name === "<b>x</b>", "제어문자 제거 (꺾쇠는 화면에서 escape)");
  ok(G(JSON.stringify({ ...good, name: "x".repeat(65) })) === null, "이름 너무 김");
  ok(G(JSON.stringify({ ...good, gid: "short", nonce: "nonceBBBB2222" })) === null, "gid 짧음");
  ok(G(JSON.stringify({ ...good, gid: "bad gid with spaces", nonce: "nonceBBBB2222" })) === null, "gid 글자");
  ok(G(JSON.stringify({ ...good, gid: "gidAAAA1111" })) === null, "gid만 있고 nonce 없음");
  ok(G(JSON.stringify({ ...good, v: "1" })) === null, "버전 문자열");
  ok(G(JSON.stringify({ t: "ping" }))?.t === "ping" && G(JSON.stringify({ t: "leave" }))?.t === "leave", "ping · leave");
  ok(G(JSON.stringify({ t: "auth", proof: "a".repeat(64) }))?.proof === "a".repeat(64), "auth 정상");
  ok(G(JSON.stringify({ t: "auth", proof: "A".repeat(64) })) === null && G(JSON.stringify({ t: "auth", proof: "a".repeat(63) })) === null, "auth 모양");
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
  ok(bad((w) => { w.v = 1; }) === null, "버전");
  ok(bad((w) => { w.players[0].name = "아주아주긴이름입니다정말로"; })?.view.players[0].name.length === 10, "이름 정리");
  ok(P(enc({ t: "state", view: v, pad: "x".repeat(N.MAX_OUT) })) === null, "너무 큼");
  ok(P(enc({ t: "welcome", seat: 7, gid: "gidAAAA1111" })) === null && P(enc({ t: "welcome", seat: 2, gid: "gidAAAA1111" }))?.seat === 2, "welcome");
  ok(P(enc({ t: "welcome", seat: 2 })) === null, "welcome에 gid 없음");
  ok(P(enc({ t: "welcome", seat: 2, gid: "gidAAAA1111", secret: "secretCCCC3333" }))?.secret === "secretCCCC3333" && P(enc({ t: "welcome", seat: 2, gid: "gidAAAA1111", secret: 5 })) === null, "welcome secret");
  ok(P(enc({ t: "auth", nonce: "nonceBBBB2222", proof: "0".repeat(64) }))?.t === "auth" && P(enc({ t: "auth", nonce: "x", proof: "0".repeat(64) })) === null, "auth (방장 증명)");
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
  ok(N.createRoom(3, "나").hostName === "나2", "방장 이름 '나'는 쓰지 않는다");
  const hello = (name, gid) => ({ name, gid: gid || null });
  const a = N.roomJoin(room, hello("민지"), "c1", ["민지", "준호"]);
  ok(a.ok && a.seat === 1 && room.guests[0].name === "민지2", "첫 손님 1번 · AI 이름과 겹치면 숫자");
  ok(/^[A-Za-z0-9]{12}$/.test(a.gid) && /^[A-Za-z0-9]{24}$/.test(a.secret) && room.guests[0].secret === a.secret, "새 자리: 자리 표시 · 비밀값을 방장이 만든다");
  const b = N.roomJoin(room, hello("방장이름"), "c2");
  ok(b.ok && b.seat === 2 && room.guests[1].name === "방장이름2", "둘째 손님 2번 · 방장과 같은 이름");
  ok(b.secret !== a.secret && b.gid !== a.gid, "자리마다 다른 비밀값");
  const c = N.roomJoin(room, hello("나"), "c3");
  ok(c.ok && c.seat === 3 && room.guests[2].name === "나2", "셋째 손님 · '나'는 다른 사람 화면에서 헷갈려 숫자를 붙인다");
  ok(!N.roomJoin(room, hello("넷"), "c4").ok, "4인 방이 가득 참");
  ok(N.roomLeave(room, "c1", 1234) === 1 && room.guests.length === 3 && room.guests[0].connected === false && room.guests[0].lostAt === 1234, "시작 전에 끊겨도 자리는 남는다 (폰이 잠깐 잠들어도)");
  const back0 = N.roomJoin(room, hello("민지", a.gid), "c1b");
  ok(back0.ok && back0.back && back0.seat === 1 && back0.secret === null && room.guests[0].connected, "로비에서 끊겼던 손님이 같은 자리로 (비밀값은 다시 보내지 않는다)");
  ok(N.roomRemove(room, 1) && room.guests.map((g) => `${g.seat}${g.name}`).join() === "1방장이름2,2나2", "스스로 나감 · 내보냄: 자리를 비우고 뒤를 당긴다");
  const back = N.roomJoin(room, hello("셋", c.gid), "c5");
  ok(back.ok && back.back && back.seat === 2 && back.replaced === "c3", "같은 자리 표시 → 같은 자리, 예전 연결은 교체");
  const fresh = N.roomJoin(room, hello("모름", "unknownGID99"), "c8");
  ok(fresh.ok && !fresh.back && fresh.seat === 3 && fresh.secret, "모르는 자리 표시는 새 손님으로");
  ok(N.roomRemove(room, 3), "빼기");
  room.started = true;
  ok(!N.roomRemove(room, 2), "시작 뒤에는 자리를 빼지 않는다");
  ok(N.roomLeave(room, "c5") === 2 && room.guests.find((g) => g.seat === 2).connected === false, "시작 뒤 끊기면 자리는 남는다");
  const re = N.roomJoin(room, hello("다른이름", c.gid), "c6");
  ok(re.ok && re.seat === 2 && room.guests.find((g) => g.seat === 2).name === "셋", "시작 뒤 재접속: 자리 · 이름 유지");
  ok(!N.roomJoin(room, hello("새손님"), "c7").ok, "시작 뒤 새 손님 거부");
  ok(!N.roomJoin(room, hello("새손님", "unknownGID99"), "c7").ok, "시작 뒤 모르는 자리 표시 거부");
  ok(N.roomLeave(room, "c-없음") === -1, "모르는 연결");
  ok(N.roomGuestAt(room, 2).gid === c.gid && N.roomGuestAt(room, 5) === null, "roomGuestAt");

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

// ---- f) HMAC-SHA256 · 시그널링 서버 설정 ----
{
  const crypto = require("crypto");
  let bad = 0;
  for (let len = 0; len < 260; len++) {
    const b = crypto.randomBytes(len);
    if (Buffer.from(N.sha256(new Uint8Array(b))).toString("hex") !== crypto.createHash("sha256").update(b).digest("hex")) bad++;
  }
  for (let i = 0; i < 100; i++) {
    const k = crypto.randomBytes(1 + i).toString("base64"), m = `holdem|${i}|한글|` + crypto.randomBytes(i * 3).toString("hex");
    if (N.hmacHex(k, m) !== crypto.createHmac("sha256", k).update(m).digest("hex")) bad++;
  }
  ok(bad === 0, `SHA-256 · HMAC이 node crypto와 같음 (다름 ${bad})`);
  const p1 = N.proofFor("secretAAAA1111", "host", "gidAAAA1111", "nonceG111111", "nonceH222222");
  ok(/^[0-9a-f]{64}$/.test(p1) && p1 !== N.proofFor("secretAAAA1111", "guest", "gidAAAA1111", "nonceG111111", "nonceH222222")
    && p1 !== N.proofFor("secretAAAA1112", "host", "gidAAAA1111", "nonceG111111", "nonceH222222"), "증명: 방향 · 비밀값마다 다르다");
  const q = new URLSearchParams("peerHost=evil.example&peerPort=9000&peerPath=/x&peerSecure=0");
  ok(N.peerOptions(q, "swlee3286.github.io").host === undefined, "진짜 사이트에서는 ?peerHost 무시");
  ok(N.peerOptions(q, "192.168.0.5").host === undefined, "같은 와이파이 주소에서도 무시");
  const lo = N.peerOptions(q, "127.0.0.1");
  ok(lo.host === "evil.example" && lo.port === 9000 && lo.path === "/x" && lo.secure === false && N.peerOptions(q, "localhost").host === "evil.example", "localhost에서는 시험용 서버");
}

// ---- g) 재접속 확인: BroadcastChannel로 방장 · 손님을 직접 돌린다 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(10); } return true; };
// 같은 채널의 모든 메시지를 엿듣는다 (가운데에서 보는 것: 여기에 비밀값이 나오면 안 된다)
function tap(code) {
  const ch = new BroadcastChannel("holdem-net-" + code), all = [];
  ch.onmessage = (e) => all.push(e.data);
  return { all, text: () => JSON.stringify(all), close: () => ch.close() };
}
function hostFor(code, room, extra = {}) {
  const ev = { hellos: [], acts: [], leaves: [] };
  const host = N.createHost({ kind: "local", code, resume: true, ...extra }, {
    lookup: (gid) => room.guests.find((g) => g.gid === gid)?.secret || null,
    onReady() { ev.ready = true; },
    onHello(id, msg) {
      ev.hellos.push(msg);
      const r = N.roomJoin(room, msg, id);
      if (!r.ok) { host.drop(id, { t: "error", msg: r.msg, fatal: true }); return; }
      host.send(id, r.secret ? { t: "welcome", seat: r.seat, gid: r.gid, secret: r.secret } : { t: "welcome", seat: r.seat, gid: r.gid });
    },
    onAct(id, msg) { ev.acts.push(msg); },
    onLeave(id, left) { ev.leaves.push(left); const s = N.roomLeave(room, id); if (left && s > 0) N.roomRemove(room, s); },
    onError(c) { ev.error = c; },
    onStatus() {},
  });
  return { host, ev };
}
function clientFor(code, cred, name = "손님") {
  const ev = { welcome: [], creds: [], status: [], states: 0, errors: [] };
  const c = N.createClient({ kind: "local", code, name, cred, persistent: true, giveUpMs: 60000 }, {
    onWelcome(seat) { ev.welcome.push(seat); },
    onCred(x) { ev.creds.push(x); },
    onLobby() {}, onState() { ev.states++; },
    onError(msg, fatal) { ev.errors.push([msg, fatal]); },
    onBye() {}, onStatus(st, why) { ev.status.push([st, why]); }, onFatal(x) { ev.fatal = x; },
  });
  return { c, ev };
}

(async () => {
  // 1) 처음 들어옴 → 비밀값을 받는다 · 2) 다시 붙음 → 증명만 오가고 같은 자리
  {
    const code = "TESTA", room = N.createRoom(4, "방장");
    const H = hostFor(code, room);
    await until(() => H.ev.ready, 2000);
    const A = clientFor(code, null, "민지");
    ok(await until(() => A.ev.welcome.length === 1), "처음 들어온 손님 welcome");
    const cred = A.ev.creds[0];
    ok(A.ev.welcome[0] === 1 && cred && cred.secret === room.guests[0].secret, "새 자리 비밀값을 받음");
    ok(A.c.open, "확인을 마치면 open");
    A.c.close();
    await sleep(50);
    const wire = tap(code);
    const B = clientFor(code, cred, "민지");
    ok(await until(() => B.ev.welcome.length === 1), "같은 자리로 다시 들어옴");
    ok(B.ev.welcome[0] === 1 && B.ev.creds.length === 0 && room.guests.length === 1 && room.guests[0].connected, "되찾기: 같은 자리 · 새 비밀값 없음");
    ok(!wire.text().includes(cred.secret), "다시 붙을 때 비밀값이 오가지 않는다");
    ok(wire.all.some((m) => typeof m.d === "string" && m.d.includes('"t":"auth"')), "증명을 주고받았다");
    // 떠나기(leave): 시작 전이면 자리가 빈다
    B.c.close(true);
    ok(await until(() => room.guests.length === 0), "스스로 나가면 로비 자리를 비운다");
    wire.close(); H.host.close(); B.c.close();
  }
  // 3) 가짜 방장(코드를 가로챔): 증명을 못 하므로 손님은 자기 증명을 보내지 않고 끊는다. 비밀값은 어디에도 없다
  {
    const code = "TESTB", cred = { gid: "gidVictim001", secret: "secretVictim0000001234" };
    const ch = new BroadcastChannel("holdem-net-" + code), got = [];
    ch.onmessage = (e) => {
      const m = e.data;
      if (m.k === "open") ch.postMessage({ k: "accept", to: m.from });
      else if (m.k === "data" && m.to === "host") {
        got.push(m.d);
        const o = JSON.parse(m.d);
        if (o.t === "hello") {
          ch.postMessage({ k: "data", from: "host", to: m.from, d: JSON.stringify({ t: "auth", nonce: "nonceFAKE0001", proof: "0".repeat(64) }) });
          // 증명 없이 '되찾았다'고 하고 가짜 화면을 보낸다
          ch.postMessage({ k: "data", from: "host", to: m.from, d: JSON.stringify({ t: "welcome", seat: 1, gid: cred.gid }) });
        }
      }
    };
    const V = clientFor(code, cred);
    ok(await until(() => V.ev.status.some(([st, why]) => st === "reconnecting" && why === "impostor")), "가짜 방장의 증명이 틀리면 끊고 다시 시도");
    ok(V.ev.welcome.length === 0, "증명 없는 welcome은 믿지 않는다");
    ok(got.length >= 1 && got.every((d) => !d.includes(cred.secret) && !/"t":"auth"/.test(d)), "가짜 방장이 받은 것: hello뿐 (비밀값 · 손님 증명 없음) " + got.join(" "));
    V.c.close(); ch.close();
    // 증명 없이 바로 '되찾았다'(welcome)고 하는 가짜 방장: 그 welcome · 화면을 받지 않는다
    const code2 = "TESTB2", ch2 = new BroadcastChannel("holdem-net-" + code2);
    const m0 = newMatch(3);
    T.startHand(m0, deck());
    const fakeView = N.viewFor(m0, 1, { match: "fake", code: code2 });
    ch2.onmessage = (e) => {
      const m = e.data;
      if (m.k === "open") ch2.postMessage({ k: "accept", to: m.from });
      else if (m.k === "data" && m.to === "host" && JSON.parse(m.d).t === "hello") {
        for (const o of [{ t: "welcome", seat: 1, gid: cred.gid }, { t: "state", view: fakeView }]) ch2.postMessage({ k: "data", from: "host", to: m.from, d: JSON.stringify(o) });
      }
    };
    const W = clientFor(code2, cred);
    await sleep(400);
    ok(W.ev.welcome.length === 0 && W.ev.states === 0 && !W.c.open, "증명 없는 welcome · 화면은 무시");
    W.c.close(); ch2.close();
  }
  // 4) 틀린 손님 증명 · 확인 전 ping · 연결 수 제한
  {
    const code = "TESTC", room = N.createRoom(6, "방장");
    const H = hostFor(code, room, { maxConns: 3 });
    await until(() => H.ev.ready, 2000);
    const A = clientFor(code, null);
    await until(() => A.ev.welcome.length === 1);
    const gid = A.ev.creds[0].gid;
    // 손으로 만든 연결: gid는 알지만 비밀값은 모른다
    const raw = new BroadcastChannel("holdem-net-" + code), id = "rawconn01", rx = [];
    raw.onmessage = (e) => { if (e.data.to === id) rx.push(e.data); };
    const sendRaw = (o) => raw.postMessage({ k: "data", from: id, to: "host", d: JSON.stringify(o) });
    raw.postMessage({ k: "open", from: id });
    await until(() => rx.some((m) => m.k === "accept"));
    sendRaw({ t: "ping" });
    await sleep(80);
    ok(!rx.some((m) => m.k === "data" && m.d.includes("pong")), "확인 전에는 ping에 답하지 않는다");
    sendRaw({ t: "hello", v: N.V, name: "도둑", gid, nonce: "nonceTHIEF01" });
    ok(await until(() => rx.some((m) => m.k === "data" && m.d.includes('"auth"'))), "방장이 먼저 증명");
    sendRaw({ t: "auth", proof: "f".repeat(64) });
    ok(await until(() => rx.some((m) => m.k === "close")), "틀린 증명 → 끊음");
    ok(H.ev.hellos.length === 1 && room.guests[0].connected && !rx.some((m) => m.k === "data" && m.d.includes("welcome")), "틀린 증명으로는 자리를 못 얻는다");
    // 연결 수 제한: 이미 1개(A) + 2개까지
    const extra = [];
    for (let i = 0; i < 4; i++) {
      const cid = "flood" + i, c = new BroadcastChannel("holdem-net-" + code), r = [];
      c.onmessage = (e) => { if (e.data.to === cid) r.push(e.data.k); };
      c.postMessage({ k: "open", from: cid });
      extra.push({ c, r });
    }
    await sleep(150);
    ok(H.host.conns <= 3, `연결 수 제한 (${H.host.conns})`);
    ok(extra.filter((x) => x.r.includes("close")).length >= 2, "넘친 연결은 바로 닫는다");
    for (const x of extra) x.c.close();
    raw.close(); A.c.close(); H.host.close();
  }
  // 5) 확인을 마치지 않은 연결은 HELLO_MS 뒤 정리
  {
    const code = "TESTD", room = N.createRoom(3, "방장");
    const H = hostFor(code, room);
    await until(() => H.ev.ready, 2000);
    const raw = new BroadcastChannel("holdem-net-" + code), rx = [];
    raw.onmessage = (e) => { if (e.data.to === "silent01") rx.push(e.data.k); };
    raw.postMessage({ k: "open", from: "silent01" });
    await until(() => H.host.conns === 1);
    ok(await until(() => H.host.conns === 0 && rx.includes("close"), N.HELLO_MS + 3000), "hello 없는 연결은 몇 초 뒤 끊는다");
    raw.close(); H.host.close();
  }
  console.log(fails ? `${fails} FAILED` : "ALL OK");
  process.exit(fails ? 1 : 0);
})();
