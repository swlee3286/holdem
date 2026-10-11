// ===== 설정 =====
// 2~6인 노리밋 홀덤 화면. 규칙은 table.js(PokerTable), AI는 gto.js(PokerAI), 카드·족보는 engine.js, 온라인은 net.js(PokerNet)
const SAVE_KEY = "holdem-table-v2";
const HINT_KEY = "holdem-table-v2-hint";
const ROOM_KEY = "holdem-room-v1";   // 방장: 방 · 매치 (새로고침하면 같은 코드로 다시 연다)
const NET_KEY = "holdem-net-v1";     // 내 이름 · 마지막으로 들어간 방 · 방마다 받은 자리 (손님)
const TAB_KEY = "holdem-net-tab-v1"; // 이 탭이 앉은 자리 (sessionStorage: 새로고침해도 남고 탭마다 다르다)
const START_STACK = 2000;
const HANDS_PER_LEVEL = 10;
const LEVELS = [[10, 20], [15, 30], [20, 40], [30, 60], [40, 80], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000], [750, 1500], [1000, 2000]];
const YOU = 0, CLAUDE = 1;
// 좌석 0 = 나, 1 = Claude, 2~5 = AI 플레이어 (친구와 하기: 0 = 방장, 1~ = 들어온 순서대로 손님, 나머지 AI)
const ROSTER = [
  { name: "나", kind: "human", initial: "나", color: "var(--ivory)" },
  { name: "Claude", kind: "claude", initial: "C", color: "var(--clay)" },
  { name: "민지", kind: "bot", initial: "민", color: "#7fa7c4" },
  { name: "준호", kind: "bot", initial: "준", color: "#a593c8" },
  { name: "서윤", kind: "bot", initial: "서", color: "#8fbf9a" },
  { name: "태현", kind: "bot", initial: "태", color: "#c98f9f" },
];
const STREET_KO = ["프리플롭", "플롭", "턴", "리버"];
const STREET_EN = ["Preflop", "Flop", "Turn", "River"];
const PT = PokerTable;
const PUBLIC_URL = "https://swlee3286.github.io/holdem/";

// ===== 자리 배치 =====
// 테이블 상자 기준 % 좌표. seat = 명패 가운데, bet = 베팅 칩 · 행동 표시 자리
// 나는 아래 가운데, 좌석 번호가 커지는 방향(시계 방향) = 아래 → 왼쪽 → 위 → 오른쪽
// wide = 가로로 긴 테이블(넓은 화면), tall = 세로로 긴 테이블(폰)
// bubble = Claude 말풍선 위치 (기본: 명패 오른쪽, 오른쪽 자리면 왼쪽)
// 배열 인덱스는 '화면 위치'다: (좌석 - 내 좌석 + 인원) % 인원. 혼자 하기에서는 좌석 번호와 같다
const LAYOUT = {
  wide: {
    2: { seat: [[50, 100], [50, 0]], bet: [[50, 70], [50, 27]] },
    3: { seat: [[50, 100], [15, 11], [85, 11]], bet: [[50, 70], [28, 31], [72, 31]] },
    4: { seat: [[50, 100], [3, 50], [50, 0], [97, 50]], bet: [[50, 70], [20, 50], [50, 27], [80, 50]], bubble: "above" },
    5: { seat: [[50, 100], [4, 70], [20, 6], [80, 6], [96, 70]], bet: [[50, 70], [22, 58], [29, 30], [71, 30], [79, 63]] },
    6: { seat: [[50, 100], [4, 72], [12, 14], [50, 0], [88, 14], [96, 72]], bet: [[50, 70], [22, 59], [25, 31], [50, 27], [75, 31], [79, 64]] },
  },
  tall: {
    2: { seat: [[50, 100], [50, 0]], bet: [[50, 76], [50, 31]], bubble: "below" },
    3: { seat: [[50, 100], [13, 16], [87, 16]], bet: [[50, 76], [27, 33], [73, 33]] },
    4: { seat: [[50, 100], [13, 27], [50, 0], [87, 27]], bet: [[50, 76], [37, 35], [50, 19], [63, 35]] },
    5: { seat: [[50, 100], [13, 70], [15, 18], [85, 18], [87, 70]], bet: [[50, 64], [29, 62], [36, 34], [64, 34], [71, 62]] },
    6: { seat: [[50, 100], [13, 72], [13, 27], [50, 0], [87, 27], [87, 72]], bet: [[50, 64], [29, 63], [37, 35], [50, 19], [63, 35], [71, 63]] },
  },
};

let S = null;          // 매치 상태 + 화면 기록 (혼자 하기 · 방장은 localStorage에 저장, 손님은 받은 화면으로 만든다)
let sampleFn = null;   // claude.use("sample") — Claude에게 수를 묻는 함수
let link = "checking"; // checking | live | paused | offline
let thinking = null;   // Claude 차례 진행 중: { hand, ctl, n }
let timer = 0;         // 봇 차례 · 카드 펼치기 타이머
let endTimer = 0;      // 탈락 · 우승 창 타이머
let sayTimer = 0;      // 말풍선 감추기 타이머
let fast = false;      // 빨리 감기 (내가 핸드에서 빠졌을 때)
let hintOn = false;    // GTO 힌트 표시
let hint = { key: "", d: null };
let controlsKey = "", logKey = "", tableKey = "";
let turnKey = "", turnAt = 0; // 내 차례 버튼이 새로 나타난 때: 더블클릭·연타가 새 버튼을 누르지 않게 잠깐 막는다
const INPUT_LOCK_MS = 350;
let setup = { n: 6, claude: true, tab: "solo", resume: false, name: "", code: "", link: false, err: "", mpN: 4 }; // 설정 창에서 고른 값 (link: 참가 링크로 들어옴)
let modalScreen = "";  // 지금 열린 창 이름 (로비처럼 내용만 바꿔 그리는 창)
const tallMQ = window.matchMedia("(max-width: 600px)");

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("ko-KR");
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const nm = (s) => (s === ME ? "나" : S.m.players[s].name);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");

// ===== 친구와 하기: 설정 =====
// 방장 브라우저가 딜러(진짜 매치)이고, 손님은 자기 자리 화면만 받아 그린다. 전송은 net.js
const QS = new URLSearchParams(location.search);
const NET_KIND = QS.get("net") === "local" ? "local" : "peer"; // ?net=local: 같은 브라우저 탭끼리 (테스트용)
const numParam = (k, d, lo, hi) => {
  const v = Number(QS.get(k));
  return QS.has(k) && Number.isFinite(v) ? clamp(v, lo, hi) : d;
};
const TURN_MS = numParam("turnSec", 30, 5, 120) * 1000; // 사람 차례 제한 시간
const NEXT_MS = numParam("nextSec", 5, 1, 30) * 1000;   // 핸드가 끝나고 다음 핸드까지
const RESUME_MS = 20 * 60 * 1000;                       // 방장 새로고침 · 손님 재접속을 이어 주는 시간
const GRACE_MS = 15000;                                 // 끊긴 손님 차례: 이만큼은 사람을 기다린 뒤 AI가 대신 둔다
const TAKEN_MS = 120000;                                // 방장 새로고침: 서버가 예전 연결을 정리할 때까지 같은 코드로 다시 시도하는 시간
const CRED_MS = 24 * 60 * 60 * 1000;                    // 손님: 방마다 받은 자리 비밀값을 기억하는 시간
const tokOk = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{8,48}$/.test(x);
// 아티팩트 진입 파일(artifact.html)은 PeerJS를 일부러 불러오지 않는다. 태그가 있는데 Peer가 없으면 파일을 못 불러온 것
const ARTIFACT = !document.querySelector('script[src*="peerjs"]') || !!window.claude;

let mode = "solo";     // solo | host | guest
let ME = 0;            // 화면 아래 가운데에 앉는 내 좌석
let net = null;        // PokerNet.createHost / createClient
let room = null;       // 방장: { code, n, hostName, started, guests, ready, status, note, error, takenAt }
let guest = null;      // 손님: { code, name, seat, cred, status, lobby, view, at, pending, gone }
let turnTimer = 0, nextTimer = 0, tickTimer = 0, pendTimer = 0, toastTimer = 0, retryTimer = 0;
let wakeLock = null;
let profile = loadProfile();

try { hintOn = localStorage.getItem(HINT_KEY) === "1"; } catch {}

// 이 화면이 Claude를 부를 수 있는지 (아티팩트 안에서만 가능, 로컬 파일은 GTO 엔진이 대신)
const sampleReady = (async () => {
  try {
    sampleFn = window.claude?.use ? await window.claude.use("sample") : null;
  } catch {
    sampleFn = null;
  }
  link = sampleFn ? "live" : "offline";
  renderTop();
  return sampleFn;
})();

// 친구와 하기를 쓸 수 있는지: 아티팩트 안에서는 외부 연결이 막혀 있어 안 된다 (GitHub Pages · 로컬에서만)
const netOk = () => typeof PokerNet === "object" && !ARTIFACT && PokerNet.supported(NET_KIND);

// ===== 매치 =====
function newMatch(n, claudeOn) {
  stopAll();
  const players = ROSTER.slice(0, n).map((r) => ({ name: r.name, kind: r.kind }));
  S = {
    v: 2,
    m: PT.createMatch({ players, startStack: START_STACK, levels: LEVELS, handsPerLevel: HANDS_PER_LEVEL }),
    claudeOn: !!claudeOn,
    depth: S?.depth === "default" ? "default" : "quick",
    stats: { hands: 0, vpip: 0, pfr: 0, aggr: 0, calls: 0, facedBet: 0, foldedToBet: 0, showdowns: [] }, // 내 성향 (Claude가 참고)
    history: [],   // 끝난 핸드 기록 (최근 30개)
    log: [],       // 지금 핸드 기록
    logAt: null,   // 기록에 옮긴 위치
    say: null,     // Claude 말풍선 { text, note }
    track: null,   // 이번 핸드 VPIP/PFR 집계 여부
    biggestPot: 0,
    doneNo: 0,     // 마무리 처리한 핸드 번호
    ended: "",     // "" | bust(탈락 창 봄) | over(최종 결과 창 봄)
    watched: false, // 탈락 뒤 계속 지켜봤는지
  };
  fast = false;
  tableKey = controlsKey = logKey = turnKey = "";
  startHand();
}

function startHand() {
  const m = S.m;
  if (mode === "guest" || m.over || (m.hand && m.hand.phase !== "done")) return;
  stopAll();
  PT.startHand(m);
  const h = m.hand;
  S.say = null;
  S.track = { vpip: false, pfr: false };
  if (mode === "host") { S.turn = null; S.nextAt = 0; }
  if (!m.players[ME].out) fast = false;
  if (h.seats.includes(ME)) S.stats.hands++;
  beginLog(h);
  advance();
}

// 새 핸드의 첫 기록 줄
function beginLog(h) {
  S.log = [];
  S.logAt = { a: 0, street: 0, shown: false, done: false };
  addLog(`블라인드 ${h.sb}/${h.bb} · 버튼 ${esc(nm(h.button))} · ${h.seats.length}명`);
  if (h.seats.includes(ME) && h.hole[ME]?.[0] != null) addLog(`내 카드 ${cardsHtml(h.hole[ME])} · ${PT.positionsOf(h)[ME]}`);
}

function stopAll() {
  clearTimeout(timer);
  clearTimeout(endTimer);
  clearTimeout(turnTimer);
  clearTimeout(nextTimer);
  if (thinking) { thinking.stopped = true; thinking.ctl.abort(); } // 멈춤(설정 창 등): 이 수는 두지 않고, 이어하면 다시 묻는다
  thinking = null;
}

// 상태가 바뀔 때마다: 기록 · 저장 · 그리기, 그리고 다음 차례를 예약한다 (손님은 방장이 보낸 화면만 그린다)
function advance() {
  if (!S || mode === "guest") return;
  const m = S.m, h = m.hand;
  clearTimeout(timer);
  syncLog();
  if (h.phase === "done") {
    handDone(h);
    // 탈락 · 우승 창 (설정 창 등으로 멈췄다 이어해도 다시 예약)
    if (needsEndModal()) {
      clearTimeout(endTimer);
      endTimer = setTimeout(showEnd, 1600);
    }
  }
  if (mode === "host") {
    if (room?.ready) hostSchedule();
    save();
    render();
    hostBroadcast();
    return;
  }
  save();
  render();
  if (h.phase === "runout") {
    timer = setTimeout(() => {
      if (!S || S.m !== m || m.hand !== h || h.phase !== "runout") return;
      PT.runoutStep(m);
      advance();
    }, fast ? 80 : 900);
  } else if (h.phase === "bet") {
    const seat = h.toAct;
    if (seat === YOU) return;
    if (seat === CLAUDE && claudeWanted(h)) {
      if (link === "checking") {
        sampleReady.then(() => { if (S && S.m === m && m.hand === h && h.toAct === seat && !thinking) advance(); });
        return;
      }
      if (link === "live" && sampleFn) { claudeTurn(h); return; }
    }
    timer = setTimeout(() => botTurn(m, h, seat), fast ? 80 : 450 + Math.random() * 450);
  }
}

// Claude에게 직접 물을지: 내가 이 핸드에서 아직 베팅할 수 있을 때만 (Claude 사용량 아끼기)
function claudeWanted(h) {
  const me = S.m.players[YOU];
  return S.claudeOn && h.seats.includes(YOU) && !h.folded[YOU] && me.stack > 0;
}

function botTurn(m, h, seat) {
  if (!S || S.m !== m || m.hand !== h || h.phase !== "bet" || h.toAct !== seat) return;
  const mv = engineMove(m, seat);
  doAct(seat, mv.action, mv.to, "", m.players[seat].kind === "remote" ? "auto" : ""); // 연결이 끊긴 손님 자리는 AI가 대신
}

// 누구의 수든 여기로: 성향 집계 · 말 기록 → 규칙 엔진 → 다음. flag: 행동 기록에 붙일 표시 (timeout · auto)
function doAct(seat, type, to, say, flag) {
  const m = S.m, h = m.hand, L = PT.legal(m, seat);
  if (seat === YOU) trackHuman(h, type, L);
  if (say) addLog(`<span class="said">${esc(nm(seat))}: “${esc(say)}”</span>`);
  let rec;
  try {
    rec = PT.act(m, seat, type, to);
  } catch {
    rec = PT.act(m, seat, L.toCall === 0 ? "check" : "fold"); // 규칙상 안 되는 수가 들어오면 체크 또는 폴드
  }
  if (flag && rec) rec[flag] = true;
  advance();
}

