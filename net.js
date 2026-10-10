// ===== 온라인 멀티플레이: 전송 · 프로토콜 =====
// 방장(호스트) 브라우저가 진짜 매치를 돌리는 딜러다. 손님은 자기 자리용으로 걸러진 화면(view)만 받고, 행동만 보낸다.
// 전송은 두 가지: PeerJS(WebRTC, 기본) · BroadcastChannel(?net=local — 같은 브라우저의 탭끼리, 테스트·한 기기용)
// 순수 함수(viewFor · 메시지 검사 · 자리 배정)는 node에서도 require 해서 테스트한다 (test/net.test.js).
// 브라우저에서는 전역 PokerNet 하나만 만든다.
(function (root) {
"use strict";
const isNode = typeof module !== "undefined" && typeof require === "function";
const PT = isNode ? require("./table.js") : root.PokerTable;

// ===== 상수 =====
const V = 1;                                        // 프로토콜 버전
const CODE_ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 헷갈리는 0 · O · 1 · I · L 은 뺐다
const CODE_LEN = 5;
const ID_PREFIX = "holdem-";                         // PeerJS 방장 아이디 = holdem-코드
const NAME_MAX = 10;
const MAX_IN = 2048;                                 // 손님 → 방장 메시지 최대 길이 (글자)
const MAX_OUT = 262144;                              // 방장 → 손님
const PING_MS = 3000;                                // 손님이 이 간격으로 ping
const DEAD_MS = 10000;                               // 이만큼 아무 소식이 없으면 끊긴 것으로 본다
const TOKEN_RE = /^[A-Za-z0-9_-]{8,48}$/;
const ACT_TYPES = ["fold", "check", "call", "raise"];
const ACTION_TYPES = ["sb", "bb", "fold", "check", "call", "bet", "raise", "return"];

// ===== 작은 도구 =====
function rnd(n) {
  const c = root.crypto;
  if (c && c.getRandomValues) {
    const buf = new Uint32Array(1), limit = Math.floor(0x100000000 / n) * n;
    do c.getRandomValues(buf); while (buf[0] >= limit);
    return buf[0] % n;
  }
  return Math.floor(Math.random() * n);
}
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function newToken(len = 20) {
  let s = "";
  for (let i = 0; i < len; i++) s += B62[rnd(B62.length)];
  return s;
}
function makeCode(rand = rnd) {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHA[rand(CODE_ALPHA.length)];
  return s;
}
// 입력한 코드를 정리한다 (소문자 · 공백 · 하이픈 허용). 올바르지 않으면 null
function normCode(s) {
  const t = String(s == null ? "" : s).toUpperCase().replace(/[\s-]/g, "");
  if (t.length !== CODE_LEN) return null;
  for (const ch of t) if (!CODE_ALPHA.includes(ch)) return null;
  return t;
}
// 이름: 제어·서식 문자 제거, 공백 정리, 최대 10자
function cleanName(s, fallback = "") {
  let t = String(s == null ? "" : s);
  if (t.normalize) t = t.normalize("NFC");
  t = t.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff0-\uffff]/g, "").replace(/ +/g, " ").trim();
  t = Array.from(t).slice(0, NAME_MAX).join("").trim();
  return t || fallback;
}
const isInt = (x) => Number.isInteger(x);
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const isCard = (c) => isInt(c) && c >= 0 && c < 52;
function parseJSON(raw, max) {
  if (typeof raw !== "string" || raw.length > max) return null;
  try {
    const o = JSON.parse(raw);
    return isObj(o) ? o : null;
  } catch (e) {
    return null;
  }
}