// 핸드가 끝났을 때 한 번만
function handDone(h) {
  if (S.doneNo === h.no) return;
  S.doneNo = h.no;
  const m = S.m, r = h.result;
  S.biggestPot = Math.max(S.biggestPot, r.pots.reduce((t, p) => t + p.amount, 0));
  if (S.stats && r.showdown && r.hands[ME]) {
    S.stats.showdowns = [...S.stats.showdowns, {
      cards: h.hole[ME].map(cardCode).join(""), hand: describeEn(r.hands[ME].score), board: h.board.map(cardCode).join(" "),
    }].slice(-4);
  }
  const gain = h.seats.includes(ME) ? m.players[ME].stack - h.start[ME] : null;
  S.history = [{ no: h.no, net: gain, log: S.log.slice() }, ...S.history].slice(0, 30);
}

const needsEndModal = () => (S.m.over && S.ended !== "over") || (S.m.players[ME].out && !S.ended);

function showEnd() {
  if (!S || !$("modal").hidden) return;
  if (S.m.over) S.ended = "over";
  else if (S.m.players[ME].out) S.ended = "bust";
  else return;
  save();
  controlsKey = "";
  render();
  openModal(endHtml(), "end");
}

// ===== 내 성향 기록 (Claude 프롬프트에 들어간다) =====
function trackHuman(h, type, L) {
  const st = S.stats, t = S.track;
  if (!st || !t) return;
  if (h.street === 0) {
    if (((type === "call" && L.toCall > 0) || type === "raise") && !t.vpip) { st.vpip++; t.vpip = true; }
    if (type === "raise" && !t.pfr) { st.pfr++; t.pfr = true; }
    return;
  }
  if (type === "raise") st.aggr++;
  else if (type === "call" && L.toCall > 0) st.calls++;
  if (L.toCall > 0) {
    st.facedBet++;
    if (type === "fold") st.foldedToBet++;
  }
}

// ===== AI =====
// GTO 엔진의 수를 실제로 둘 수 있는 수로 맞춘다
function engineMove(m, seat) {
  const L = PT.legal(m, seat);
  let d = null;
  try { d = PokerAI.decide(m, seat, { rng: Math.random }); } catch { d = null; }
  const c = d && normalize(d.action, d.to, L);
  if (c) return { ...c, d };
  // 엔진이 답하지 못하면: 공짜면 체크, 싸면 콜, 아니면 폴드
  const pot = PT.potTotal(m.hand);
  return { action: L.toCall === 0 ? "check" : L.toCall * 3 <= pot ? "call" : "fold", d };
}

function normalize(action, to, L) {
  action = String(action ?? "").toLowerCase().replace(/[^a-z]/g, "");
  to = Math.round(Number(to));
  if (action === "bet") action = "raise";
  if (action === "allin" || action === "shove") {
    if (L.canRaise) { action = "raise"; to = L.maxTo; } else action = L.toCall > 0 ? "call" : "check";
  }
  if ((action === "fold" || action === "call") && L.toCall === 0) action = "check";
  if (action === "check" && L.toCall > 0) return null;
  if (action === "raise") {
    if (!L.canRaise) action = L.toCall > 0 ? "call" : "check";
    else if (!Number.isFinite(to)) return null;
    else to = clamp(to, L.minTo, L.maxTo);
  }
  if (!["fold", "check", "call", "raise"].includes(action)) return null;
  return { action, to: action === "raise" ? to : undefined };
}

function mixText(d) {
  try { return PokerAI.describeMix(d); } catch { return ""; }
}

// ===== Claude 차례 =====
async function claudeTurn(h) {
  const m = S.m, seat = CLAUDE;
  if (thinking && thinking.hand === h) return;
  const L = PT.legal(m, seat);
  const eng = engineMove(m, seat);
  const ctl = new AbortController();
  const me = { hand: h, ctl, n: h.actions.length };
  thinking = me;
  S.say = null;
  render();
  let choice = null, note = "";
  try {
    const ask = sampleFn.json(buildPrompt(h, seat, L, eng), { modelTier: S.depth, cache: false, signal: ctl.signal });
    const reply = await untilAbort(ask, ctl.signal);
    choice = parseChoice(reply, L);
    if (!choice) note = "답을 읽지 못해 이번 수는 GTO 엔진이 뒀어요";
  } catch (e) {
    note = sampleErrorNote(e?.code);
  }
  const stale = me.stopped || thinking !== me;
  if (!stale) thinking = null;
  // 멈췄거나(설정 창 · 새 게임) 그 사이 새 핸드가 시작됐거나 차례가 바뀌었으면 버린다. 건너뛰기만 엔진 수로 둔다
  if (stale || !S || S.m !== m || m.hand !== h || h.phase !== "bet" || h.toAct !== seat || h.actions.length !== me.n) {
    if (S) render();
    return;
  }
  if (!choice) choice = { action: eng.action, to: eng.to, say: "" };
  S.say = { text: choice.say || "", note, at: Date.now() };
  renderTop();
  doAct(seat, choice.action, choice.to, choice.say);
}

// 건너뛰기를 누르면 답을 기다리지 않는다
function untilAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject({ code: "cancelled" });
    signal.addEventListener("abort", () => reject({ code: "cancelled" }), { once: true });
    promise.then(resolve, reject);
  });
}

function sampleErrorNote(code) {
  switch (code) {
    case "cancelled":
      return "건너뛰어서 이번 수는 GTO 엔진이 뒀어요";
    case "rate_limited":
      link = "paused";
      return "Claude 요청 한도에 걸렸어요. 잠시 뒤 위의 ‘다시 연결’을 눌러주세요";
    case "session_expired":
      link = "paused";
      return "다시 로그인해야 Claude가 둘 수 있어요";
    case "not_granted": case "sampling_disabled": case "not_declared": case "capability_disabled": case "capability_removed":
      link = "offline";
      return "Claude 사용이 허용되지 않아 GTO 엔진으로 바꿨어요";
    default:
      return "Claude 응답에 문제가 있어 이번 수는 GTO 엔진이 뒀어요";
  }
}

// Claude의 JSON 답을 실제로 둘 수 있는 수로 바꾼다. 못 읽으면 null
function parseChoice(r, L) {
  if (!r || typeof r !== "object") return null;
  const c = normalize(r.action, r.to ?? r.amount, L);
  if (!c) return null;
  const say = typeof r.say === "string" ? r.say.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  return { ...c, say };
}

const cardsEn = (cs) => cs.map(cardCode).join(" ");

function buildPrompt(h, seat, L, eng) {
  const m = S.m, P = m.players, pos = PT.positionsOf(h), st = S.stats, bb = h.bb;
  const pot = PT.potTotal(h), me = P[seat];
  const bbs = (x) => `${(x / bb).toFixed(1)} bb`;
  const who = (s) => (s === seat ? "You (Claude)" : s === YOU ? "Human" : `${P[s].name} (bot)`);
  const order = [];
  for (let s = PT.nextIn(h.seats, h.button), k = 0; k < h.seats.length; k++, s = PT.nextIn(h.seats, s)) order.push(s);
  const seats = order.map((s) => {
    const state = h.folded[s] ? "folded" : P[s].stack === 0 ? "all-in" : "in";
    return `- ${pos[s]}: ${who(s)} — ${P[s].stack} chips behind (${bbs(P[s].stack)}), bet this street ${h.bets[s]}, ${state}`;
  });
  const options = [];
  if (L.toCall > 0) options.push(`"fold"`, `"call" (costs ${L.toCall}${L.toCall >= me.stack ? ", all-in" : ""})`);
  else options.push(`"check"`);
  if (L.canRaise) {
    const top = L.maxTo === h.bets[seat] + me.stack ? "all-in" : "covers every opponent still in";
    options.push(`"raise" with "to" from ${L.minTo} to ${L.maxTo} (${L.maxTo} = ${top})${L.isBet ? "; on this street that is an opening bet" : ""}`);
  }
  const showdowns = st.showdowns.length
    ? ` Their recent showdown hands: ${st.showdowns.map((s) => `${s.cards} (${s.hand} on ${s.board})`).join("; ")}.`
    : " No showdowns yet.";
  const live = PT.liveSeats(m).length;
  const opponents = PT.aliveSeats(h).length - 1;
  return [
    `You are Claude, sitting at a ${m.players.length}-handed No-Limit Texas Hold'em tournament table (play chips) with the person viewing this page ("Human") and AI bot players. Play to win. You can see only your own hole cards.`,
    "",
    `Match: hand #${h.no}, blinds ${h.sb}/${h.bb}, blinds rise every ${HANDS_PER_LEVEL} hands; ${live} players left; the last player with chips wins.`,
    `Seats in this hand (clockwise from the seat left of the button; heads-up the button is the small blind):`,
    ...seats,
    `Your position: ${pos[seat]}. Your hole cards: ${cardsEn(h.hole[seat])}`,
    `Board: ${h.board.length ? cardsEn(h.board) : "none yet"} (street: ${STREET_EN[h.street]}); ${opponents} opponent${opponents === 1 ? "" : "s"} still in the hand.`,
    `Pot including bets on this street: ${pot} (${bbs(pot)})`,
    `To call: ${L.toCall}${L.toCall ? ` (pot odds ${Math.round((100 * L.toCall) / (pot + L.toCall))}%)` : ""}`,
    "",
    "Action so far this hand:",
    historyEn(h, seat, pos, who),
    "",
    `GTO engine advice for exactly this spot: ${mixText(eng.d) || `engine picks ${eng.action}${eng.to ? ` to ${eng.to}` : ""}`}`,
    "",
    `Human this match (${st.hands} hands dealt in): voluntarily puts money in preflop ${pct(st.vpip, st.hands)} (VPIP), raises preflop ${pct(st.pfr, st.hands)} (PFR); after the flop ${st.aggr} bets/raises vs ${st.calls} calls; folded to a bet or raise ${st.foldedToBet} of ${st.facedBet} times.${showdowns}`,
    "The bot players follow the GTO engine closely.",
    "",
    `Your legal actions now: ${options.join("; ")}.`,
    `"to" is your TOTAL bet on this street after raising, not the increment.`,
    "Default to the engine's mixed strategy: pick among its actions roughly in its frequencies and use its sizes. Deviate only when you have a concrete exploitative reason from the Human's tendencies or this hand's action (for example, they fold to bets far too often, or they almost never bluff).",
    "",
    'Reply with only a JSON object: {"action": "<fold|check|call|raise>", "to": <number, only for raise>, "say": "<table talk>"}.',
    '"say" is one short line you say at the table, in casual, friendly Korean (반말), at most 30 characters. It may tease or bluff lightly, but never state or hint your actual hole cards. Use "" when you have nothing to say.',
  ].join("\n");
}

function historyEn(h, seat, pos, who) {
  const verb = (a) => {
    const tail = a.allin ? " (all-in)" : "";
    switch (a.type) {
      case "sb": return `posts small blind ${a.amount}${tail}`;
      case "bb": return `posts big blind ${a.amount}${tail}`;
      case "fold": return "folds";
      case "check": return "checks";
      case "call": return `calls ${a.amount}${tail}`;
      case "bet": return `bets ${a.to}${tail}`;
      case "return": return `gets back uncalled ${a.amount}`;
      default: return `raises to ${a.to}${tail}`;
    }
  };
  const lines = [];
  for (let s = 0; s <= h.street; s++) {
    const acts = h.actions.filter((a) => a.street === s).map((a) => `${pos[a.seat]} ${who(a.seat)} ${verb(a)}`);
    const label = s === 0 ? "Preflop" : `${STREET_EN[s]} [${cardsEn(h.board.slice(0, s + 2))}]`;
    lines.push(`${label}: ${acts.join(", ") || "no action yet"}`);
  }
  return lines.join("\n");
}

// ===== 내 수 =====
function userAct(type, to) {
  const h = S?.m.hand;
  if (!h || h.phase !== "bet" || h.toAct !== ME) return;
  if (performance.now() - turnAt < INPUT_LOCK_MS) return; // 버튼이 방금 바뀌었다: 앞 수의 두 번째 클릭·키로 본다
  const L = PT.legal(S.m, ME);
  if (type === "fold" && L.toCall === 0) return;
  if (type === "raise" && !L.canRaise) return;
  if (type === "call" && L.toCall === 0) type = "check";
  if (mode === "guest") { guestSend(h, L, type, to); return; }
  doAct(ME, type, to);
}

function raiseAmount() {
  const v = Number($("amt")?.value);
  return Number.isFinite(v) ? v : 0;
}

// ===== 기록 =====
function addLog(html) {
  S.log.push(html);
}

function actionKo(a, short) {
  if (short && a.allin && a.type !== "fold") return "올인";
  const tail = a.allin ? " (올인)" : "";
  let s;
  switch (a.type) {
    case "fold": s = "폴드"; break;
    case "check": s = "체크"; break;
    case "call": s = `콜 ${fmt(a.amount)}${tail}`; break;
    case "bet": s = `벳 ${fmt(a.to)}${tail}`; break;
    default: s = `레이즈 → ${fmt(a.to)}${tail}`;
  }
  if (!short && a.timeout) s += " · 시간 초과";
  else if (!short && a.auto) s += " · AI가 대신";
  return s;
}

function cardsHtml(cs) {
  return cs.map((c) => `<span class="lc${isRed(c) ? " red" : ""}">${cardLabel(c)}</span>`).join(" ");
}

// 규칙 엔진의 행동 목록을 따라가며 아직 옮기지 않은 줄을 기록에 더한다 (손님도 받은 화면으로 같은 기록을 만든다)
function syncLog() {
  const h = S.m.hand, at = S.logAt;
  const streetLine = (to) => {
    while (at.street < to) {
      at.street++;
      addLog(`<span class="street-line"><span class="street">${STREET_KO[at.street]}</span> ${cardsHtml(h.board.slice(0, at.street + 2))}</span>`);
    }
  };
  while (at.a < h.actions.length) {
    const a = h.actions[at.a++];
    streetLine(a.street);
    const who = `<b>${esc(nm(a.seat))}</b>`;
    if (a.type === "sb" || a.type === "bb") addLog(`${who} ${a.type === "sb" ? "스몰" : "빅"} 블라인드 ${fmt(a.amount)}${a.allin ? " (올인)" : ""}`);
    else if (a.type === "return") addLog(`${who} 받지 않은 ${fmt(a.amount)} 돌려받음`);
    else addLog(`${who} ${actionKo(a)}`);
  }
  if (h.phase === "runout" && !at.shown) {
    at.shown = true;
    const shown = h.seats.filter((s) => h.shown[s] && h.hole[s]?.[0] != null).map((s) => `${esc(nm(s))} ${cardsHtml(h.hole[s])}`);
    addLog(`올인 — 카드 공개: ${shown.join(" · ")}`);
  }
  streetLine(h.street);
  if (h.phase === "done" && !at.done) {
    at.done = true;
    const r = h.result;
    if (r.showdown) {
      for (const s of h.seats) {
        const hand = r.hands[s];
        if (hand && h.hole[s]?.[0] != null) addLog(`${esc(nm(s))} ${cardsHtml(h.hole[s])} — ${esc(hand.label)}`);
      }
    }
    r.pots.forEach((p, i) => {
      const title = r.pots.length === 1 ? "팟" : i === 0 ? "메인 팟" : `사이드 팟 ${i}`;
      const names = p.winners.map((s) => `<b>${esc(nm(s))}</b>`).join("·");
      addLog(`${names} ${title} ${fmt(p.amount)} ${p.winners.length > 1 ? "나눔" : "획득"}`);
    });
  }
}