// ===== 자리별 화면 (view) =====
// seat 한 자리에 보내도 되는 것만 담는다: 공개 정보 + 그 자리의 카드 + 공개된(shown) 카드.
// 덱 · 다른 자리의 카드 · 방장 내부 상태는 절대 넣지 않는다.
// extra: { match, code, connected[seat], turn: {seat, left, total}, next: ms }
function viewFor(m, seat, extra = {}) {
  const h = m.hand, conn = extra.connected || [];
  const v = {
    v: V, seat, match: String(extra.match || ""), code: String(extra.code || ""),
    handNo: m.handNo, over: !!m.over, startStack: m.startStack,
    levels: m.levels.map((l) => [l[0], l[1]]), handsPerLevel: m.handsPerLevel,
    players: m.players.map((p, s) => ({
      name: p.name, kind: p.kind === "bot" ? "ai" : "human", stack: p.stack, out: !!p.out, place: p.place || 0,
      connected: conn[s] !== false, host: s === 0,
    })),
    hand: null, legal: null, turn: null, next: null,
  };
  if (h) {
    v.hand = {
      no: h.no, sb: h.sb, bb: h.bb, button: h.button, sbSeat: h.sbSeat, bbSeat: h.bbSeat,
      seats: h.seats.slice(), board: h.board.slice(), street: h.street,
      bets: h.bets.slice(), contrib: h.contrib.slice(), folded: h.folded.slice(),
      actedOn: h.actedOn.slice(), lastRaise: h.lastRaise, aggressor: h.aggressor.slice(),
      toAct: h.toAct, phase: h.phase, shown: h.shown.slice(), start: h.start.slice(),
      actions: h.actions.map((a) => {
        const o = { street: a.street, seat: a.seat, type: a.type };
        for (const k of ["amount", "to", "allin", "full", "timeout", "auto"]) if (a[k] !== undefined) o[k] = a[k];
        return o;
      }),
      hole: h.hole.map((cs, s) => (cs && (s === seat || h.shown[s]) ? cs.slice() : null)),
      result: h.result ? {
        showdown: !!h.result.showdown,
        pots: h.result.pots.map((p) => ({ amount: p.amount, eligible: p.eligible.slice(), winners: p.winners.slice() })),
        won: h.result.won.slice(),
        // 쇼다운 족보는 공개된 자리만 (쇼다운에 간 자리는 모두 shown)
        hands: h.result.hands.map((x, s) => (x && h.shown[s] ? { score: x.score, best: x.best.slice(), label: x.label } : null)),
      } : null,
    };
    if (h.phase === "bet" && h.toAct === seat && seat >= 0) v.legal = PT.legal(m, seat);
  }
  const t = extra.turn;
  if (t && isInt(t.seat)) v.turn = { seat: t.seat, left: Math.max(0, Math.round(t.left)), total: Math.round(t.total) };
  if (Number.isFinite(extra.next)) v.next = Math.max(0, Math.round(extra.next));
  return v;
}

// view → 화면·규칙 함수(PokerTable)가 그대로 쓸 수 있는 매치 모양. 보이지 않는 카드는 [null, null]
function viewToMatch(v) {
  const h = v.hand ? Object.assign({}, v.hand) : null;
  if (h) {
    h.hole = h.hole.map((cs, s) => cs || (h.seats.includes(s) ? [null, null] : null));
    h.deck = [];
  }
  return {
    v: 2, players: v.players.map((p) => Object.assign({}, p)), startStack: v.startStack,
    levels: v.levels, handsPerLevel: v.handsPerLevel, button: h ? h.button : -1,
    handNo: v.handNo, hand: h, over: v.over,
  };
}

// ===== 손님 → 방장 메시지 검사 =====
// hello {v, name, token} · act {hand, n, type, to} · ping. 틀리면 null (무시)
function parseGuestMsg(raw) {
  const o = parseJSON(raw, MAX_IN);
  if (!o) return null;
  switch (o.t) {
    case "hello":
      if (!isInt(o.v) || typeof o.name !== "string" || o.name.length > 64 || typeof o.token !== "string" || !TOKEN_RE.test(o.token)) return null;
      return { t: "hello", v: o.v, name: cleanName(o.name), token: o.token };
    case "act": {
      if (!isInt(o.hand) || o.hand < 1 || o.hand > 1e6 || !isInt(o.n) || o.n < 0 || o.n > 10000) return null;
      if (!ACT_TYPES.includes(o.type)) return null;
      if (o.type === "raise") {
        if (typeof o.to !== "number" || !Number.isFinite(o.to) || o.to < 0 || o.to > 1e9) return null;
        return { t: "act", hand: o.hand, n: o.n, type: "raise", to: Math.round(o.to) };
      }
      if (o.to !== undefined && o.to !== null) return null;
      return { t: "act", hand: o.hand, n: o.n, type: o.type };
    }
    case "ping":
      return { t: "ping" };
    default:
      return null;
  }
}