// ===== 저장 =====
function save() {
  if (mode === "solo") { try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch {} }
  else if (mode === "host") saveRoom();
}

function load() {
  try {
    const g = JSON.parse(localStorage.getItem(SAVE_KEY));
    const m = g?.m;
    // 끝난 매치는 최종 결과 창을 아직 못 봤을 때만 되살린다
    if (!g || g.v !== 2 || !m || m.v !== 2 || !Array.isArray(m.players) || !m.hand || (m.over && g.ended === "over")) return null;
    if (m.players.length < 2 || m.players.length > 6 || !g.stats || !Array.isArray(g.history) || !Array.isArray(g.log) || !g.logAt) return null;
    return g;
  } catch {
    return null;
  }
}

// ===== 화면 =====
function render() {
  if (!S || !S.m?.hand) return;
  buildTable(S.m.players.length);
  renderTop();
  renderSeats();
  renderCenter();
  renderBubble();
  renderControls();
  renderLog();
  renderClocks();
}

function renderTop() {
  const dot = $("link-dot");
  if (!dot) return;
  if (mode !== "solo") { renderTopNet(); return; }
  document.querySelector(".brand span").textContent = "vs Claude";
  $("new-game").textContent = "새 게임";
  const on = !S || S.claudeOn;
  const state = link === "live" && !on ? "engine" : link;
  dot.className = "dot " + state;
  $("link-text").textContent = {
    checking: "Claude 연결 확인 중",
    live: "Claude가 직접 둡니다",
    paused: "Claude 쉬는 중 · 엔진이 대신",
    offline: "Claude 자리: GTO 엔진",
    engine: "Claude 자리: GTO 엔진",
  }[state];
  $("link-short").textContent = { checking: "확인 중", live: "Claude", paused: "쉬는 중", offline: "엔진", engine: "엔진" }[state];
  $("link").title = link === "offline"
    ? "이 화면에서는 Claude를 부를 수 없어서 Claude 자리도 GTO 엔진이 둡니다. claude.ai 아티팩트로 열면 Claude가 직접 둬요."
    : !on ? "새 게임 설정에서 ‘Claude 직접 판단’을 끄면 Claude 자리도 GTO 엔진이 둡니다."
    : "Claude는 GTO 엔진의 조언과 공개된 정보, 자기 카드만 보고 판단합니다. 다른 사람 카드는 보지 못해요. 내가 핸드에서 빠지면 엔진이 대신 둡니다.";
  const seg = $("depth");
  seg.hidden = !(link === "live" && on);
  $("retry").hidden = link !== "paused";
  for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.depth === (S?.depth ?? "quick")));
  renderLevel();
}

function renderLevel() {
  const lv = $("level");
  if (!S || !S.m?.hand) {
    lv.innerHTML = mode === "solo" ? `블라인드 <b>10/20</b> · <span>${setup.n}명</span>` : `블라인드 <b>10/20</b>`;
    return;
  }
  const m = S.m, h = m.hand, per = m.handsPerLevel || HANDS_PER_LEVEL, left = per - ((m.handNo - 1) % per);
  const [nsb, nbb] = PT.blindsAt(m, m.handNo + left);
  lv.innerHTML = `핸드 <b>#${m.handNo}</b> · 블라인드 <b>${h.sb}/${h.bb}</b>` +
    (nbb !== h.bb ? ` · <span>${left}핸드 뒤 ${nsb}/${nbb}</span>` : "") +
    ` · <em>${PT.liveSeats(m).length}/${m.players.length}명 남음</em>`;
}

// 친구와 하기: 위 막대에 방 코드와 연결 상태
function renderTopNet() {
  document.querySelector(".brand span").textContent = "친구와 하기";
  $("new-game").textContent = "나가기";
  $("depth").hidden = true;
  $("retry").hidden = true;
  let state, text, title, short;
  const code = (mode === "host" ? room?.code : guest?.code) || "·····";
  if (mode === "host") {
    const total = room.guests.length, on = room.guests.filter((g) => g.connected).length;
    state = !room.ready ? "checking" : room.status === "offline" ? "paused" : "live";
    text = !room.ready ? `방 ${code} 여는 중` : `방 ${code} · 친구 ${on}/${total}명 연결` + (room.status === "offline" ? " · 서버 다시 연결 중" : "");
    short = !room.ready ? "여는 중" : room.status === "offline" ? "다시 연결 중" : code; // 폰은 짧은 글자만 보인다
    title = "내 기기가 딜러예요. 게임이 끝날 때까지 이 화면을 켜 두세요." + (room.status === "offline" ? " 서버와 잠깐 끊겼어요(들어와 있는 친구와는 계속 연결돼요). 다시 연결하는 중이에요." : "");
  } else {
    const st = guest.status;
    state = st === "open" ? "live" : st === "reconnecting" ? "paused" : "checking";
    text = st === "open" ? `방 ${code} · 연결됨` : st === "reconnecting" ? `방 ${code} · 다시 연결 중…` : st === "closed" ? `방 ${code} · 끊김` : `방 ${code} · 연결 중…`;
    short = st === "open" ? code : st === "reconnecting" ? "다시 연결 중" : st === "closed" ? "끊김" : "연결 중";
    title = "방장 기기가 딜러예요. 연결이 끊기면 내 자리는 AI가 대신 두고, 다시 연결되면 돌려받아요.";
  }
  $("link-dot").className = "dot " + state;
  $("link-text").textContent = text;
  $("link-short").textContent = short;
  $("link").title = title;
  renderLevel();
}

// 자리에 보일 이름 · 머리글자 · 색
function seatLook(s) {
  const r = ROSTER[s];
  if (mode === "solo" || !S?.m) return r;
  const name = S.m.players[s].name;
  return { name, initial: name === r.name ? r.initial : Array.from(name)[0] || "?", color: r.color };
}

// 친구와 하기: 그 자리가 연결돼 있는지 (AI 자리는 늘 true)
function seatOnline(s) {
  if (mode === "host") {
    const p = S.m.players[s];
    if (p.kind !== "remote") return true;
    const g = PokerNet.roomGuestAt(room, s);
    return !!g && g.connected;
  }
  if (mode === "guest") return S.m.players[s].connected !== false;
  return true;
}

// 인원 · 화면 모양 · 내 자리가 바뀔 때만 자리를 새로 만든다
function buildTable(n) {
  const shape = tallMQ.matches ? "tall" : "wide";
  const names = S?.m ? S.m.players.map((p) => p.name).join("|") : "";
  const key = `${n}|${shape}|${mode}|${ME}|${names}`;
  if (key === tableKey) return;
  tableKey = key;
  const lay = LAYOUT[shape][n], me = mode === "solo" ? YOU : ME;
  let html = "";
  for (let s = 0; s < n; s++) {
    const d = (s - me + n) % n; // 화면 위치: 나는 늘 아래 가운데
    const r = seatLook(s), [x, y] = lay.seat[d], [bx, by] = lay.bet[d];
    const claudeSeat = mode === "solo" && s === CLAUDE;
    const cls = ["seat", s === me ? "me" : "", claudeSeat ? "claude" : "", y < 45 ? "below" : "", x < 30 ? "west" : x > 70 ? "east" : ""].filter(Boolean).join(" ");
    html += `
      <div class="${cls}" id="seat-${s}" style="left:${x}%;top:${y}%">
        <div class="hole" id="hole-${s}"></div>
        <div class="plate">
          <span class="avatar" style="--av:${r.color}" aria-hidden="true">${esc(r.initial)}</span>
          <span class="who"><span class="nm"><b title="${esc(r.name)}">${esc(r.name)}</b><i class="pos" id="pos-${s}"></i></span><span class="stack" id="stack-${s}">${fmt(START_STACK)}</span><span class="away-note" id="away-${s}" hidden><span class="al">연결 끊김 · AI가 대신</span><span class="as">끊김 · AI</span></span></span>
          <span class="dealer" id="dealer-${s}" hidden>D</span>
          <span class="clock" id="clock-${s}" hidden></span>
        </div>
        ${s === me ? `<span class="made" id="made"></span>` : ""}
        ${claudeSeat ? `<div class="bubble${lay.bubble ? ` ${lay.bubble}` : x > 60 ? " to-left" : ""}" id="bubble" aria-live="polite"></div>` : ""}
      </div>
      <div class="bet${y < 45 ? " up" : ""}" id="bet-${s}" style="left:${bx}%;top:${by}%"></div>`;
  }
  $("seats").innerHTML = html;
  const t = $("table");
  t.dataset.n = n;
  t.dataset.mode = shape;
  controlsKey = "";
}

// 설정 창 뒤에 보이는 빈 테이블
function renderPreview(n) {
  tableKey = "";
  buildTable(n);
  $("print").textContent = printLabel(n);
  renderCards($("board"), ["slot", "slot", "slot", "slot", "slot"], () => "");
  $("pot").innerHTML = "";
  $("sidepots").textContent = "";
  renderTop();
}

const printLabel = (n) => `No Limit · ${n === 2 ? "Heads-Up" : `${n}-Handed`}`;

// 쇼다운에서 팟을 가져간 사람들의 최고 다섯 장
function winningCards(h) {
  const set = new Set();
  if (h.phase !== "done" || !h.result?.showdown) return set;
  for (const p of h.result.pots) for (const w of p.winners) for (const c of h.result.hands[w]?.best ?? []) set.add(c);
  return set;
}

function renderSeats() {
  const m = S.m, h = m.hand, pos = PT.positionsOf(h), done = h.phase === "done";
  const best = winningCards(h), sd = done && h.result.showdown;
  m.players.forEach((p, s) => {
    const el = $(`seat-${s}`);
    if (!el) return;
    const inHand = h.seats.includes(s), folded = inHand && h.folded[s], online = seatOnline(s);
    el.classList.toggle("turn", h.phase === "bet" && h.toAct === s);
    el.classList.toggle("folded", folded);
    el.classList.toggle("out", p.out && !inHand);
    el.classList.toggle("busted", p.out);
    el.classList.toggle("thinking", !!(thinking && thinking.hand === h && s === CLAUDE));
    el.classList.toggle("winner", done && h.result.won[s] > 0);
    el.classList.toggle("away", !online && !p.out);
    $(`away-${s}`).hidden = online || p.out;
    $(`stack-${s}`).textContent = p.out && (done || !inHand) ? "탈락"
      : inHand && !folded && p.stack === 0 && !done ? "올인" : fmt(p.stack);
    $(`pos-${s}`).textContent = inHand ? pos[s] ?? "" : "";
    $(`dealer-${s}`).hidden = h.button !== s;
    let cards = [];
    if (inHand && (!folded || s === ME) && h.hole[s]) cards = h.hole[s].map((c) => (c !== null && (s === ME || h.shown[s]) ? c : "back"));
    renderCards($(`hole-${s}`), cards, (c) => (c === "back" ? "" : folded ? "dim" : sd && h.shown[s] ? (best.has(c) ? "win" : "dim") : ""));
    renderBet(s, h, inHand);
  });
  // 지금 내 패 이름 (보드가 깔린 뒤)
  const made = $("made");
  if (made) {
    const mine = h.seats.includes(ME) && !h.folded[ME] && h.board.length >= 3 && h.phase !== "done" && h.hole[ME]?.[0] != null; // 끝나면 베팅 자리에 족보가 뜬다
    made.textContent = mine ? describe(evaluate([...h.hole[ME], ...h.board])) : "";
  }
}

// 자리 앞 베팅 칩 · 행동 표시 (끝나면 족보 · 딴 칩)
function renderBet(s, h, inHand) {
  const el = $(`bet-${s}`);
  if (!el) return;
  let html = "";
  if (inHand && h.phase === "done") {
    const r = h.result, hand = r.hands[s], won = r.won[s];
    // 폰에서는 짧은 족보 이름만 (전체 이름은 결과 · 기록에)
    if (hand) html += `<span class="tag lbl${won ? " win" : ""}"><span class="lf">${esc(hand.label)}</span><span class="ls">${esc(CAT_KO[categoryOf(hand.score)])}</span></span>`;
    if (won > 0) html += `<span class="amt win"><i class="chip"></i>+${fmt(won)}</span>`;
  } else if (inHand) {
    let last = null;
    for (let i = h.actions.length - 1; i >= 0; i--) {
      const a = h.actions[i];
      if (a.street !== h.street) break;
      if (a.seat === s && a.type !== "sb" && a.type !== "bb" && a.type !== "return") { last = a; break; }
    }
    if (last && h.phase === "bet") html += `<span class="tag${last.allin ? " allin" : last.type === "fold" ? " fold" : ""}">${actionKo(last, true)}</span>`;
    if (h.bets[s] > 0) html += `<span class="amt"><i class="chip"></i>${fmt(h.bets[s])}</span>`;
  }
  if (el.dataset.h !== html) {
    el.dataset.h = html;
    el.innerHTML = html;
  }
  el.classList.toggle("fin", h.phase === "done");
}

function renderCenter() {
  const h = S.m.hand, best = winningCards(h), sd = h.phase === "done" && h.result.showdown;
  const slots = h.board.slice();
  while (slots.length < 5) slots.push("slot");
  renderCards($("board"), slots, (c) => (c !== "slot" && sd ? (best.has(c) ? "win" : "dim") : ""));
  $("pot").innerHTML = h.phase === "done" ? "" : `<i class="chip"></i>팟 <b>${fmt(PT.potTotal(h))}</b>`;
  // 올인한 사람이 있을 때만 사이드 팟을 나눠 보여준다
  const allin = h.phase !== "done" && PT.aliveSeats(h).some((s) => S.m.players[s].stack === 0);
  const pots = allin ? PT.buildPots(h) : [];
  $("sidepots").textContent = pots.length > 1
    ? pots.map((p, i) => `${i === 0 ? "메인" : `사이드 ${i}`} ${fmt(p.amount)}`).join(" · ")
    : "";
  $("print").textContent = printLabel(h.seats.length);
}

function renderBubble() {
  const b = $("bubble");
  if (!b) return;
  const h = S.m.hand;
  if (thinking && thinking.hand === h) {
    if (b.dataset.k !== "thinking") {
      b.dataset.k = "thinking";
      b.innerHTML = `<span class="dots">생각 중</span> <button id="skip" class="link-btn" type="button">건너뛰기</button>`;
    }
    b.classList.add("on");
    return;
  }
  // 말은 몇 초 보여주고 사라진다 (기록에는 남는다). 안내 문구는 조금 더 길게
  const life = S.say?.note ? 9000 : 6000;
  const age = S.say ? Date.now() - (S.say.at || 0) : Infinity;
  const say = age < life ? S.say : null, k = say ? `${say.text}|${say.note}|${say.at}` : "";
  clearTimeout(sayTimer);
  if (say) sayTimer = setTimeout(() => { if (S) renderBubble(); }, life - age + 50);
  b.classList.toggle("on", !!(say && (say.text || say.note)));
  if (b.dataset.k !== k) {
    b.dataset.k = k;
    b.textContent = "";
    if (say?.text) b.append(say.text);
    if (say?.note) {
      const small = document.createElement("small");
      small.textContent = say.note;
      b.append(small);
    }
  }
}

// 카드 목록을 그린다. 이미 같은 카드가 있으면 그대로 두고 새 카드만 애니메이션
function renderCards(el, list, extraClass) {
  list.forEach((c, i) => {
    const key = String(c);
    let node = el.children[i];
    if (!node || node.dataset.k !== key) {
      const fresh = cardNode(c);
      if (c !== "slot") fresh.classList.add(node?.dataset.k === "back" && c !== "back" ? "flip" : "deal");
      if (node) el.replaceChild(fresh, node);
      else el.appendChild(fresh);
      node = fresh;
    }
    node.classList.remove("win", "dim");
    const x = extraClass(c);
    if (x) node.classList.add(x);
  });
  while (el.children.length > list.length) el.lastChild.remove();
}

function cardNode(c) {
  const d = document.createElement("div");
  d.dataset.k = String(c);
  if (c === "slot") d.className = "card slot";
  else if (c === "back") d.className = "card back";
  else {
    d.className = "card" + (isRed(c) ? " red" : "");
    const rank = RANK_LABEL[rankOf(c)], suit = SUIT_SYMBOL[suitOf(c)];
    d.setAttribute("aria-label", cardLabel(c));
    d.innerHTML = `<span class="idx${rank === "10" ? " ten" : ""}">${rank}<i>${suit}</i></span><span class="pip">${suit}</span>`;
  }
  return d;
}

// ===== 조작판 =====
function renderControls() {
  const m = S.m, h = m.hand, box = $("controls");
  const online = h.toAct >= 0 ? seatOnline(h.toAct) : true;
  const down = mode === "guest" && guest.status !== "open"; // 손님: 방장과 끊긴 동안 받은 화면은 멈춰 있다 — 버튼 · 시계를 감춘다
  const key = [h.no, h.actions.length, h.phase, h.toAct, h.street, m.over, !!thinking, fast, hintOn, S.ended, m.players[ME].out, mode, ME, guest?.pending ? 1 : 0, online, guest?.status, turnLeft() ? 1 : 0].join("|");
  if (key === controlsKey) return;
  controlsKey = key;
  box.classList.toggle("mine", h.phase === "bet" && h.toAct === ME && !down);
  if (down) box.innerHTML = `<div class="waiting"><span>${guest.status === "closed" ? "방장과 연결이 끊겼어요" : "방장과 다시 연결하는 중… 잠시만 기다려 주세요"}</span></div>`;
  else if (h.phase === "done") box.innerHTML = doneHtml(h);
  else if (h.phase === "bet" && h.toAct === ME) {
    const tk = `${m.handNo}|${h.actions.length}`;
    if (tk !== turnKey) { turnKey = tk; turnAt = performance.now(); }
    const L = PT.legal(m, ME);
    box.innerHTML = myTurnHtml(h, L);
    syncRaiseLabel(L);
  } else box.innerHTML = waitHtml(h);
}

function waitHtml(h) {
  const m = S.m, out = !h.seats.includes(ME) || h.folded[ME] || m.players[ME].stack === 0;
  let msg;
  if (h.phase === "runout") msg = "남은 카드를 펼치는 중…";
  else if (thinking && thinking.hand === h) msg = "Claude가 생각 중…";
  else if (mode !== "solo" && !seatOnline(h.toAct)) {
    msg = turnLeft() ? `${esc(nm(h.toAct))} 연결 끊김 · 돌아오길 기다리는 중 <span class="wait-clock" id="wait-clock"></span>` // 잠깐 끊긴 사람: 시계가 도는 동안은 기다린다
      : `${esc(nm(h.toAct))} 연결 끊김 · AI가 대신 둡니다`;
  }
  else msg = `${esc(nm(h.toAct))} 차례예요${mode !== "solo" ? ` <span class="wait-clock" id="wait-clock"></span>` : ""}`;
  if (m.players[ME].out) msg = `관전 중 · ${msg}`;
  const ff = out && mode === "solo"
    ? `<button class="btn ff${fast ? " on" : ""}" id="fast" type="button" aria-pressed="${fast}">${fast ? "빨리 감는 중" : "빨리 감기"} <span aria-hidden="true">»</span></button>`
    : "";
  return `<div class="waiting"><span>${msg}</span>${ff}</div>`;
}

function myTurnHtml(h, L) {
  const m = S.m, me = m.players[ME], pot = PT.potTotal(h), pos = PT.positionsOf(h)[ME];
  const lock = mode === "guest" && !!guest.pending ? " disabled" : ""; // 보낸 수의 답(새 화면)이 올 때까지
  const callLabel = L.toCall === 0 ? "체크" : `콜 ${fmt(L.toCall)}${L.toCall >= me.stack ? " (올인)" : ""}`;
  const presets = [];
  if (L.canRaise) {
    if (h.street === 0 && L.maxBet <= h.bb) {
      for (const x of [2.5, 3, 4]) presets.push([`${x}BB`, h.bb * x]);
    } else {
      for (const [name, f] of [["½팟", 0.5], ["¾팟", 0.75], ["팟", 1]]) presets.push([name, L.maxBet + (pot + L.toCall) * f]);
    }
    presets.push(["올인", L.maxTo]);
  }
  const seen = new Set();
  const chips = presets
    .map(([name, v]) => [name, clamp(Math.round(v / h.sb) * h.sb, L.minTo, L.maxTo)])
    .filter(([name, v]) => (name === "올인" || v < L.maxTo) && !seen.has(v) && seen.add(v))
    .map(([name, v]) => `<button class="preset" type="button" data-to="${v}">${name}</button>`)
    .join("");
  const startTo = h.street === 0 && L.maxBet <= h.bb ? h.bb * 2.5 : L.isBet ? pot * 0.5 : L.maxBet + (pot + L.toCall) * 0.75;
  const start = L.canRaise ? clamp(Math.round(startTo / h.sb) * h.sb, L.minTo, L.maxTo) : 0;
  const onlyAllIn = L.canRaise && L.minTo === L.maxTo;
  const odds = L.toCall ? ` · 팟 오즈 ${Math.round((100 * L.toCall) / (pot + L.toCall))}%` : "";
  const head = lock ? `<b>보내는 중…</b>` : `<b>내 차례</b>`;
  return `
    <div class="ctl-head">
      <span class="ctl-info">${head} · ${pos} · 팟 ${fmt(pot)}${odds}${mode !== "solo" ? ` <span class="my-clock" id="my-clock"></span>` : ""}</span>
      <button class="toggle" id="hint-toggle" type="button" aria-pressed="${hintOn}"><i aria-hidden="true"></i>GTO 힌트</button>
    </div>
    ${hintOn ? hintHtml(h, L) : ""}
    <div class="actions">
      <button class="btn fold" id="b-fold" type="button" ${L.toCall === 0 || lock ? "disabled" : ""}>폴드 <kbd>F</kbd></button>
      <button class="btn call" id="b-call" type="button"${lock}>${callLabel} <kbd>C</kbd></button>
      <button class="btn raise" id="b-raise" type="button" ${L.canRaise && !lock ? "" : "disabled"}></button>
    </div>
    ${L.canRaise && !onlyAllIn ? `
    <div class="sizer">
      <div class="presets">${chips}</div>
      <input type="range" id="slider" min="${L.minTo}" max="${L.maxTo}" step="${h.sb}" value="${start}" aria-label="레이즈 금액">
      <input type="number" id="amt" min="${L.minTo}" max="${L.maxTo}" step="${h.sb}" value="${start}" inputmode="numeric" aria-label="레이즈 금액 직접 입력">
    </div>` : `<input type="hidden" id="amt" value="${L.maxTo}">`}`;
}

// 내 자리에서 GTO 엔진이 고르는 비율 (내 카드는 내 정보이므로 써도 된다. 손님은 받은 화면으로 계산)
function hintHtml(h, L) {
  const key = `${S.m.handNo}|${h.actions.length}|${ME}`;
  if (hint.key !== key) {
    let d = null;
    try { d = PokerAI.decide(S.m, ME, { rng: Math.random }); } catch { d = null; }
    hint = { key, d };
  }
  const d = hint.d;
  if (!d || !Array.isArray(d.mix) || !d.mix.length) return `<div class="hint"><span class="hint-note">GTO 엔진이 이 자리를 계산하지 못했어요</span></div>`;
  const items = d.mix.filter((x) => x.freq >= 0.005).map((x) => {
    const c = normalize(x.action, x.to, L) ?? { action: x.action };
    let kind = c.action, label;
    if (c.action === "raise") {
      const sized = Number.isFinite(c.to);
      kind = sized && c.to >= L.maxTo ? "allin" : "raise";
      label = kind === "allin" ? "올인" : `${L.isBet ? "벳" : "레이즈"}${sized ? ` ${fmt(c.to)}` : ""}`;
    } else label = { fold: "폴드", check: "체크", call: "콜" }[c.action] ?? c.action;
    return { kind, label, freq: x.freq };
  });
  const eq = Number(d.info?.equity);
  return `
    <div class="hint" aria-label="GTO 엔진 추천 비율">
      <div class="hint-bar">${items.map((i) => `<i class="k-${i.kind}" style="flex-grow:${i.freq.toFixed(3)}"></i>`).join("")}</div>
      <div class="hint-legend">${items.map((i) => `<span><i class="sw k-${i.kind}"></i>${esc(i.label)} <b>${Math.round(i.freq * 100)}%</b></span>`).join("")}${Number.isFinite(eq) ? `<span class="hint-eq">추정 승률 ${Math.round(eq * 100)}%</span>` : ""}</div>
    </div>`;
}

function doneHtml(h) {
  const m = S.m, r = h.result;
  const rows = r.pots.map((p, i) => {
    const title = r.pots.length === 1 ? "팟" : i === 0 ? "메인 팟" : `사이드 팟 ${i}`;
    const names = p.winners.map((s) => esc(nm(s))).join("·") + (p.winners.length > 1 ? " 나눔" : "");
    const how = r.showdown ? esc(r.hands[p.winners[0]]?.label ?? "") : "모두 폴드";
    return `<li><span class="r-pot">${title} <b>${fmt(p.amount)}</b></span><span class="r-win">${names} <small>${how}</small></span></li>`;
  }).join("");
  let gain;
  if (!h.seats.includes(ME)) gain = `<div class="net">관전</div>`;
  else {
    const v = m.players[ME].stack - h.start[ME];
    gain = `<div class="net ${v > 0 ? "up" : v < 0 ? "down" : ""}">내 손익 <b>${v > 0 ? "+" : ""}${fmt(v)}</b></div>`;
  }
  let btn;
  if (m.over) btn = `<button class="btn primary" id="show-end" type="button">최종 결과 보기 <kbd>Enter</kbd></button>`;
  else if (m.players[ME].out && !S.ended) btn = `<button class="btn primary" id="show-end" type="button">결과 보기 <kbd>Enter</kbd></button>`;
  else if (mode === "guest") btn = `<div class="next-wait" id="next-clock" aria-live="off">다음 핸드를 기다리는 중</div>`; // 다음 핸드는 방장이 연다
  else if (mode === "host") btn = `<button class="btn primary" id="next" type="button">다음 핸드<span class="next-in" id="next-clock"></span> <kbd>Enter</kbd></button>`;
  else btn = `<button class="btn primary" id="next" type="button">다음 핸드 <kbd>Enter</kbd></button>`;
  return `
    <div class="done">
      <ul class="result" aria-live="polite">${rows}</ul>
      ${gain}
      ${btn}
    </div>`;
}

function syncRaiseLabel(L) {
  const btn = $("b-raise");
  if (!btn) return;
  if (!L.canRaise) { btn.innerHTML = "레이즈"; return; }
  const to = clamp(raiseAmount(), L.minTo, L.maxTo);
  const allin = to === L.maxTo;
  btn.innerHTML = `${allin ? "올인" : L.isBet ? "벳" : "레이즈"} ${fmt(to)} <kbd>R</kbd>`;
}

function renderLog() {
  const h = S.m.hand;
  const key = `${S.m.handNo}|${h.phase === "done"}|${S.log.length}|${S.history.length}`;
  if (key === logKey) return;
  logKey = key;
  const current = h.phase === "done" ? [] : [{ no: h.no, net: undefined, log: S.log }];
  const items = [...current, ...S.history].slice(0, 30);
  $("log").innerHTML = items.map((it, i) => {
    const net = it.net === undefined ? `<span class="live">진행 중</span>`
      : it.net === null ? `<span>관전</span>`
      : `<span class="${it.net > 0 ? "up" : it.net < 0 ? "down" : ""}">${it.net > 0 ? "+" : ""}${fmt(it.net)}</span>`;
    return `<li><details${i === 0 ? " open" : ""}><summary>핸드 #${it.no}${net}</summary><ul>${it.log.map((l) => `<li>${l}</li>`).join("")}</ul></details></li>`;
  }).join("");
}

// ===== 시계 (친구와 하기: 차례 제한 시간 · 다음 핸드) =====
// 방장은 자기 시계로, 손님은 받은 '남은 시간'과 받은 때로 센다 (기기마다 시계가 달라서)
// 손님은 방장과 끊긴 동안 null (받은 남은 시간이 더는 맞지 않다)
function turnLeft() {
  if (mode === "host" && S?.turn) return { seat: S.turn.seat, left: Math.max(0, S.turn.deadline - Date.now()), total: TURN_MS };
  const v = guest?.view;
  if (mode === "guest" && v?.turn && guest.status === "open") return { seat: v.turn.seat, left: Math.max(0, guest.at + v.turn.left - performance.now()), total: v.turn.total };
  return null;
}
function nextLeft() {
  if (mode === "host") return S?.nextAt ? Math.max(0, S.nextAt - Date.now()) : null;
  const v = guest?.view;
  return mode === "guest" && v && v.next !== null && guest.status === "open" ? Math.max(0, guest.at + v.next - performance.now()) : null;
}