// 손님의 행동이 지금 둘 수 있는 수인지: 같은 핸드 · 같은 시점(n = 행동 수) · 그 자리 차례 · 규칙상 가능
function checkAct(m, seat, a) {
  const h = m && m.hand;
  if (!h) return { ok: false, why: "no-hand" };
  if (a.hand !== h.no || a.n !== h.actions.length) return { ok: false, why: "stale" };
  if (h.phase !== "bet" || h.toAct !== seat) return { ok: false, why: "turn" };
  const L = PT.legal(m, seat);
  let type = a.type, to;
  if (type === "fold" && L.toCall === 0) return { ok: false, why: "illegal" };
  if (type === "check" && L.toCall > 0) return { ok: false, why: "illegal" };
  if (type === "call" && L.toCall === 0) type = "check";
  if (type === "raise") {
    if (!L.canRaise || !Number.isFinite(a.to)) return { ok: false, why: "illegal" };
    to = Math.min(Math.max(Math.round(a.to), L.minTo), L.maxTo);
  }
  return { ok: true, type, to };
}

// ===== 방장 → 손님 메시지 검사 (손님 쪽) =====
function checkPlayers(list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > 6) return null;
  const out = [];
  for (const p of list) {
    if (!isObj(p) || typeof p.name !== "string" || p.name.length > 64) return null;
    if (!isInt(p.stack) || p.stack < 0 || !isInt(p.place) || p.place < 0 || p.place > 6) return null;
    out.push({
      name: cleanName(p.name, "?"), kind: p.kind === "ai" ? "ai" : "human", stack: p.stack, out: !!p.out,
      place: p.place, connected: p.connected !== false, host: !!p.host,
    });
  }
  return out;
}
const arrOf = (a, n, f) => Array.isArray(a) && a.length === n && a.every(f);
const seatOk = (n) => (s) => isInt(s) && s >= 0 && s < n;
const nonNeg = (x) => isInt(x) && x >= 0;

function checkHand(h, n) {
  if (!isObj(h)) return false;
  const seat = seatOk(n);
  if (!nonNeg(h.no) || !nonNeg(h.sb) || !nonNeg(h.bb) || !seat(h.button) || !seat(h.sbSeat) || !seat(h.bbSeat)) return false;
  if (!Array.isArray(h.seats) || h.seats.length < 2 || h.seats.length > n || !h.seats.every(seat)) return false;
  if (!Array.isArray(h.board) || h.board.length > 5 || !h.board.every(isCard)) return false;
  if (!isInt(h.street) || h.street < 0 || h.street > 3 || !["bet", "runout", "done"].includes(h.phase)) return false;
  if (!(h.toAct === -1 || seat(h.toAct)) || !nonNeg(h.lastRaise)) return false;
  if (!arrOf(h.bets, n, nonNeg) || !arrOf(h.contrib, n, nonNeg) || !arrOf(h.start, n, nonNeg)) return false;
  if (!arrOf(h.folded, n, (x) => typeof x === "boolean") || !arrOf(h.shown, n, (x) => typeof x === "boolean")) return false;
  if (!arrOf(h.actedOn, n, (x) => x === null || nonNeg(x)) || !Array.isArray(h.aggressor) || h.aggressor.length !== 4) return false;
  if (!arrOf(h.hole, n, (cs) => cs === null || arrOf(cs, 2, isCard))) return false;
  if (!Array.isArray(h.actions) || h.actions.length > 2000) return false;
  for (const a of h.actions) {
    if (!isObj(a) || !isInt(a.street) || a.street < 0 || a.street > 3 || !seat(a.seat) || !ACTION_TYPES.includes(a.type)) return false;
    if (a.amount !== undefined && !nonNeg(a.amount)) return false;
    if (a.to !== undefined && !nonNeg(a.to)) return false;
  }
  if (h.result !== null) {
    const r = h.result;
    if (!isObj(r) || !Array.isArray(r.pots) || r.pots.length > 8 || !arrOf(r.won, n, nonNeg) || !arrOf(r.hands, n, (x) => x === null || isObj(x))) return false;
    for (const p of r.pots) {
      if (!isObj(p) || !nonNeg(p.amount) || !Array.isArray(p.eligible) || !p.eligible.every(seat) || !Array.isArray(p.winners) || !p.winners.length || !p.winners.every(seat)) return false;
    }
    for (const x of r.hands) {
      if (x && (!isInt(x.score) || typeof x.label !== "string" || x.label.length > 60 || !Array.isArray(x.best) || x.best.length > 5 || !x.best.every(isCard))) return false;
    }
  }
  return true;
}