function renderClocks() {
  if (mode === "solo" || !S?.m?.hand) return;
  const h = S.m.hand, t = h.phase === "bet" ? turnLeft() : null;
  const sec = (ms) => Math.ceil(ms / 1000);
  S.m.players.forEach((_, s) => {
    const el = $(`clock-${s}`);
    if (!el) return;
    const on = !!t && t.seat === s && h.toAct === s;
    el.hidden = !on;
    if (on) {
      el.textContent = sec(t.left);
      el.classList.toggle("urgent", t.left <= 10000);
    }
  });
  for (const id of ["my-clock", "wait-clock"]) {
    const el = $(id);
    if (!el) continue;
    const on = !!t && t.seat === h.toAct;
    el.textContent = on ? `${sec(t.left)}초` : "";
    el.classList.toggle("urgent", on && t.left <= 10000);
  }
  const nx = $("next-clock");
  if (nx && h.phase === "done") {
    const left = nextLeft();
    if (mode === "guest") nx.textContent = left === null ? "다음 핸드를 기다리는 중" : `다음 핸드 ${sec(left)}초 뒤`;
    else nx.textContent = left === null ? "" : ` · ${sec(left)}초`;
  }
}

function startTicker() {
  clearInterval(tickTimer);
  tickTimer = setInterval(renderClocks, 250);
}

// ===== 창 =====
function openModal(html, screen = "") {
  modalScreen = screen;
  $("modal-card").innerHTML = html;
  $("modal").hidden = false;
  const card = $("modal-card");
  (card.querySelector(".btn.primary:not(:disabled)") || card.querySelector("button:not(:disabled)"))?.focus();
}
// 같은 창이 열려 있으면 내용만 바꾼다 (포커스·입력값 유지), 아니면 새로 연다
function showScreen(screen, html) {
  if (modalScreen !== screen || $("modal").hidden) { openModal(html, screen); return; }
  const focused = document.activeElement?.id;
  $("modal-card").innerHTML = html;
  if (focused) $(focused)?.focus();
}
const closeModal = () => {
  $("modal").hidden = true;
  modalScreen = "";
  turnAt = performance.now(); // 창 버튼을 두 번 눌러도 뒤의 내 차례 버튼이 눌리지 않게
};

function setupHtml(resume) {
  const tabs = `
    <div class="seg tabs" role="group" aria-label="게임 방식">
      <button type="button" id="tab-solo" aria-pressed="${setup.tab !== "mp"}">혼자 하기</button>
      <button type="button" id="tab-mp" aria-pressed="${setup.tab === "mp"}">친구와 하기</button>
    </div>`;
  return tabs + (setup.tab === "mp" ? netMenuHtml() : soloSetupHtml(resume));
}

function soloSetupHtml(resume) {
  const n = setup.n;
  const counts = [2, 3, 4, 5, 6].map((k) =>
    `<button type="button" data-count="${k}" aria-pressed="${k === n}">${k}명</button>`).join("");
  const lineup = ROSTER.map((r, s) =>
    `<li class="${s < n ? "" : "off"}"><span class="avatar" style="--av:${r.color}" aria-hidden="true">${r.initial}</span>${esc(r.name)}</li>`).join("");
  const saved = resume && S && !S.m.over;
  return `
    <p class="eyebrow">노리밋 텍사스 홀덤 · 토너먼트</p>
    <h1>Claude와 한 테이블</h1>
    <div class="field">
      <span class="field-label" id="count-label">인원</span>
      <div class="seg count" role="group" aria-labelledby="count-label">${counts}</div>
    </div>
    <ul class="lineup">${lineup}</ul>
    <dl class="rules">
      <div><dt>시작 칩</dt><dd>각자 ${fmt(START_STACK)} (100BB)</dd></div>
      <div><dt>블라인드</dt><dd>10/20부터 ${HANDS_PER_LEVEL}핸드마다 오름</dd></div>
      <div><dt>끝</dt><dd>한 명 남을 때까지</dd></div>
    </dl>
    <label class="check">
      <input type="checkbox" id="m-claude" ${setup.claude ? "checked" : ""}>
      <span><b>Claude 직접 판단</b><small>Claude 자리는 GTO 엔진의 조언을 받아 Claude가 직접 둡니다. 내가 핸드에 남아 있을 때만 Claude를 부르고, 그때마다 Claude 사용량이 조금 쓰여요.</small></span>
    </label>
    <p class="fine">다른 AI 플레이어와, Claude를 부를 수 없을 때의 Claude 자리는 GTO 엔진이 둡니다. 모두 자기 카드와 공개된 정보만 보고 판단해요.</p>
    <div class="modal-actions">
      ${saved ? `<button class="btn primary" id="m-resume" type="button">이어하기 · 핸드 #${S.m.handNo}</button><button class="btn" id="m-start" type="button">${n}명으로 새 게임</button>`
              : `<button class="btn primary" id="m-start" type="button">${n}명으로 시작</button>`}
      ${S && !resume ? `<button class="btn" id="m-cancel" type="button">취소</button>` : ""}
    </div>`;
}

function standingsHtml() {
  // 아직 남은 사람(칩 순) → 순위가 정해진 사람(순위 순)
  const rows = S.m.players.map((p, s) => ({ s, p }));
  const alive = rows.filter((r) => !r.p.place).sort((a, b) => b.p.stack - a.p.stack);
  const placed = rows.filter((r) => r.p.place).sort((a, b) => a.p.place - b.p.place);
  return `<ol class="standings">${[...alive, ...placed].map(({ s, p }) => {
    const r = seatLook(s);
    return `<li class="${s === ME ? "me" : ""}"><span class="avatar" style="--av:${r.color}" aria-hidden="true">${esc(r.initial)}</span><b>${esc(nm(s))}</b><span>${p.place ? `${p.place}위` : `${fmt(p.stack)} 칩`}</span></li>`;
  }).join("")}</ol>`;
}

function endHtml() {
  const m = S.m, n = m.players.length, me = m.players[ME], st = S.stats;
  let eyebrow, title;
  if (me.place === 1) { eyebrow = `${m.handNo}핸드 만에 우승`; title = `우승 · ${n}명 중 1위`; }
  else if (m.over && S.watched) { eyebrow = `${m.handNo}핸드 만에 끝`; title = `최종 결과 · 나는 ${n}명 중 ${me.place}위`; }
  else if (m.over && me.place === 0) { eyebrow = `${m.handNo}핸드 만에 끝`; title = "최종 결과"; }
  else { eyebrow = `${m.handNo}핸드 만에 탈락`; title = `탈락 · ${n}명 중 ${me.place}위`; }
  const watch = !m.over ? `<button class="btn" id="m-watch" type="button">계속 지켜보기</button>` : `<button class="btn" id="m-close" type="button">테이블 보기</button>`;
  if (mode !== "solo") {
    const code = mode === "host" ? room.code : guest.code;
    // 방장이 탈락해도 친구들 게임은 이 기기에서 계속된다: 지켜보기가 먼저, 방 닫기는 한 번 더 묻는다
    const actions = mode === "host"
      ? (m.over ? `<button class="btn primary" id="m-again" type="button">다시 하기 · 같은 방</button>${watch}<button class="btn" id="mp-close" type="button">방 닫기</button>`
        : `<button class="btn primary" id="m-watch" type="button">계속 지켜보기</button><button class="btn" id="mp-close-ask" type="button">방 닫기</button>`)
      : `${watch}<button class="btn" id="mp-leave" type="button">나가기</button>`;
    return `
      <p class="eyebrow">${eyebrow}</p>
      <h1>${title}</h1>
      <dl class="rules">
        <div><dt>가장 큰 팟</dt><dd>${fmt(S.biggestPot)}</dd></div>
        <div><dt>마지막 블라인드</dt><dd>${m.hand.sb}/${m.hand.bb}</dd></div>
        <div><dt>방</dt><dd>${esc(code)} · ${n}명</dd></div>
      </dl>
      ${standingsHtml()}
      ${mode === "guest" && m.over ? `<p class="fine standings-note">방장이 ‘다시 하기’를 누르면 같은 자리로 새 게임이 시작돼요.</p>` : ""}
      ${mode === "host" && !m.over ? `<p class="fine standings-note">친구들 게임은 계속돼요. 내 기기가 딜러라서 끝날 때까지 이 화면을 켜 두세요.</p>` : ""}
      <div class="modal-actions">${actions}</div>`;
  }
  const vpip = st.hands ? Math.round((100 * st.vpip) / st.hands) : 0;
  return `
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <dl class="rules">
      <div><dt>가장 큰 팟</dt><dd>${fmt(S.biggestPot)}</dd></div>
      <div><dt>마지막 블라인드</dt><dd>${m.hand.sb}/${m.hand.bb}</dd></div>
      <div><dt>내 VPIP</dt><dd>${vpip}% · ${st.hands}핸드</dd></div>
    </dl>
    ${standingsHtml()}
    <div class="modal-actions">
      <button class="btn primary" id="m-again" type="button">다시 하기 · ${n}명</button>
      ${watch}
      <button class="btn" id="m-setup" type="button">인원 바꾸기</button>
    </div>`;
}

const confirmNewHtml = () => `
  <h1>새 게임을 시작할까요?</h1>
  <p>지금 매치(핸드 #${S.m.handNo})는 사라집니다.</p>
  <div class="modal-actions"><button class="btn primary" id="m-setup" type="button">새 게임 설정</button><button class="btn" id="m-close" type="button">계속하기</button></div>`;

function openSetup(resume) {
  if (S) stopAll();
  setup.n = S ? S.m.players.length : setup.n;
  setup.claude = S ? S.claudeOn : setup.claude;
  setup.resume = resume;
  openModal(setupHtml(resume), "setup");
}

// 설정 창을 닫고 지금 매치로 돌아간다
function resumeMatch() {
  closeModal();
  tableKey = controlsKey = logKey = "";
  render();
  advance();
}

// ===== 친구와 하기: 첫 화면 =====
// 손님의 자리는 방마다 따로: 방장이 처음 앉힐 때 준 {gid, secret}을 그 방 코드에만 쓴다 (다른 방장에게는 보내지 않는다)
function loadProfile() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(NET_KEY)); } catch {}
  if (!p || typeof p !== "object") p = {};
  const ok = typeof PokerNet === "object";
  const last = p.last && typeof p.last.code === "string" && Number.isFinite(p.last.at) ? { code: p.last.code, at: p.last.at } : null;
  const rooms = {};
  if (p.rooms && typeof p.rooms === "object") {
    for (const [code, c] of Object.entries(p.rooms)) {
      if (c && tokOk(c.gid) && tokOk(c.secret) && Number.isFinite(c.at) && Date.now() - c.at < CRED_MS) rooms[code] = { gid: c.gid, secret: c.secret, started: !!c.started, at: c.at };
    }
  }
  return { name: ok ? PokerNet.cleanName(p.name) : "", last, rooms };
}
function saveProfile() {
  try { localStorage.setItem(NET_KEY, JSON.stringify(profile)); } catch {}
}
// 받은 자리를 기억한다: 이 탭(sessionStorage) + 이 브라우저(localStorage, 창을 닫았다 다시 열 때). 최근 8개 방까지만.
// started: 그 방이 시작했다 (시작한 방에서 새 자리를 주는 곳은 가짜 방장 — net.js createClient)
function saveCred(code, cred) {
  const started = !!cred.started;
  profile.rooms[code] = { gid: cred.gid, secret: cred.secret, started, at: Date.now() };
  for (const c of Object.keys(profile.rooms).sort((a, b) => profile.rooms[b].at - profile.rooms[a].at).slice(8)) delete profile.rooms[c];
  saveProfile();
  try { sessionStorage.setItem(TAB_KEY, JSON.stringify({ code, gid: cred.gid, secret: cred.secret, started })); } catch {}
}
function tabCred(code) {
  try {
    const t = JSON.parse(sessionStorage.getItem(TAB_KEY));
    if (t && t.code === code && tokOk(t.gid) && tokOk(t.secret)) return { gid: t.gid, secret: t.secret, started: !!t.started };
  } catch {}
  return null;
}
// 이 방에서 받은 자리. 이 탭 것이 아니고 같은 브라우저의 다른 탭이 지금 그 자리에 앉아 있으면 쓰지 않는다 (새 손님으로)
async function credFor(code) {
  const mine = tabCred(code);
  if (mine) return mine;
  const c = profile.rooms[code];
  if (!c) return null;
  return (await tabProbe("guest", code, c.gid)) ? null : { gid: c.gid, secret: c.secret, started: c.started };
}

// ===== 같은 브라우저의 다른 탭 =====
// 방장 탭 · 손님 탭은 물어보면 대답한다. 한 방을 두 탭에서 여는 것(방장)과 한 자리에 두 탭이 앉는 것(손님)을 막는다
const tabsCh = typeof BroadcastChannel === "function" ? new BroadcastChannel("holdem-tabs") : null;
if (tabsCh) {
  tabsCh.onmessage = (e) => {
    const m = e.data;
    if (!m || m.k !== "probe") return;
    const here = m.kind === "host" ? mode === "host" && room?.code === m.code
      : mode === "guest" && guest?.code === m.code && !!guest.cred && guest.cred.gid === m.gid;
    if (here) tabsCh.postMessage({ k: "here", id: m.id });
  };
}
function tabProbe(kind, code, gid) {
  if (!tabsCh) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = PokerNet.newToken(10), ch = new BroadcastChannel("holdem-tabs");
    const done = (v) => { clearTimeout(t); ch.close(); resolve(v); };
    const t = setTimeout(() => done(false), 350);
    ch.onmessage = (e) => { if (e.data?.k === "here" && e.data.id === id) done(true); };
    ch.postMessage({ k: "probe", kind, code, gid, id });
  });
}

// 주소의 #join-코드 (참가 링크)
function hashCode() {
  const m = /^#join-([A-Za-z0-9]{5})$/.exec(location.hash);
  return m && typeof PokerNet === "object" ? PokerNet.normCode(m[1]) : null;
}
function setHash(code) {
  try { history.replaceState(null, "", code ? `#join-${code}` : location.pathname + location.search); } catch {}
}
// 참가 링크: 지금 주소에서 만든다 (GitHub Pages면 https://swlee3286.github.io/holdem/#join-코드).
// 시험용 주소 파라미터는 localhost에서만 옮긴다 (진짜 사이트의 링크에 시그널링 서버 설정이 끼어 다니지 않게)
const shareUrl = (code) => {
  const local = typeof PokerNet === "object" && PokerNet.isLocalHost(location.hostname);
  const query = local ? location.search : NET_KIND === "local" ? "?net=local" : "";
  return location.href.split(/[?#]/)[0].replace(/index\.html$/, "") + query + "#join-" + code;
};

function netMenuHtml() {
  if (!netOk()) {
    // 안 되는 까닭을 나눠 알린다: 아티팩트 · 브라우저가 WebRTC를 못 씀 · 온라인 파일(PeerJS)을 못 불러옴
    const code = hashCode();
    const url = PUBLIC_URL + (code ? `#join-${code}` : "");
    const head = `
      <p class="eyebrow">각자 폰으로 · 온라인</p>
      <h1>친구와 한 테이블</h1>`;
    if (ARTIFACT) {
      return `${head}
      <p>친구와 하기는 이 화면에서는 쓸 수 없어요. Claude 아티팩트 안에서는 외부 연결이 막혀 있거든요.</p>
      <p>아래 GitHub 주소로 열면 친구들이 각자 폰으로 들어와 같이 할 수 있어요.</p>
      <p class="url-line">${esc(url)}</p>
      <p class="fine">혼자 하기(Claude와 AI 상대)는 여기서 그대로 할 수 있어요.</p>`;
    }
    const noRtc = NET_KIND === "local" ? typeof BroadcastChannel !== "function" : typeof RTCPeerConnection !== "function";
    return noRtc ? `${head}
      <p>이 브라우저에서는 온라인 연결(WebRTC)을 쓸 수 없어요. 최신 Chrome · Safari · 삼성 인터넷에서 열어 주세요.</p>
      <p class="url-line">${esc(url)}</p>` : `${head}
      <p class="net-error" role="alert">온라인 기능을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.</p>
      <p class="url-line">${esc(url)}</p>`;
  }
  const err = setup.err ? `<p class="net-error" role="alert">${esc(setup.err)}</p>` : "";
  const nameField = `
    <label class="field-col">
      <span class="field-label">내 이름</span>
      <input class="text-in" id="mp-name" maxlength="10" autocomplete="nickname" enterkeyhint="go" placeholder="10자까지" value="${esc(setup.name)}">
    </label>`;
  // 참가 링크로 들어온 친구: 이름만 적고 바로 참가
  const linked = setup.link && PokerNet.normCode(setup.code);
  if (linked) {
    return `
      <p class="eyebrow">친구와 하기 · 초대</p>
      <h1>방 <span class="code-text">${esc(linked)}</span>에 참가</h1>
      ${nameField}
      <input type="hidden" id="mp-code" value="${esc(linked)}">
      ${err}
      <div class="modal-actions"><button class="btn primary" id="mp-join" type="button">참가하기</button></div>
      <p class="fine invite-note">이름만 적으면 바로 들어가요. 방장이 시작하면 카드가 나와요. 같은 와이파이가 아니어도 돼요.</p>
      <button class="link-btn" id="mp-other" type="button">다른 코드 입력 · 방 만들기</button>`;
  }
  return `
    <p class="eyebrow">각자 폰으로 · 온라인</p>
    <h1>친구와 한 테이블</h1>
    <label class="field-col">
      <span class="field-label">내 이름</span>
      <input class="text-in" id="mp-name" maxlength="10" autocomplete="nickname" enterkeyhint="done" placeholder="10자까지" value="${esc(setup.name)}">
    </label>
    <div class="mp-choice">
      <section class="mp-box">
        <h2>방 만들기</h2>
        <p>내 기기가 딜러가 돼요. 코드나 링크를 친구에게 보내세요.</p>
        <button class="btn primary" id="mp-host" type="button">방 만들기</button>
      </section>
      <section class="mp-box">
        <h2>참가하기</h2>
        <p>친구에게 받은 코드 5자리</p>
        <div class="join-row">
          <input class="text-in code-in" id="mp-code" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" placeholder="ABCDE" aria-label="방 코드" value="${esc(setup.code)}">
          <button class="btn${setup.code ? " primary" : ""}" id="mp-join" type="button">참가</button>
        </div>
      </section>
    </div>
    ${err}
    <p class="fine">같은 와이파이가 아니어도 돼요. 빈 자리는 AI가 앉아요. 일부 회사·학교 와이파이나 모바일 데이터에서는 연결이 막힐 수 있어요.</p>`;
}

function readSetupInputs() {
  const n = $("mp-name"), c = $("mp-code");
  if (n) setup.name = n.value;
  if (c) setup.code = c.value;
}

function setupError(msg, focusId) {
  setup.err = msg;
  openModal(setupHtml(setup.resume), "setup");
  if (focusId) $(focusId)?.focus();
}

// 혼자 하기 화면에서 나간다 (혼자 하기 매치는 저장돼 있어 처음으로 돌아오면 이어할 수 있다)
function leaveSolo() {
  stopAll();
  S = null;
  tableKey = controlsKey = logKey = turnKey = "";
  hint = { key: "", d: null };
}

// 친구와 하기를 끝내고 첫 화면으로
function backToStart(err = "") {
  stopAll();
  clearInterval(tickTimer);
  clearTimeout(pendTimer);
  clearTimeout(retryTimer);
  releaseWake();
  if (net) { try { net.close(mode === "host" ? "closed" : true); } catch {} } // 손님: 나간다고 알린다 (시작 전이면 자리를 비운다)
  net = null;
  mode = "solo";
  ME = 0;
  room = null;
  guest = null;
  setHash(null);
  S = load();
  tableKey = controlsKey = logKey = turnKey = "";
  hint = { key: "", d: null };
  setup.tab = "mp";
  setup.err = err;
  setup.resume = true;
  if (S) {
    setup.n = S.m.players.length;
    setup.claude = S.claudeOn;
    render();
  } else {
    $("log").innerHTML = "";
    $("controls").innerHTML = `<div class="waiting">인원을 고르면 카드를 나눠줍니다</div>`;
    renderPreview(setup.n);
  }
  openModal(setupHtml(true), "setup");
  renderTop();
}

// 화면이 꺼지지 않게 (지원하는 브라우저만)
async function requestWake() {
  try {
    if (!wakeLock && navigator.wakeLock && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener?.("release", () => { wakeLock = null; });
    }
  } catch { wakeLock = null; }
}
function releaseWake() {
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}

function toast(text) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 3500);
}