function checkView(v) {
  if (!isObj(v) || v.v !== V || !isInt(v.seat) || v.seat < -1 || v.seat > 5) return null;
  const players = checkPlayers(v.players);
  if (!players || v.seat >= players.length) return null;
  const n = players.length;
  if (!nonNeg(v.handNo) || !nonNeg(v.startStack) || !isInt(v.handsPerLevel) || v.handsPerLevel < 1) return null;
  if (!Array.isArray(v.levels) || !v.levels.length || v.levels.length > 64 || !v.levels.every((l) => arrOf(l, 2, nonNeg))) return null;
  if (v.hand !== null && !checkHand(v.hand, n)) return null;
  if (typeof v.match !== "string" || v.match.length > 64 || typeof v.code !== "string" || v.code.length > 16) return null;
  const out = Object.assign({}, v, { players, over: !!v.over });
  if (!isObj(v.legal)) out.legal = null;
  out.turn = isObj(v.turn) && isInt(v.turn.seat) && nonNeg(v.turn.left) && nonNeg(v.turn.total) ? v.turn : null;
  out.next = nonNeg(v.next) ? v.next : null;
  return out;
}

function parseHostMsg(raw) {
  const o = parseJSON(raw, MAX_OUT);
  if (!o) return null;
  switch (o.t) {
    case "welcome":
      return isInt(o.seat) && o.seat >= 0 && o.seat < 6 ? { t: "welcome", seat: o.seat } : null;
    case "lobby": {
      if (!isInt(o.seats) || o.seats < 2 || o.seats > 6 || !Array.isArray(o.players) || o.players.length > 6) return null;
      const players = [];
      for (const p of o.players) {
        if (!isObj(p) || !isInt(p.seat) || p.seat < 0 || p.seat > 5 || typeof p.name !== "string" || p.name.length > 64) return null;
        players.push({ seat: p.seat, name: cleanName(p.name, "?"), kind: p.kind === "ai" ? "ai" : "human", connected: p.connected !== false, isHost: !!p.isHost });
      }
      return { t: "lobby", code: normCode(o.code) || "", seats: o.seats, started: !!o.started, players, you: isInt(o.you) ? o.you : -1 };
    }
    case "state": {
      const view = checkView(o.view);
      return view ? { t: "state", view } : null;
    }
    case "error":
      return typeof o.msg === "string" && o.msg.length <= 200 ? { t: "error", msg: o.msg, fatal: !!o.fatal } : null;
    case "pong":
      return { t: "pong" };
    case "bye":
      return { t: "bye", reason: o.reason === "closed" ? "closed" : "left" };
    default:
      return null;
  }
}

// ===== 방(로비) — 자리 배정 =====
// room = { n, started, hostName, guests: [{ seat, name, token, conn, connected }] }
// 방장은 0번, 손님은 들어온 순서대로 1번부터. 빈 자리는 AI
function createRoom(n, hostName) {
  return { n, started: false, hostName: cleanName(hostName, "방장"), guests: [] };
}

// 같은 이름이 있으면 뒤에 숫자를 붙인다 (reserved = 이미 쓰는 이름들)
function uniqueName(name, reserved) {
  const taken = new Set(reserved);
  if (!taken.has(name)) return name;
  for (let k = 2; k < 100; k++) {
    const tail = String(k), base = Array.from(name).slice(0, NAME_MAX - tail.length).join("");
    if (!taken.has(base + tail)) return base + tail;
  }
  return name;
}

// 손님 입장. 같은 토큰이면 그 자리를 되찾는다. 결과: {ok, seat, back, replaced} 또는 {ok:false, msg}
function roomJoin(room, hello, conn, reserved = []) {
  const g = room.guests.find((x) => x.token === hello.token);
  if (g) {
    const replaced = g.conn !== null && g.conn !== conn ? g.conn : null;
    g.conn = conn;
    g.connected = true;
    if (!room.started) g.name = uniqueName(cleanName(hello.name, "손님"), [room.hostName, ...reserved, ...room.guests.filter((x) => x !== g).map((x) => x.name)]);
    return { ok: true, seat: g.seat, back: true, replaced };
  }
  if (room.started) return { ok: false, msg: "이미 게임이 시작된 방이에요" };
  if (room.guests.length >= room.n - 1) return { ok: false, msg: "자리가 다 찼어요" };
  const name = uniqueName(cleanName(hello.name, "손님"), [room.hostName, ...reserved, ...room.guests.map((x) => x.name)]);
  const ng = { seat: room.guests.length + 1, name, token: hello.token, conn, connected: true };
  room.guests.push(ng);
  return { ok: true, seat: ng.seat, back: false, replaced: null };
}

// 연결이 끊긴 손님. 시작 전이면 자리에서 빼고 다시 번호를 매긴다. 끊긴 손님의 자리 번호(없으면 -1)
function roomLeave(room, conn) {
  const g = room.guests.find((x) => x.conn === conn);
  if (!g) return -1;
  if (!room.started) {
    room.guests.splice(room.guests.indexOf(g), 1);
    room.guests.forEach((x, i) => { x.seat = i + 1; });
  } else {
    g.conn = null;
    g.connected = false;
  }
  return g.seat;
}

const roomGuestAt = (room, seat) => room.guests.find((g) => g.seat === seat) || null;

// ===== 전송: PeerJS (WebRTC) =====
// URL 파라미터로 시그널링 서버를 바꿀 수 있다 (테스트용): ?peerHost=&peerPort=&peerPath=&peerSecure=0|1
// 그 밖에는 PeerJS 기본값(공개 서버 · Google STUN · PeerJS TURN)을 그대로 쓴다
function peerOptions(params) {
  const o = { debug: 0 };
  const host = params && params.get("peerHost");
  if (host) {
    o.host = host;
    o.secure = params.get("peerSecure") !== "0";
    o.port = Number(params.get("peerPort")) || (o.secure ? 443 : 80);
    o.path = params.get("peerPath") || "/";
  }
  return o;
}

const PEER_NET_ERR = ["network", "server-error", "socket-error", "socket-closed", "disconnected"];

// 방장 쪽 PeerJS. h: onReady() · onOpen(id) · onData(id, str) · onClose(id) · onError(code) · onStatus(state)
function peerHost(code, opts, h) {
  const Peer = root.Peer;
  let peer = null, dead = false, rtimer = 0, backoff = 1000, everOpen = false;
  const conns = new Map();
  function reconnectLater() {
    clearTimeout(rtimer);
    if (dead) return;
    rtimer = setTimeout(() => {
      if (dead || !peer || peer.destroyed) return;
      if (peer.disconnected) { try { peer.reconnect(); } catch (e) { /* 다음에 다시 */ } }
      backoff = Math.min(backoff * 2, 15000);
      reconnectLater();
    }, backoff);
  }
  function start() {
    if (typeof Peer !== "function") { h.onError("unsupported"); return; }
    const o = Object.assign(peerOptions(opts.params), opts.peerToken ? { token: opts.peerToken } : {});
    peer = new Peer(ID_PREFIX + code, o);
    peer.on("open", () => {
      everOpen = true;
      clearTimeout(rtimer);
      backoff = 1000;
      h.onStatus("online");
      h.onReady();
    });
    peer.on("connection", (c) => {
      const id = c.connectionId;
      c.on("open", () => {
        if (dead) { c.close(); return; }
        conns.set(id, c);
        h.onOpen(id);
      });
      c.on("data", (d) => { if (conns.get(id) === c) h.onData(id, d); });
      c.on("close", () => {
        if (conns.get(id) !== c) return;
        conns.delete(id);
        h.onClose(id);
      });
      c.on("error", () => { try { c.close(); } catch (e) { /* 무시 */ } });
    });
    // 시그널링 서버와 끊겨도 이미 연결된 손님과의 통신은 이어진다. 새 손님을 받으려면 다시 붙는다
    // (처음 열 때 실패한 것은 onError로 알리고, 다시 여는 것은 부르는 쪽이 정한다)
    peer.on("disconnected", () => {
      if (dead) return;
      h.onStatus("offline");
      if (everOpen) reconnectLater();
    });
    peer.on("error", (e) => {
      const type = e && e.type;
      if (dead) return;
      if (type === "unavailable-id") h.onError("id-taken");
      else if (type === "browser-incompatible") h.onError("unsupported");
      else if (type === "peer-unavailable") { /* 방장은 먼저 연결하지 않는다 */ }
      else if (!everOpen) { h.onStatus("offline"); h.onError("network"); }
      else if (PEER_NET_ERR.includes(type)) { h.onStatus("offline"); reconnectLater(); }
      // 그 밖의 오류(한 손님과의 WebRTC 문제 등)는 그 연결의 close로 처리된다
    });
  }
  return {
    start,
    send(id, str) {
      const c = conns.get(id);
      if (c && c.open) { try { c.send(str); } catch (e) { /* 다음 상태에서 다시 */ } }
    },
    drop(id) {
      const c = conns.get(id);
      conns.delete(id);
      if (c) { try { c.close(); } catch (e) { /* 무시 */ } }
    },
    close() {
      dead = true;
      clearTimeout(rtimer);
      for (const c of conns.values()) { try { c.close(); } catch (e) { /* 무시 */ } }
      conns.clear();
      if (peer) { try { peer.destroy(); } catch (e) { /* 무시 */ } }
    },
  };
}