// kick: 방장 로비 — 손님 줄에 '내보내기' (끊긴 채 돌아오지 않는 손님 · 모르는 사람)
function lobbyRows(list, mine, kick) {
  return list.map((p) => {
    const r = ROSTER[p.seat] ?? ROSTER[0];
    const initial = p.kind === "ai" && p.name === r.name ? r.initial : Array.from(p.name)[0] || "?";
    const tag = p.isHost ? "방장" : p.kind === "ai" ? "AI" : p.connected ? "들어옴" : "연결 끊김";
    const out = kick && !p.isHost && p.kind === "human" ? `<button class="lob-kick" type="button" data-kick="${p.seat}" aria-label="${esc(p.name)} 내보내기">내보내기</button>` : "";
    return `<li class="${p.seat === mine ? "me" : ""}${p.kind === "ai" ? " ai" : ""}${p.connected ? "" : " away"}"><span class="avatar" style="--av:${r.color}" aria-hidden="true">${esc(initial)}</span><b>${esc(p.name)}</b>${p.seat === mine ? `<small>나</small>` : ""}<span class="lob-tag">${tag}</span>${out}</li>`;
  }).join("");
}

// ===== 친구와 하기: 방장 =====
function hostCreate() {
  readSetupInputs();
  const name = PokerNet.cleanName(setup.name);
  if (!name) { setupError("이름을 적어 주세요", "mp-name"); return; }
  if (name === "나") { setupError("‘나’는 친구 화면에서 헷갈려요. 다른 이름을 적어 주세요", "mp-name"); return; }
  setup.err = "";
  profile.name = name;
  saveProfile();
  hostOpen(null, name);
}

// saved: 새로고침 전에 저장한 방 (없으면 새 방)
function hostOpen(saved, hostName) {
  leaveSolo();
  mode = "host";
  ME = 0;
  if (saved) {
    room = saved.room;
    S = saved.S;
    if (S) { S.turn = null; S.nextAt = 0; }
  } else {
    room = { code: "", n: setup.mpN, hostName: PokerNet.createRoom(setup.mpN, hostName).hostName, started: false, guests: [] };
    S = null;
  }
  Object.assign(room, { ready: false, status: "checking", note: "", error: "", takenAt: 0 });
  startTicker();
  requestWake();
  hostConnect(!!saved);
  if (S && room.started) {
    render();
    openModal(`
      <p class="eyebrow">친구와 하기 · 방장</p>
      <h1>방 ${esc(room.code)} 다시 여는 중…</h1>
      <p>새로고침 전에 하던 게임(핸드 #${S.m.handNo})을 이어서 열어요. 친구들은 자동으로 다시 들어와요.</p>
      <p class="net-error" id="resume-error" role="alert" hidden></p>
      <div class="modal-actions"><button class="btn" id="mp-close" type="button">방 닫기</button></div>`, "resume");
  } else {
    renderPreview(room.n);
    showHostLobby();
  }
  renderTop();
}

function hostConnect(resume) {
  if (net) net.close("left");
  net = PokerNet.createHost({ kind: NET_KIND, code: room.code || undefined, resume: resume || !!room.code, params: QS }, {
    lookup: (gid) => room.guests.find((g) => g.gid === gid)?.secret || null, // 자리를 되찾는 손님 확인용
    onReady(code) {
      room.code = code;
      room.ready = true;
      room.error = "";
      room.status = "online";
      room.takenAt = 0;
      // 다시 열었으면: 아직 안 돌아온 손님에게 지금부터 잠깐 기다릴 시간을 준다 (그 사이 그 자리 차례를 AI가 바로 두지 않게)
      for (const g of room.guests) if (!g.connected && g.lostAt) g.lostAt = Date.now();
      saveRoom();
      if (S && room.started) {
        if (modalScreen === "resume") closeModal();
        tableKey = controlsKey = "";
        advance(); // 멈춰 있던 차례 · 타이머를 다시 시작한다
      } else showHostLobby();
      renderTop();
    },
    onHello: hostHello,
    onAct: hostAct,
    onLeave: hostLeave,
    onError: hostNetError,
    onStatus(st) {
      room.status = st;
      renderTop();
    },
  });
}

function hostNetError(code) {
  let msg, again = 0;
  if (code === "id-taken" && room.code) {
    // 다시 열 때 코드가 쓰이는 중: 대개 서버가 끊긴 예전 연결을 아직 들고 있는 것 (1~2분 뒤 정리된다). 그동안 계속 다시 시도
    room.takenAt ||= Date.now();
    if (Date.now() - room.takenAt < TAKEN_MS) {
      msg = `서버가 방 ${room.code}의 예전 연결을 정리하는 중이에요. 1~2분 걸릴 수 있어요. 계속 다시 시도해요.`;
      again = 5000;
    } else msg = `방 코드 ${room.code}를 다른 곳에서 쓰고 있어요. 방을 닫고 새로 만들어 주세요.`;
  } else if (code === "id-taken") msg = "방 코드를 만들지 못했어요. 잠시 뒤 다시 해 주세요.";
  else if (code === "unsupported") msg = "이 브라우저는 온라인 연결(WebRTC)을 지원하지 않아요.";
  else { msg = "연결 서버에 닿지 않아요. 인터넷 연결을 확인해 주세요. 계속 다시 시도해요."; again = 4000; }
  room.error = msg;
  room.status = "offline";
  // 같은 코드로 잠시 뒤 다시 연다
  if (again && mode === "host") {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (mode === "host" && room && !room.ready) hostConnect(true); }, again);
  }
  if (modalScreen === "resume") {
    const el = $("resume-error");
    if (el) { el.textContent = msg; el.hidden = false; }
  } else if (!room.started) showHostLobby();
  else toast(msg);
  renderTop();
}

// AI 자리 이름: 자리별 기본 이름을 쓰되, 사람 이름과 겹치면 다른 이름으로.
// 친구와 하기에서는 Claude를 부르지 않으므로(모든 AI = GTO 엔진) 1번 자리도 'Claude'라 부르지 않는다
const AI_POOL = ["민지", "준호", "서윤", "태현", "하준", "지우", "도윤", "예린", "시우", "하린"];
function aiSeatNames() {
  const taken = [room.hostName, ...room.guests.map((g) => g.name)], out = {};
  for (let s = 1; s < room.n; s++) {
    if (PokerNet.roomGuestAt(room, s)) continue;
    const pref = s === CLAUDE ? null : ROSTER[s].name;
    const name = pref && !taken.includes(pref) ? pref : AI_POOL.find((x) => !taken.includes(x)) ?? `AI ${s}`;
    taken.push(name);
    out[s] = name;
  }
  return out;
}

function hostLobbyPlayers() {
  const list = [{ seat: 0, name: room.hostName, kind: "human", connected: true, isHost: true }];
  if (room.started && S) {
    S.m.players.forEach((p, s) => { if (s) list.push({ seat: s, name: p.name, kind: p.kind === "bot" ? "ai" : "human", connected: seatOnline(s), isHost: false }); });
    return list;
  }
  for (const g of room.guests) list.push({ seat: g.seat, name: g.name, kind: "human", connected: g.connected, isHost: false });
  const ai = aiSeatNames();
  for (let s = room.guests.length + 1; s < room.n; s++) list.push({ seat: s, name: ai[s], kind: "ai", connected: true, isHost: false });
  return list;
}

function hostLobbyHtml() {
  const r = room, n = r.n, joined = r.guests.length;
  const can = r.ready && r.guests.some((g) => g.connected);
  const counts = [2, 3, 4, 5, 6].map((k) =>
    `<button type="button" data-mpn="${k}" aria-pressed="${k === n}" ${k < joined + 1 ? "disabled" : ""}>${k}명</button>`).join("");
  const url = r.ready ? shareUrl(r.code) : "";
  return `
    <p class="eyebrow">친구와 하기 · 방장</p>
    <h1>${joined ? "친구가 들어왔어요" : "친구를 기다리는 중"}</h1>
    <div class="room-code-box">
      <span class="field-label">방 코드</span>
      <div class="room-code${r.ready ? "" : " pending"}" id="room-code" aria-live="polite">${r.ready ? esc(r.code) : "여는 중…"}</div>
    </div>
    <div class="share-row">
      <input class="text-in share-url" id="mp-url" readonly value="${esc(url)}" placeholder="링크 만드는 중…" aria-label="참가 링크">
      <button class="btn primary" id="mp-share" type="button" ${r.ready ? "" : "disabled"}>${navigator.share ? "공유" : "링크 복사"}</button>
    </div>
    <p class="fine share-note" id="share-note">${esc(r.note || "링크를 보내거나 코드를 알려 주세요. 친구는 링크를 열고 이름만 적으면 돼요.")}</p>
    ${r.error ? `<p class="net-error" role="alert">${esc(r.error)}</p>` : ""}
    <div class="field">
      <span class="field-label" id="mpn-label">인원</span>
      <div class="seg count" role="group" aria-labelledby="mpn-label">${counts}</div>
    </div>
    <ul class="lobby">${lobbyRows(hostLobbyPlayers(), 0, true)}</ul>
    <div class="modal-actions">
      <button class="btn primary" id="mp-start" type="button" ${can ? "" : "disabled"}>${can ? `${n}명으로 시작` : "친구를 기다리는 중"}</button>
      <button class="btn" id="mp-close" type="button">방 닫기</button>
    </div>
    <p class="fine">빈 자리는 AI(GTO 엔진)가 앉아요. 내 기기가 딜러라서 게임이 끝날 때까지 이 화면을 켜 두세요.</p>`;
}