// 손님 쪽 PeerJS. h: onOpen() · onData(str) · onClose() · onError(code)
function peerGuest(code, opts, h) {
  const Peer = root.Peer, hostId = ID_PREFIX + code;
  let peer = null, conn = null, dead = false, otimer = 0;
  function fail(codeStr) {
    if (dead) return;
    dead = true;
    clearTimeout(otimer);
    h.onError(codeStr);
  }
  function dial() {
    if (dead) return;
    const c = peer.connect(hostId, { reliable: true, serialization: "raw" });
    if (!c) { fail("network"); return; }
    conn = c;
    c.on("open", () => {
      if (dead || conn !== c) return;
      clearTimeout(otimer);
      h.onOpen();
    });
    c.on("data", (d) => { if (!dead && conn === c) h.onData(d); });
    c.on("close", () => {
      if (dead || conn !== c) return;
      dead = true;
      clearTimeout(otimer);
      h.onClose();
    });
    c.on("error", () => { try { c.close(); } catch (e) { /* 무시 */ } });
  }
  return {
    connect() {
      if (typeof Peer !== "function") { fail("unsupported"); return; }
      // 엄격한 네트워크(일부 회사·학교 와이파이, 일부 모바일 데이터)에서는 연결이 끝내 열리지 않을 수 있다
      otimer = setTimeout(() => fail("timeout"), opts.openTimeout || 20000);
      peer = new Peer(peerOptions(opts.params));
      peer.on("open", () => { if (!conn) dial(); });
      peer.on("error", (e) => {
        const type = e && e.type;
        if (type === "peer-unavailable") fail("not-found");
        else if (type === "browser-incompatible") fail("unsupported");
        else if (!conn || !conn.open) fail("network"); // 연결된 뒤의 시그널링 오류는 무시 (데이터 통신은 따로)
      });
    },
    send(str) {
      if (!dead && conn && conn.open) { try { conn.send(str); } catch (e) { /* 무시 */ } }
    },
    close() {
      dead = true;
      clearTimeout(otimer);
      if (conn) { try { conn.close(); } catch (e) { /* 무시 */ } }
      if (peer) { try { peer.destroy(); } catch (e) { /* 무시 */ } }
    },
  };
}

// ===== 전송: BroadcastChannel (?net=local) =====
// 같은 브라우저(같은 저장소)의 탭끼리만 된다. 봉투: {k, from, to, d}
function bcHost(code, opts, h) {
  let ch = null, ready = false, taken = false, dead = false;
  const conns = new Set();
  return {
    start() {
      if (typeof root.BroadcastChannel !== "function") { h.onError("unsupported"); return; }
      ch = new root.BroadcastChannel("holdem-net-" + code);
      ch.onmessage = (e) => {
        const m = e.data;
        if (dead || !isObj(m)) return;
        if (m.k === "probe") { if (ready) ch.postMessage({ k: "here" }); }
        else if (m.k === "here") { if (!ready) taken = true; }
        else if (!ready || typeof m.from !== "string" || m.from.length > 40) { /* 무시 */ }
        else if (m.k === "open") {
          ch.postMessage({ k: "accept", to: m.from });
          if (!conns.has(m.from)) { conns.add(m.from); h.onOpen(m.from); }
        } else if (m.k === "data" && m.to === "host" && conns.has(m.from)) h.onData(m.from, m.d);
        else if (m.k === "close" && conns.has(m.from)) { conns.delete(m.from); h.onClose(m.from); }
      };
      ch.postMessage({ k: "probe" }); // 같은 코드로 열린 방이 있는지 잠깐 물어본다
      setTimeout(() => {
        if (dead) return;
        if (taken) { h.onError("id-taken"); return; }
        ready = true;
        h.onStatus("online");
        h.onReady();
      }, 300);
    },
    send(id, str) { if (ch && conns.has(id)) ch.postMessage({ k: "data", from: "host", to: id, d: str }); },
    drop(id) { if (ch && conns.delete(id)) ch.postMessage({ k: "close", from: "host", to: id }); },
    close() {
      dead = true;
      if (!ch) return;
      for (const id of conns) ch.postMessage({ k: "close", from: "host", to: id });
      conns.clear();
      ch.close();
    },
  };
}