function showHostLobby() {
  if (mode !== "host" || room.started) return;
  showScreen("lobby", hostLobbyHtml());
}

// msg = {name, gid}: gid는 net.js가 서로 확인(auth)을 마친 손님만 (버전 · 증명 검사도 net.js에서)
function hostHello(id, msg) {
  if (!room.ready) { net.drop(id); return; }
  const r = PokerNet.roomJoin(room, msg, id); // 이름이 겹치면 숫자를 붙인다 (AI 이름은 시작할 때 피해 간다)
  if (!r.ok) { net.drop(id, { t: "error", msg: r.msg, fatal: true }); return; }
  if (r.replaced) net.drop(r.replaced, { t: "error", msg: "다른 곳에서 이 자리로 다시 들어왔어요", fatal: true });
  // 새 자리면 그 자리 비밀값을 이 손님에게만 한 번 준다 (다시 붙을 때는 증명만 오간다)
  net.send(id, r.secret ? { t: "welcome", seat: r.seat, gid: r.gid, secret: r.secret } : { t: "welcome", seat: r.seat, gid: r.gid });
  saveRoom();
  lobbyBroadcast();
  if (room.started && S) {
    if (r.back) toast(`${S.m.players[r.seat].name} 다시 연결됨`);
    advance(); // 되찾은 자리: 바로 그 사람 화면을 보내고, 그 자리 차례면 사람을 기다린다
  } else showHostLobby();
  renderTop();
}

function hostAct(id, msg) {
  const g = room.guests.find((x) => x.conn === id);
  if (!g || !room.started || !S || !room.ready) return;
  const r = PokerNet.checkAct(S.m, g.seat, msg);
  if (!r.ok) { sendState(g); return; } // 늦었거나 차례가 아니거나 규칙에 맞지 않는 수는 무시하고 지금 화면을 다시 보낸다
  doAct(g.seat, r.type, r.to);
}

// left: 손님이 스스로 나갔다. 시작 전이면 자리를 비우고, 시작 뒤면 기다리지 않고 AI가 대신 둔다.
// 그냥 끊겼으면 자리를 남겨 두고(시작 전 로비도) 같은 기기로 돌아오면 되찾는다
function hostLeave(id, left) {
  const seat = PokerNet.roomLeave(room, id);
  if (seat < 0) return;
  if (left && !room.started) PokerNet.roomRemove(room, seat);
  else if (left) PokerNet.roomGuestAt(room, seat).lostAt = 0;
  saveRoom();
  lobbyBroadcast();
  if (room.started && S) {
    toast(left ? `${S.m.players[seat].name} 나감 · AI가 대신 둡니다` : `${S.m.players[seat].name} 연결 끊김 · 곧 돌아오지 않으면 AI가 대신 둬요`);
    advance(); // 그 자리 차례였다면 잠깐 기다렸다가 AI가 대신
  } else showHostLobby();
  renderTop();
}

// 방장 로비: 손님 내보내기 (시작 전에만)
function hostKick(seat) {
  if (mode !== "host" || room.started) return;
  const g = PokerNet.roomGuestAt(room, seat);
  if (!g) return;
  PokerNet.roomRemove(room, seat);
  if (g.conn) net?.drop(g.conn, { t: "error", msg: "방장이 방에서 내보냈어요", fatal: true });
  saveRoom();
  lobbyBroadcast();
  showHostLobby();
  renderPreview(room.n);
  renderTop();
}

function lobbyBroadcast() {
  if (!net || !room.code) return;
  const players = hostLobbyPlayers();
  for (const g of room.guests) {
    if (g.conn && g.connected) net.send(g.conn, { t: "lobby", code: room.code, players, seats: room.n, started: room.started, you: g.seat });
  }
}

function hostStart() {
  if (!room.ready || room.started || !room.guests.some((g) => g.connected)) return;
  room.started = true;
  closeModal();
  newMatchMP();
  lobbyBroadcast();
}

// 같은 방 · 같은 자리로 새 매치 (처음 시작 · 다시 하기)
function newMatchMP() {
  stopAll();
  const players = [], ai = aiSeatNames();
  for (let s = 0; s < room.n; s++) {
    const g = PokerNet.roomGuestAt(room, s);
    players.push(s === 0 ? { name: room.hostName, kind: "human" } : g ? { name: g.name, kind: "remote" } : { name: ai[s], kind: "bot" });
  }
  S = {
    v: 2,
    m: PT.createMatch({ players, startStack: START_STACK, levels: LEVELS, handsPerLevel: HANDS_PER_LEVEL }),
    claudeOn: false, depth: "quick",
    stats: { hands: 0, vpip: 0, pfr: 0, aggr: 0, calls: 0, facedBet: 0, foldedToBet: 0, showdowns: [] },
    history: [], log: [], logAt: null, say: null, track: null, biggestPot: 0, doneNo: 0, ended: "", watched: false,
    matchId: PokerNet.newToken(10), // 손님이 새 매치를 알아보는 표시
    turn: null,                     // 사람 차례 제한 시간 { key, seat, deadline }
    nextAt: 0,                      // 다음 핸드 자동 시작 시각
  };
  fast = false;
  tableKey = controlsKey = logKey = turnKey = "";
  requestWake();
  startHand();
}

// 방장: 다음에 일어날 일을 예약한다 (카드 펼치기 · AI 차례 · 사람 차례 제한 시간 · 다음 핸드)
function hostSchedule() {
  const m = S.m, h = m.hand;
  clearTimeout(timer);
  clearTimeout(turnTimer);
  clearTimeout(nextTimer);
  if (h.phase === "runout") {
    S.turn = null;
    timer = setTimeout(() => {
      if (!S || S.m !== m || m.hand !== h || h.phase !== "runout") return;
      PT.runoutStep(m);
      advance();
    }, 900);
  } else if (h.phase === "bet") {
    const seat = h.toAct, p = m.players[seat];
    // 방금 끊긴 손님(새로고침 · 잠깐 끊김)은 GRACE_MS 동안 사람 차례처럼 기다린다. 그 사이 시간이 다 되면 체크 · 폴드
    const g = p.kind === "remote" && !seatOnline(seat) ? PokerNet.roomGuestAt(room, seat) : null;
    const grace = g && g.lostAt ? g.lostAt + GRACE_MS - Date.now() : 0;
    if (p.kind === "human" || (p.kind === "remote" && (seatOnline(seat) || grace > 0))) {
      const key = `${h.no}|${h.actions.length}|${seat}`;
      if (S.turn?.key !== key) S.turn = { key, seat, deadline: Date.now() + TURN_MS };
      const left = Math.max(0, S.turn.deadline - Date.now());
      if (grace > 0 && grace < left) turnTimer = setTimeout(() => { if (S && S.m === m && m.hand === h && h.toAct === seat) advance(); }, grace); // 돌아오지 않으면 AI가 대신
      else turnTimer = setTimeout(() => turnTimeout(m, h, seat), left);
    } else {
      S.turn = null;
      timer = setTimeout(() => botTurn(m, h, seat), 450 + Math.random() * 450);
    }
  } else {
    S.turn = null;
    if (!m.over) {
      if (!S.nextAt) S.nextAt = Date.now() + NEXT_MS;
      nextTimer = setTimeout(() => { if (S && S.m === m && m.hand === h) startHand(); }, Math.max(0, S.nextAt - Date.now()));
    }
  }
}

// 시간 초과: 체크할 수 있으면 체크, 아니면 폴드
function turnTimeout(m, h, seat) {
  if (!S || S.m !== m || m.hand !== h || h.phase !== "bet" || h.toAct !== seat) return;
  const L = PT.legal(m, seat);
  doAct(seat, L.toCall === 0 ? "check" : "fold", undefined, "", "timeout");
}

function viewExtra() {
  const now = Date.now();
  return {
    match: S.matchId, code: room.code,
    connected: S.m.players.map((_, s) => seatOnline(s)),
    turn: S.turn ? { seat: S.turn.seat, left: S.turn.deadline - now, total: TURN_MS } : null,
    next: S.nextAt ? S.nextAt - now : null,
  };
}

function sendState(g) {
  if (!net || !g.conn || !S) return;
  net.send(g.conn, { t: "state", view: PokerNet.viewFor(S.m, g.seat, viewExtra()) });
}

function hostBroadcast() {
  if (!room?.ready || !room.started || !S) return;
  for (const g of room.guests) if (g.conn && g.connected) sendState(g);
}

function saveRoom() {
  if (mode !== "host" || !room?.code) return;
  const data = {
    v: 2, at: Date.now(),
    room: { code: room.code, n: room.n, hostName: room.hostName, started: room.started, guests: room.guests.map((g) => ({ seat: g.seat, name: g.name, gid: g.gid, secret: g.secret })) },
    S: room.started ? S : null,
  };
  try { localStorage.setItem(ROOM_KEY, JSON.stringify(data)); } catch {}
}

function loadRoom() {
  try {
    const d = JSON.parse(localStorage.getItem(ROOM_KEY));
    if (!d || d.v !== 2 || !d.room || !Number.isFinite(d.at) || Date.now() - d.at > RESUME_MS) return null;
    const r = d.room;
    if (!PokerNet.normCode(r.code) || !(r.n >= 2 && r.n <= 6) || !Array.isArray(r.guests) || !r.guests.every((g) => tokOk(g?.gid) && tokOk(g?.secret))) return null;
    const S0 = r.started ? d.S : null;
    if (r.started && (!S0?.m?.hand || S0.m.players.length !== r.n || !S0.matchId || !S0.logAt)) return null;
    return {
      // 손님은 모두 끊긴 상태로 시작한다. 돌아오면 같은 자리 (onReady에서 잠깐 기다릴 시간을 준다)
      room: { code: r.code, n: r.n, hostName: PokerNet.cleanName(r.hostName, "방장"), started: !!r.started,
        guests: r.guests.map((g) => ({ seat: g.seat, name: g.name, gid: g.gid, secret: g.secret, conn: null, connected: false, lostAt: 1 })) },
      S: S0,
    };
  } catch {
    return null;
  }
}

function hostClose() {
  setup.link = false;
  try { localStorage.removeItem(ROOM_KEY); } catch {}
  backToStart();
}

// ===== 친구와 하기: 손님 =====
function guestJoinFromForm() {
  readSetupInputs();
  const code = PokerNet.normCode(setup.code);
  const name = PokerNet.cleanName(setup.name);
  if (!name) { setupError("이름을 적어 주세요", "mp-name"); return; }
  if (!code) { setupError("방 코드 5자리를 확인해 주세요", "mp-code"); return; }
  setup.err = "";
  profile.name = name;
  saveProfile();
  if (joining) return;
  joining = true; // 다른 탭에 물어보는 동안(잠깐) 두 번 누르지 않게
  credFor(code).then((cred) => { joining = false; if (mode === "solo") guestJoin(code, name, false, cred); });
}
let joining = false;

// persistent: 새로고침 뒤 다시 들어가는 중 (방이 잠깐 안 보여도 계속 시도). cred: 이 방에서 전에 받은 자리 (없으면 새로 앉는다)
function guestJoin(code, name, persistent, cred) {
  leaveSolo();
  mode = "guest";
  ME = 0;
  guest = { code, name, seat: -1, cred: cred || null, status: "connecting", lobby: null, view: null, at: 0, pending: null, gone: "" };
  profile.last = { code, at: Date.now() };
  saveProfile();
  setHash(code);
  startTicker();
  // 방장이 오래(새로고침 · 전화 · 잠깐 멈춤) 걸려 돌아와도 이어지게 방장이 방을 기억하는 시간만큼 다시 시도한다
  net = PokerNet.createClient({ kind: NET_KIND, code, name, cred, persistent, params: QS, giveUpMs: RESUME_MS }, {
    onCred(c) { // 새 자리를 받았다 · 방이 시작했다: 이 방에서만 쓴다
      guest.cred = c;
      saveCred(code, c);
    },
    onWelcome(seat) {
      guest.seat = seat;
      if (guest.cred) saveCred(code, guest.cred); // 이 탭의 자리로 (다른 탭이 같은 자리를 쓰지 않게)
      if (!S) guestScreen();
    },
    onLobby(msg) {
      const resize = !guest.lobby || guest.lobby.seats !== msg.seats;
      guest.lobby = msg;
      if (S) { renderTop(); return; }
      if (resize) renderPreview(msg.seats); // 뒤에 보이는 빈 테이블도 방 인원으로
      guestScreen();
    },
    onState: guestState,
    onError(msg, fatal) {
      if (fatal) guestStop(msg);
      else toast(msg);
    },
    onBye(reason) {
      if (reason === "closed") guestStop("방장이 방을 닫았어요", true);
      else { guest.gone = "left"; showHostLeft(); }
    },
    onStatus(st, why) {
      guest.status = st;
      if (why === "impostor") toast("방장이 아닌 곳에 연결돼서 끊었어요. 다시 연결하는 중…");
      renderTop();
      if (!S) guestScreen();
      else { controlsKey = ""; render(); }
    },
    onFatal(code) {
      guestStop({
        "not-found": "방을 찾을 수 없어요. 코드를 확인해 주세요. 방장이 방을 닫았을 수도 있어요.",
        timeout: "연결하지 못했어요. 와이파이나 모바일 데이터를 바꿔 다시 해 보세요. 일부 네트워크에서는 연결이 막혀 있어요.",
        network: "연결 서버에 닿지 않아요. 인터넷 연결을 확인해 주세요.",
        unsupported: "이 브라우저는 온라인 연결(WebRTC)을 지원하지 않아요.",
        gone: "방장과 연결이 끊겼어요. 방장이 돌아오지 않았어요.",
        impostor: "방장을 확인하지 못했어요. 방장에게 방이 열려 있는지 물어보고 다시 들어와 주세요.",
      }[code] || "연결이 끊겼어요.", !!S);
    },
  });
  guestScreen();
  renderTop();
}

function guestWaitHtml() {
  const g = guest, lob = g.lobby;
  const title = g.status === "reconnecting" ? "다시 연결하는 중…" : !lob ? "방에 들어가는 중…" : lob.started ? "게임에 들어가는 중…" : "시작을 기다리는 중";
  return `
    <p class="eyebrow">친구와 하기 · 방 ${esc(g.code)}</p>
    <h1>${title}</h1>
    ${lob ? `<ul class="lobby">${lobbyRows(lob.players, lob.you)}</ul>
      <p class="fine">${lob.seats}명 테이블 · 빈 자리는 AI가 앉아요. 시작하면 바로 카드가 나와요.</p>`
      : `<p class="fine">${esc(g.code)} 방에 연결하고 있어요. 같은 와이파이가 아니어도 돼요.</p>`}
    <div class="modal-actions"><button class="btn" id="mp-leave" type="button">나가기</button></div>`;
}