function bcGuest(code, opts, h) {
  let ch = null, id = newToken(12), open = false, dead = false, otimer = 0;
  const fail = (c) => { if (!dead) { dead = true; clearTimeout(otimer); if (ch) ch.close(); h.onError(c); } };
  return {
    connect() {
      if (typeof root.BroadcastChannel !== "function") { fail("unsupported"); return; }
      ch = new root.BroadcastChannel("holdem-net-" + code);
      ch.onmessage = (e) => {
        const m = e.data;
        if (dead || !isObj(m) || m.to !== id) return;
        if (m.k === "accept" && !open) { open = true; clearTimeout(otimer); h.onOpen(); }
        else if (m.k === "data" && open) h.onData(m.d);
        else if (m.k === "close") { dead = true; ch.close(); h.onClose(); }
      };
      ch.postMessage({ k: "open", from: id });
      otimer = setTimeout(() => fail("not-found"), 2000);
    },
    send(str) { if (!dead && open) ch.postMessage({ k: "data", from: id, to: "host", d: str }); },
    close() {
      if (dead) return;
      dead = true;
      clearTimeout(otimer);
      if (ch) { ch.postMessage({ k: "close", from: id }); ch.close(); }
    },
  };
}

const hostLink = (kind) => (kind === "local" ? bcHost : peerHost);
const guestLink = (kind) => (kind === "local" ? bcGuest : peerGuest);

// ===== 방장 서버 =====
// opts: { kind, code?, peerToken?, resume, params }
// h: onReady(code) · onHello(id, msg) · onAct(id, msg) · onLeave(id) · onError(code) · onStatus(state)
function createHost(opts, h) {
  let code = opts.code || makeCode(), link = null, tries = 0, stopped = false, lastSweep = Date.now();
  const peers = new Map(); // id → { seen, hello, times[] }
  function start() {
    link = hostLink(opts.kind)(code, opts, {
      onReady() { if (!stopped) h.onReady(code); },
      onStatus(st) { if (!stopped) h.onStatus(st); },
      onOpen(id) { peers.set(id, { seen: Date.now(), hello: false, times: [] }); },
      onData(id, d) {
        const p = peers.get(id);
        if (!p || stopped) return;
        // 너무 자주 보내는 연결은 끊는다 (5초에 60개 넘게)
        const now = Date.now();
        p.times.push(now);
        while (p.times.length && now - p.times[0] > 5000) p.times.shift();
        if (p.times.length > 60) { drop(id); return; }
        const msg = parseGuestMsg(d);
        if (!msg) return;
        p.seen = now;
        if (msg.t === "ping") send(id, { t: "pong" });
        else if (msg.t === "hello") { if (!p.hello) { p.hello = true; h.onHello(id, msg); } }
        else if (msg.t === "act" && p.hello) h.onAct(id, msg);
      },
      onClose(id) { if (peers.delete(id) && !stopped) h.onLeave(id); },
      onError(c) {
        if (stopped) return;
        if (c === "id-taken" && !opts.resume && tries++ < 6) { // 코드가 겹쳤다: 다른 코드로
          link.close();
          code = makeCode();
          start();
          return;
        }
        h.onError(c);
      },
    });
    link.start();
  }
  // 소식이 끊긴 손님 정리. 이 탭이 잠들어 있었다면(타이머가 밀림) 이번엔 봐준다
  const sweep = setInterval(() => {
    const now = Date.now();
    if (now - lastSweep > PING_MS * 2) for (const p of peers.values()) p.seen = now;
    lastSweep = now;
    for (const [id, p] of peers) if (now - p.seen > DEAD_MS) drop(id);
  }, 1000);
  function send(id, obj) {
    if (!stopped && link) link.send(id, JSON.stringify(obj));
  }
  function drop(id, last) {
    if (!peers.has(id)) return;
    peers.delete(id);
    if (last) send(id, last);
    setTimeout(() => link && link.drop(id), last ? 400 : 0); // 마지막 메시지가 나갈 틈을 준다
    if (!stopped) h.onLeave(id);
  }
  start();
  return {
    get code() { return code; },
    send, drop,
    wake() { const now = Date.now(); lastSweep = now; for (const p of peers.values()) p.seen = now; },
    close(reason) {
      if (stopped) return;
      for (const id of peers.keys()) send(id, { t: "bye", reason: reason || "closed" });
      stopped = true;
      clearInterval(sweep);
      peers.clear();
      const l = link;
      setTimeout(() => l && l.close(), reason === "left" ? 0 : 300);
    },
  };
}

// ===== 손님 클라이언트 =====
// opts: { kind, code, name, token, persistent, params, giveUpMs }
// h: onWelcome(seat) · onLobby(msg) · onState(view) · onError(msg, fatal) · onBye(reason) · onStatus(state, code) · onFatal(code)
// 끊기면 알아서 다시 붙는다 (persistent가 아니면 처음 연결에서 방을 못 찾았을 때는 바로 포기)
function createClient(opts, h) {
  let link = null, stopped = false, opened = false, ever = false, lastHeard = 0, lastTick = Date.now();
  let retry = 0, lostAt = 0, attempt = 0;
  function connect() {
    if (stopped) return;
    if (link) link.close();
    const me = guestLink(opts.kind)(opts.code, opts, {
      onOpen() {
        if (link !== me || stopped) return;
        opened = ever = true;
        lostAt = 0;
        attempt = 0;
        lastHeard = Date.now();
        h.onStatus("open");
        sendRaw({ t: "hello", v: V, name: opts.name, token: opts.token });
      },
      onData(d) {
        if (link !== me || stopped) return;
        const msg = parseHostMsg(d);
        if (!msg) return;
        lastHeard = Date.now();
        dispatch(msg);
      },
      onClose() { if (link === me) lost("closed"); },
      onError(c) { if (link === me) lost(c); },
    });
    link = me;
    me.connect();
  }
  function lost(c) {
    if (stopped) return;
    opened = false;
    if (link) { link.close(); link = null; }
    if (c === "unsupported") { stop(); h.onFatal(c); return; }
    if (!ever && !opts.persistent && (c === "not-found" || c === "timeout")) { stop(); h.onFatal(c); return; }
    const now = Date.now();
    if (!lostAt) lostAt = now;
    const limit = ever || opts.persistent ? opts.giveUpMs || 120000 : 25000;
    if (now - lostAt > limit) { stop(); h.onFatal(ever ? "gone" : c); return; }
    h.onStatus("reconnecting", c);
    clearTimeout(retry);
    retry = setTimeout(connect, Math.min(1000 + attempt++ * 1000, 5000));
  }
  function dispatch(msg) {
    switch (msg.t) {
      case "welcome": h.onWelcome(msg.seat); break;
      case "lobby": h.onLobby(msg); break;
      case "state": h.onState(msg.view); break;
      case "error":
        if (msg.fatal) stop();
        h.onError(msg.msg, msg.fatal);
        break;
      case "bye":
        if (msg.reason === "closed") stop();
        h.onBye(msg.reason);
        break;
      default: break; // pong
    }
  }
  function sendRaw(obj) { if (link && opened) link.send(JSON.stringify(obj)); }
  // ping · 방장 소식 확인. 이 탭이 잠들어 있었다면(타이머가 밀림) 기다림을 새로 시작한다
  const beat = setInterval(() => {
    const now = Date.now();
    if (now - lastTick > PING_MS * 2) lastHeard = now;
    lastTick = now;
    if (!opened) return;
    if (now - lastHeard > DEAD_MS) { lost("timeout"); return; }
    sendRaw({ t: "ping" });
  }, PING_MS);
  function stop() {
    stopped = true;
    opened = false;
    clearTimeout(retry);
    clearInterval(beat);
    if (link) { link.close(); link = null; }
  }
  connect();
  return {
    send: sendRaw,
    close: stop,
    get open() { return opened; },
    // 화면이 다시 보일 때: 오래 조용했으면 바로 다시 붙는다
    check() {
      if (stopped) return;
      const now = Date.now();
      lastTick = now;
      if (opened && now - lastHeard > DEAD_MS) lost("timeout");
      else if (opened) sendRaw({ t: "ping" });
      else if (!link) { clearTimeout(retry); connect(); }
    },
  };
}

const supported = (kind) => (kind === "local" ? typeof root.BroadcastChannel === "function"
  : typeof root.Peer === "function" && typeof root.RTCPeerConnection === "function");

const api = {
  V, CODE_ALPHA, CODE_LEN, ID_PREFIX, NAME_MAX, MAX_IN, MAX_OUT, PING_MS, DEAD_MS,
  newToken, makeCode, normCode, cleanName, uniqueName,
  viewFor, viewToMatch, parseGuestMsg, parseHostMsg, checkAct, checkView,
  createRoom, roomJoin, roomLeave, roomGuestAt,
  peerOptions, createHost, createClient, supported,
};
if (isNode) module.exports = api;
else root.PokerNet = api;
})(globalThis);