function guestScreen() {
  if (mode !== "guest" || S) return;
  showScreen("wait", guestWaitHtml());
}

function guestState(view) {
  if (mode !== "guest" || !view.hand) return;
  guest.view = view;
  guest.at = performance.now();
  guest.status = "open";
  if (guest.pending) { guest.pending = null; clearTimeout(pendTimer); }
  if (guest.gone) { guest.gone = ""; if (modalScreen === "left") closeModal(); }
  if (Date.now() - profile.last?.at > 30000) {
    profile.last = { code: guest.code, at: Date.now() };
    if (guest.cred) saveCred(guest.code, guest.cred); // 자리 기억도 새로 (saveProfile 포함)
    else saveProfile();
  }
  if (!S || S.matchId !== view.match) { // 첫 화면 · 새 매치(다시 하기)
    S = { v: 2, m: null, claudeOn: false, stats: null, history: [], log: [], logAt: null, say: null, biggestPot: 0, doneNo: 0, ended: "", watched: false, matchId: view.match };
    tableKey = controlsKey = logKey = turnKey = "";
    if (["wait", "end", "left"].includes(modalScreen)) closeModal();
    requestWake();
  }
  ME = view.seat;
  const prevNo = S.m?.hand?.no;
  S.m = PokerNet.viewToMatch(view);
  const h = S.m.hand;
  if (h.no !== prevNo) beginLog(h);
  syncLog();
  if (h.phase === "done") {
    handDone(h);
    if (needsEndModal()) {
      clearTimeout(endTimer);
      endTimer = setTimeout(showEnd, 1600);
    }
  }
  render();
}

// 손님의 수: 방장에게 보내고, 새 화면이 올 때까지 버튼을 잠근다
function guestSend(h, L, type, to) {
  if (guest.pending) return;
  if (!net?.open) { toast("연결이 끊겨 있어요. 다시 연결하는 중…"); return; }
  const msg = { t: "act", hand: h.no, n: h.actions.length, type };
  if (type === "raise") msg.to = clamp(Math.round(Number(to)) || L.minTo, L.minTo, L.maxTo);
  guest.pending = { no: h.no, n: h.actions.length };
  net.send(msg);
  controlsKey = "";
  renderControls();
  clearTimeout(pendTimer);
  pendTimer = setTimeout(() => { // 답이 없으면 다시 누를 수 있게
    if (!guest?.pending) return;
    guest.pending = null;
    controlsKey = "";
    if (S) renderControls();
  }, 6000);
}

function showHostLeft() {
  if (!S) { guestScreen(); return; }
  openModal(`
    <p class="eyebrow">친구와 하기 · 방 ${esc(guest.code)}</p>
    <h1>방장이 나갔어요</h1>
    <p>방장이 다시 들어오면 자동으로 이어져요. 기다리지 않으려면 처음으로 돌아가세요.</p>
    <div class="modal-actions"><button class="btn primary" id="mp-home" type="button">처음으로</button></div>`, "left");
}

// 손님 연결을 끝낸다. 게임 화면이 있으면 그 위에 알림, 없으면 첫 화면에 오류로
function guestStop(msg, overTable) {
  if (net) { try { net.close(); } catch {} }
  net = null;
  profile.last = null;
  saveProfile();
  if (overTable && S) {
    clearInterval(tickTimer);
    releaseWake();
    guest.status = "closed";
    openModal(`
      <p class="eyebrow">친구와 하기 · 방 ${esc(guest.code)}</p>
      <h1>${esc(msg)}</h1>
      <div class="modal-actions"><button class="btn primary" id="mp-home" type="button">처음으로</button></div>`, "ended");
    return;
  }
  backToStart(msg);
}

function guestLeave() {
  setup.link = false;
  profile.last = null;
  saveProfile();
  backToStart();
}

const leaveConfirmHtml = () => mode === "host" ? `
  <h1>방을 닫을까요?</h1>
  <p>내 기기가 딜러라서 방을 닫으면 친구들의 게임도 끝나요.</p>
  <div class="modal-actions"><button class="btn primary" id="mp-close" type="button">방 닫기</button><button class="btn" id="m-close" type="button">계속하기</button></div>` : `
  <h1>방에서 나갈까요?</h1>
  <p>내 자리는 AI가 대신 둡니다. 같은 링크로 다시 들어오면 자리를 되찾아요.</p>
  <div class="modal-actions"><button class="btn primary" id="mp-leave" type="button">나가기</button><button class="btn" id="m-close" type="button">계속하기</button></div>`;

// ===== 입력 =====
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const h = S?.m?.hand;
  switch (t.id) {
    case "m-start": closeModal(); newMatch(setup.n, setup.claude); return;
    case "m-resume": case "m-cancel": resumeMatch(); return;
    case "m-again": closeModal(); if (mode === "host") newMatchMP(); else newMatch(S.m.players.length, S.claudeOn); return;
    case "m-setup": openSetup(false); return;
    case "m-watch": S.watched = true; save(); closeModal(); if (!thinking) advance(); return;
    case "m-close": closeModal(); if (S && !thinking) advance(); return;
    case "new-game":
      if (mode !== "solo") openModal(leaveConfirmHtml(), "leave"); // 친구와 하기는 멈추지 않는다
      else if (S && !S.m.over) { stopAll(); render(); openModal(confirmNewHtml()); } // 묻는 동안 게임을 멈춘다 (계속하기 → 이어서)
      else openSetup(false);
      return;
    case "next": if (mode !== "guest") startHand(); return;
    case "show-end": clearTimeout(endTimer); if (S.ended && S.m.over) openModal(endHtml(), "end"); else showEnd(); return;
    case "fast": fast = !fast; controlsKey = ""; if (h?.phase !== "done" && !thinking) advance(); else render(); return;
    case "hint-toggle":
      hintOn = !hintOn;
      try { localStorage.setItem(HINT_KEY, hintOn ? "1" : "0"); } catch {}
      controlsKey = "";
      renderControls();
      return;
    case "b-fold": userAct("fold"); return;
    case "b-call": userAct("call"); return;
    case "b-raise": userAct("raise", raiseAmount()); return;
    case "skip": thinking?.ctl.abort(); return;
    case "retry": link = "live"; renderTop(); return;
    case "tab-solo": case "tab-mp":
      readSetupInputs();
      setup.tab = t.id === "tab-mp" ? "mp" : "solo";
      setup.err = "";
      openModal(setupHtml(setup.resume), "setup");
      $(t.id)?.focus();
      if (!S || S.m.over) renderPreview(setup.tab === "mp" ? setup.mpN : setup.n);
      return;
    case "mp-host": hostCreate(); return;
    case "mp-join": guestJoinFromForm(); return;
    case "mp-share": shareLink(); return;
    case "mp-start": hostStart(); return;
    case "mp-close": hostClose(); return;
    case "mp-close-ask": openModal(leaveConfirmHtml(), "leave"); return;
    case "mp-leave": guestLeave(); return;
    case "mp-other": readSetupInputs(); setup.link = false; setup.code = ""; setup.err = ""; openModal(setupHtml(setup.resume), "setup"); $("mp-code")?.focus(); return;
    case "mp-home": if (mode === "guest") guestLeave(); else backToStart(); return;
  }
  if (t.dataset.count) {
    setup.n = Number(t.dataset.count);
    const claude = $("m-claude");
    if (claude) setup.claude = claude.checked;
    const resume = !!$("m-resume");
    openModal(setupHtml(resume), "setup");
    $("modal-card").querySelector(`[data-count="${setup.n}"]`)?.focus();
    if (!S || S.m.over) renderPreview(setup.n);
  } else if (t.dataset.kick && mode === "host") {
    hostKick(Number(t.dataset.kick));
  } else if (t.dataset.mpn && mode === "host" && !room.started) {
    room.n = setup.mpN = Number(t.dataset.mpn);
    saveRoom();
    lobbyBroadcast();
    showHostLobby();
    $("modal-card").querySelector(`[data-mpn="${room.n}"]`)?.focus();
    renderPreview(room.n);
  } else if (t.classList.contains("preset")) {
    setAmount(Number(t.dataset.to));
  } else if (t.dataset.depth) {
    if (S) { S.depth = t.dataset.depth; save(); }
    renderTop();
  }
});

// 참가 링크 공유: 공유 창 → 클립보드 → 글자 선택 (직접 복사)
async function shareLink() {
  if (!room?.ready) return;
  const url = shareUrl(room.code);
  const note = (text) => {
    room.note = text;
    const el = $("share-note");
    if (el) el.textContent = text;
  };
  if (navigator.share) {
    try {
      await navigator.share({ title: "홀덤 테이블", text: `홀덤 같이 해요! 방 코드 ${room.code}`, url });
      note("공유했어요. 친구가 들어오면 아래 목록에 나와요.");
      return;
    } catch (e) {
      if (e?.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    note("링크를 복사했어요. 친구에게 붙여 넣어 보내세요.");
  } catch {
    const i = $("mp-url");
    if (i) { i.focus(); i.select(); i.setSelectionRange(0, i.value.length); }
    note("링크를 선택했어요. 길게 눌러(또는 Ctrl+C) 복사하세요.");
  }
}

function setAmount(v) {
  const L = PT.legal(S.m, ME);
  v = clamp(Number.isFinite(v) ? v : L.minTo, L.minTo, L.maxTo);
  if ($("slider")) $("slider").value = v;
  if ($("amt")) $("amt").value = v;
  syncRaiseLabel(L);
}

document.addEventListener("input", (e) => {
  if (e.target.id === "mp-name") { setup.name = e.target.value; return; }
  if (e.target.id === "mp-code") {
    const up = e.target.value.toUpperCase();
    if (up !== e.target.value) e.target.value = up;
    setup.code = up;
    return;
  }
  if (!S?.m?.hand || S.m.hand.toAct !== ME) return;
  if (e.target.id === "slider") setAmount(Number(e.target.value));
  else if (e.target.id === "amt") {
    if ($("slider")) $("slider").value = e.target.value;
    syncRaiseLabel(PT.legal(S.m, ME));
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "m-claude") setup.claude = e.target.checked;
  else if (e.target.id === "amt" && S?.m?.hand?.toAct === ME) setAmount(Number(e.target.value));
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing && (e.target.id === "mp-code" || e.target.id === "mp-name")) {
    e.preventDefault();
    if (e.target.id === "mp-code" || PokerNet.normCode($("mp-code")?.value)) guestJoinFromForm();
    else $("mp-code")?.focus();
    return;
  }
  if (!S?.m?.hand || !$("modal").hidden || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return; // 누르고 있어 반복되는 키는 무시
  const typing = e.target.matches?.("input[type=number]");
  const h = S.m.hand, k = e.key.toLowerCase();
  if (e.key === "Enter") {
    if (typing) { e.preventDefault(); setAmount(raiseAmount()); userAct("raise", raiseAmount()); }
    else if (h.phase === "done" && !e.target.closest?.("button, summary, input")) { e.preventDefault(); ($("next") || $("show-end"))?.click(); }
    return;
  }
  if (typing || h.phase !== "bet" || h.toAct !== ME) return;
  if (k === "f") $("b-fold")?.click();
  else if (k === "c") $("b-call")?.click();
  else if (k === "r") $("b-raise")?.click();
});

// 폰 ↔ 넓은 화면: 자리 배치를 바꾼다
tallMQ.addEventListener?.("change", () => {
  tableKey = "";
  if (S?.m?.hand) render();
  else renderPreview(mode === "host" ? room.n : setup.n);
});

// 화면이 다시 보이면: 연결을 확인하고 화면 꺼짐 방지를 다시 켠다
let pageGone = false; // pagehide에서 연결을 닫았다
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || mode === "solo") return;
  if (pageGone) { location.reload(); return; } // 닫히는 줄 알고 연결을 끊었는데 페이지가 살아 돌아왔다: 새로 연결 (방장은 같은 코드, 손님은 같은 자리)
  if (!net) return;
  if (mode === "host") net.wake();
  else net.check();
  requestWake();
});

// 페이지를 닫거나 떠날 때: 방장은 손님들에게 알리고(새로고침이면 같은 코드로 다시 연다), 손님은 연결을 닫는다
window.addEventListener("pagehide", () => {
  if (!net) return;
  pageGone = true;
  try { net.close(mode === "host" ? "left" : undefined); } catch {}
  net = null;
});
window.addEventListener("pageshow", (e) => { if (e.persisted && mode !== "solo") location.reload(); }); // 뒤로 가기 캐시에서 돌아왔으면 다시 연결

// ===== 시작 =====
function boot() {
  if (netOk()) {
    const code = hashCode();
    if (code) {
      // 같은 방에 들어가 있던 손님의 새로고침: 바로 다시 들어간다 (이 방에서 받은 자리로).
      // 같은 브라우저의 다른 탭이 그 자리에 앉아 있으면 새 손님으로 (이름만 적으면 들어간다)
      if (profile.last?.code === code && Date.now() - profile.last.at < RESUME_MS && profile.name) {
        credFor(code).then((cred) => { if (cred) guestJoin(code, profile.name, true, cred); else bootJoinForm(code); });
        return;
      }
      bootJoinForm(code);
      return;
    }
    // 방장의 새로고침: 저장한 방을 같은 코드로 다시 연다. 다른 탭에서 이미 열려 있으면 열지 않는다 (한 방에 딜러 둘이 되지 않게)
    const saved = loadRoom();
    if (saved) {
      tabProbe("host", saved.room.code).then((busy) => {
        if (!busy) { hostOpen(saved); return; }
        setup.tab = "mp";
        setup.err = `방 ${saved.room.code}은(는) 이 브라우저의 다른 탭에서 열려 있어요. 그 탭에서 계속하세요.`;
        bootSolo();
      });
      return;
    }
  } else if (location.hash.startsWith("#join-")) setup.tab = "mp";
  bootSolo();
}

// 참가 링크로 들어왔다: 이름만 적으면 들어가는 창
function bootJoinForm(code) {
  setup.tab = "mp";
  setup.code = code;
  setup.link = true;
  setup.name = profile.name;
  setup.resume = true;
  S = load();
  if (S) render();
  else renderPreview(setup.n);
  openModal(setupHtml(true), "setup");
  $(profile.name ? "mp-join" : "mp-name")?.focus();
  renderTop();
}

function bootSolo() {
  setup.name = profile.name;
  const saved = load();
  if (saved) {
    S = saved;
    setup.n = S.m.players.length;
    setup.claude = S.claudeOn;
    setup.resume = true;
    render(); // 저장할 때 진행 중이던 차례·카드 펼치기는 이어하기를 누르면 다시 시작된다
    if (S.m.over) showEnd(); // 마지막 핸드 뒤 결과 창을 보기 전에 닫았으면 결과부터
    else openModal(setupHtml(true), "setup");
  } else {
    renderPreview(setup.n);
    openModal(setupHtml(false), "setup");
  }
  renderTop();
}

boot();
