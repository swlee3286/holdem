// 온라인(친구와 하기) 끝까지 테스트 — 진짜 브라우저 여러 개: node test/mp.e2e.js
// 준비: playwright(Chromium 포함)와 peer(PeerJS 시그널링 서버) 패키지가 require로 보여야 한다. 예)
//   npm i --no-save playwright peer && npx playwright install chromium && node test/mp.e2e.js
// 이 테스트가 직접 띄우는 것: 정적 서버(이 폴더) + 로컬 PeerJS 서버. 외부 인터넷은 쓰지 않는다 (Google Fonts는 막는다)
//  A) PeerJS: 방장(넓은 화면) + 손님 2(폰 390x844), 핸드 25개 이상 무작위로 — 모든 화면이 방장과 같은지, 칩 보존,
//     콘솔 오류 · 멈춤 없음, 차례가 아닌 수 · 늦은 수 무시, 시간 초과, 손님이 창을 닫으면 AI가 대신 → 다시 열면 자리 되찾기,
//     매치가 끝나면 모두에게 순위 → 다시 하기
//  B) ?net=local (BroadcastChannel): 같은 브라우저의 탭 2개 — 방장 · 손님 모두 핸드마다 행동에 맞는 소리
//  C) 혼자 하기 회귀: 6명, 핸드 15개
//  D) 방장 새로고침: 같은 코드로 다시 열고 하던 핸드를 잇는다, 손님은 알아서 다시 들어온다 (지난 일의 소리 · 움직임을 다시 틀지 않음)
//  E) 아티팩트 진입 파일(artifact.html, PeerJS 없음 · window.claude 있음): 친구와 하기를 끄고 GitHub 주소 안내
//  F) 소리 · 움직임: 행동마다 맞는 소리(핸드별 개수) · 효과가 끝나면 남지 않음 · 화면 방향 · 다른 탭에서 효과를 지움 ·
//     새로고침 · 이어하기에 소리 없음 · 소리 끄기 버튼(40px · aria-pressed · 새로고침해도 기억) · 동작 줄이기에서 움직임 없음
//  G) 뻥카 읽기: 카드를 정해 둔 핸드에서 쇼다운에 드러난 뻥카 → '뻥카!' 도장 · 기록 줄 · 소리 한 번 · 이번 게임 읽기에 기록,
//     새로고침하면 읽기 그대로 · 새 게임이면 0부터, 동작 줄이기에서는 도장만(움직임 없이), 친구와 하기(?net=local)는 방장 · 손님 모두 같은 표시
const http = require("http");
const fs = require("fs");
const path = require("path");
const netm = require("net");
const { chromium } = require("playwright");
const { PeerServer } = require("peer");
const READS = require("../reads.js");

const ROOT = path.resolve(__dirname, "..");
const HANDS_A = Number(process.env.HANDS_A) || 25;
const HANDS_B = Number(process.env.HANDS_B) || 8;
const HANDS_C = Number(process.env.HANDS_C) || 15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL:", msg); } return !!cond; };
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = mulberry32(Number(process.env.SEED) || 1010);

// ===== 서버 =====
function freePort(lo, hi) {
  return new Promise((res) => {
    const p = lo + Math.floor(Math.random() * (hi - lo));
    const s = netm.createServer().once("error", () => res(freePort(lo, hi))).once("listening", () => s.close(() => res(p))).listen(p, "127.0.0.1");
  });
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
async function staticServer() {
  const port = await freePort(8800, 8999);
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const f = path.join(ROOT, p.endsWith("/") ? p + "index.html" : p);
    if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(buf);
    });
  });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  return { port, close: () => srv.close() };
}

// ===== 페이지 =====
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1280, height: 860 } };
const errors = [];
async function newPage(ctx, tag) {
  const page = await ctx.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); // 외부 글꼴은 막는다 (그 실패는 오류로 치지 않는다)
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource: net::ERR_FAILED/.test(m.text())) errors.push(`${tag} console: ${m.text()}`); });
  page.on("requestfailed", (r) => { if (!/fonts\.(googleapis|gstatic)\.com/.test(r.url())) errors.push(`${tag} request failed: ${r.url()}`); });
  page.tag = tag;
  return page;
}

// 페이지 안의 상태 요약 (game.js의 전역: S · mode · ME · guest · room · modalScreen)
function snap(page) {
  return page.evaluate(() => {
    if (typeof S === "undefined" || !S || !S.m || !S.m.hand) return { none: true, modal: document.getElementById("modal").hidden ? "" : modalScreen || "other" };
    const h = S.m.hand, m = S.m;
    return {
      mode, me: ME, no: h.no, n: h.actions.length, phase: h.phase, street: h.street, toAct: h.toAct, match: S.matchId || "",
      board: h.board.slice(), pot: PokerTable.potTotal(h), stacks: m.players.map((p) => p.stack), over: m.over, handNo: m.handNo,
      // 손님 화면에 보이지 않아야 할 카드가 있는지
      hiddenOk: mode !== "guest" || h.seats.filter((s) => s !== ME && !h.shown[s]).every((s) => !h.hole[s] || h.hole[s].every((c) => c === null)),
      mine: document.getElementById("controls").classList.contains("mine"),
      btnCall: !!document.getElementById("b-call") && !document.getElementById("b-call").disabled,
      pending: mode === "guest" ? !!guest.pending : false,
      modal: document.getElementById("modal").hidden ? "" : modalScreen || "other",
      domPot: document.querySelector("#pot b")?.textContent ?? "",
      domBoard: [...document.querySelectorAll("#board .card")].map((c) => c.dataset.k).filter((k) => k !== "slot"),
      out: m.players[ME].out, ended: S.ended,
      online: m.players.map((_, s) => seatOnline(s)),
      away: [...document.querySelectorAll(".seat.away")].map((e) => Number(e.id.slice(5))),
      standings: document.querySelectorAll("#modal-card .standings li").length,
      fxErr: typeof PokerMotion === "object" ? PokerMotion.stats.errors : -1,
    };
  });
}
const keyOf = (s) => (s && !s.none ? `${s.match}|${s.no}|${s.n}|${s.phase}|${s.street}|${s.board.length}` : "");
const fmt = (n) => Number(n).toLocaleString("ko-KR");

// 내 차례면 무작위로 둔다 (가끔 레이즈, 올인은 드물게). shove: 매치를 빨리 끝내려고 주로 올인
let shove = false;
async function randomMove(page) {
  const o = await page.evaluate(() => ({
    fold: !!document.getElementById("b-fold") && !document.getElementById("b-fold").disabled,
    raise: !!document.getElementById("b-raise") && !document.getElementById("b-raise").disabled,
    presets: document.querySelectorAll(".preset").length,
  }));
  const r = R();
  if (shove && o.raise && r < 0.8) {
    if (o.presets) await page.click(`.preset >> nth=${o.presets - 1}`);
    await page.click("#b-raise");
  } else if (shove) await page.click("#b-call");
  else if (o.raise && r < 0.18) {
    if (o.presets > 1 && R() < 0.8) await page.click(`.preset >> nth=${Math.floor(R() * (o.presets - 1))}`); // 마지막(올인)은 빼고
    await page.click("#b-raise");
  } else if (o.fold && r < 0.32) await page.click("#b-fold");
  else await page.click("#b-call");
}

// ===== 여러 화면 비교 · 진행 =====
// players: [{page, seat, role}] (첫 번째가 방장). 각 화면의 상태가 방장과 같은 시점이면 내용도 같아야 한다
function makeDriver(N) {
  const st = { compared: 0, mismatch: 0, conservation: 0, moves: 0, seenTurn: new Map(), lastKey: "", lastChange: Date.now(), hands: new Set() };
  async function step(players, { noMoveSeats = [] } = {}) {
    const hostP = players[0];
    const hs = await snap(hostP.page);
    if (hs.none) return { hs };
    // 칩 보존 (방장)
    const total = hs.stacks.reduce((a, b) => a + b, 0) + (hs.phase === "done" ? 0 : hs.pot);
    st.conservation++;
    ok(total === N * 2000, `칩 보존 ${total} (hand ${hs.no}, ${hs.phase})`);
    st.hands.add(`${hs.match}|${hs.no}`);
    const k = keyOf(hs);
    if (k !== st.lastKey) { st.lastKey = k; st.lastChange = Date.now(); }
    const snaps = [hs];
    for (const p of players.slice(1)) {
      if (p.page.isClosed()) { snaps.push(null); continue; }
      const s = await snap(p.page);
      snaps.push(s);
      if (s.none) continue;
      ok(s.hiddenOk, `${p.page.tag}: 남의 카드가 손님 화면에 있음`);
      ok(s.fxErr === 0, `${p.page.tag}: 움직임 오류 ${s.fxErr}`);
      if (keyOf(s) === k) {
        st.compared++;
        const same = JSON.stringify(s.board) === JSON.stringify(hs.board) && s.pot === hs.pot && JSON.stringify(s.stacks) === JSON.stringify(hs.stacks) && s.toAct === hs.toAct
          && JSON.stringify(s.domBoard) === JSON.stringify(hs.board.map(String)) && (hs.phase === "done" || s.domPot === fmt(hs.pot));
        if (!same) { st.mismatch++; ok(false, `${p.page.tag} 화면이 방장과 다름: ${JSON.stringify({ g: [s.board, s.pot, s.stacks, s.toAct, s.domBoard, s.domPot], h: [hs.board, hs.pot, hs.stacks, hs.toAct] })}`); }
      }
    }
    // 내 차례인 화면에서 둔다 (버튼이 뜨고 0.45초 뒤 — 게임의 연타 방지 시간보다 길게)
    if (hs.phase === "bet") {
      const i = players.findIndex((p) => p.seat === hs.toAct);
      const s = snaps[i];
      if (i >= 0 && s && !s.none && keyOf(s) === k && s.mine && s.btnCall && !s.pending && !s.modal && !noMoveSeats.includes(hs.toAct)) {
        const tk = `${players[i].page.tag}|${k}`;
        if (!st.seenTurn.has(tk)) st.seenTurn.set(tk, Date.now());
        else if (Date.now() - st.seenTurn.get(tk) > 450) {
          st.seenTurn.delete(tk);
          await randomMove(players[i].page);
          st.moves++;
        }
      }
    }
    // 창 처리: 탈락하면 계속 지켜보기
    for (let i = 0; i < players.length; i++) {
      const s = snaps[i];
      if (s && !s.none && s.modal === "end" && !s.over) await players[i].page.click("#m-watch");
    }
    ok(Date.now() - st.lastChange < 45000, `멈춤: 45초 동안 방장 상태가 그대로 (${k})`);
    return { hs, snaps };
  }
  return { st, step };
}

async function joinGuest(ctx, base, code, name, tag) {
  const page = await newPage(ctx, tag);
  await page.goto(`${base}#join-${code}`);
  await page.waitForSelector("#mp-name");
  await page.fill("#mp-name", name);
  await page.click("#mp-join");
  return page;
}

// ===== A) PeerJS: 방장 + 손님 2 =====
async function scenarioA(browser, web) {
  console.log("A) PeerJS: 방장 + 손님 2 (폰)");
  const pport = await freePort(9100, 9199);
  let psServer = null;
  PeerServer({ port: pport, host: "127.0.0.1", path: "/myapp" }, (srv) => { psServer = srv; });
  await sleep(500);
  const pq = `peerHost=127.0.0.1&peerPort=${pport}&peerPath=/myapp&peerSecure=0`;
  const base = `http://127.0.0.1:${web.port}/index.html?${pq}`;
  const hctx = await browser.newContext(DESKTOP);
  const host = await newPage(hctx, "host");
  await host.goto(`${base}&turnSec=6&nextSec=1`);
  await host.click("#tab-mp");
  await host.fill("#mp-name", "방장");
  await host.click("#mp-host");
  await host.waitForFunction(() => room && room.ready, null, { timeout: 20000 });
  const code = await host.evaluate(() => room.code);
  ok(/^[A-Z2-9]{5}$/.test(code), "방 코드 " + code);
  ok((await host.textContent("#room-code")).trim() === code, "로비에 코드가 크게");
  ok((await host.inputValue("#mp-url")).endsWith(`#join-${code}`), "참가 링크");
  await host.click("[data-mpn='4']");
  const g1ctx = await browser.newContext(MOBILE), g2ctx = await browser.newContext(MOBILE);
  // 손님1의 데이터 채널을 잡아 둔다 (조용히 끊기는 상황을 흉내 내려고). webrtc-adapter가 채널마다 send를 따로 감싸서 프로토타입으로는 못 막는다
  await g1ctx.addInitScript(() => {
    const orig = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...a) { const dc = orig.apply(this, a); (window.__dcs ||= []).push(dc); return dc; };
  });
  let g1 = await joinGuest(g1ctx, base, code, "민지", "g1");
  await host.waitForFunction(() => room.guests.length === 1 && room.guests[0].connected, null, { timeout: 25000 });
  let g2 = await joinGuest(g2ctx, base, code, "<b>준호</b>", "g2"); // 이름에 꺾쇠: 화면에 글자 그대로 나와야 한다
  await host.waitForFunction(() => room.guests.length === 2 && room.guests.every((g) => g.connected), null, { timeout: 25000 });
  await g2.waitForFunction(() => modalScreen === "wait" && guest.lobby && guest.lobby.players.length === 4, null, { timeout: 10000 });
  ok((await g2.textContent("#modal-card .lobby")).includes("<b>준호</b>"), "꺾쇠 이름이 글자 그대로 (escape)");
  ok((await host.$$eval("#modal-card .lobby li", (l) => l.length)) === 4, "방장 로비 목록 4줄");
  await host.click("#mp-start");
  await Promise.all([g1, g2].map((p) => p.waitForFunction(() => S && S.m && S.m.hand && modalScreen === "", null, { timeout: 15000 })));
  const seat1 = await g1.evaluate(() => ME), seat2 = await g2.evaluate(() => ME);
  ok(seat1 === 1 && seat2 === 2, `좌석 ${seat1}, ${seat2}`);
  ok(await g1.evaluate(() => document.querySelector("#seat-1").classList.contains("me")), "손님 화면: 내 자리가 '나'");
  const players = [{ page: host, seat: 0 }, { page: g1, seat: seat1 }, { page: g2, seat: seat2 }];
  const D = makeDriver(4);
  const t0 = Date.now();
  const done = { outOfTurn: false, stale: false, timeout: false, closed: false, autoSeen: false, reopened: false, silent: false, again: 0 };
  let closedAt = 0, againAt = 0;
  while (Date.now() - t0 < 9 * 60000 && fails < 20) {
    const { hs } = await D.step(players, { noMoveSeats: done.outOfTurn && !done.timeout && D.st.hands.size >= 5 ? [seat2] : [] });
    if (hs.none) { await sleep(150); continue; }
    const handsPlayed = D.st.hands.size;
    // 차례가 아닌 수: 방장 차례에 손님이 폴드·레이즈를 보낸다 → 무시
    if (!done.outOfTurn && handsPlayed >= 2 && hs.phase === "bet" && hs.toAct === 0) {
      done.outOfTurn = true;
      await g1.evaluate(({ no, n }) => { net.send({ t: "act", hand: no, n, type: "fold" }); net.send({ t: "act", hand: no, n, type: "raise", to: 500 }); }, hs);
      await sleep(1200);
      const after = await snap(host);
      ok(after.n === hs.n && after.toAct === 0 && after.no === hs.no, `차례가 아닌 수가 무시되지 않음 ${hs.n}→${after.n}`);
      continue;
    }
    // 늦은 수: 손님 차례에 지난 시점(n-1)으로 보낸다 → 무시
    if (!done.stale && handsPlayed >= 3 && hs.phase === "bet" && hs.toAct === seat1) {
      done.stale = true;
      await g1.evaluate(({ no, n }) => net.send({ t: "act", hand: no, n: n - 1, type: "call" }), hs);
      await sleep(800);
      const after = await snap(host);
      ok(after.n === hs.n && after.toAct === seat1, `늦은 수가 무시되지 않음 ${hs.n}→${after.n}`);
      continue;
    }
    // 시간 초과: 손님2가 두지 않으면 6초 뒤 체크 또는 폴드
    if (done.outOfTurn && !done.timeout && handsPlayed >= 5 && hs.phase === "bet" && hs.toAct === seat2) {
      const before = hs.n, waitStart = Date.now();
      let after = hs;
      while (Date.now() - waitStart < 12000) {
        await sleep(300);
        after = await snap(host);
        if (after.n !== before || after.no !== hs.no) break;
      }
      const acts = await host.evaluate(({ no, before }) => (S.m.hand.no === no ? S.m.hand.actions.slice(before) : []), { no: hs.no, before });
      const t = acts.find((a) => a.seat === seat2);
      ok(t && t.timeout && (t.type === "check" || t.type === "fold"), `시간 초과 자동 행동 ${JSON.stringify(t)}`);
      ok(Date.now() - waitStart > 4000, "시간 초과가 너무 빨리");
      done.timeout = true;
      continue;
    }
    // 손님2가 핸드 중에 창을 닫는다 → AI가 대신 → 같은 브라우저(같은 토큰)로 다시 연다 → 자리 되찾기
    if (done.timeout && !done.closed && hs.phase === "bet" && hs.toAct !== seat2 && !hs.stacks.every((x, s) => s !== seat2 || x === 0)) {
      const inHand = await host.evaluate((s) => S.m.hand.seats.includes(s) && !S.m.hand.folded[s] && S.m.players[s].stack > 0, seat2);
      if (inHand) {
        done.closed = true;
        closedAt = Date.now();
        await g2.close();
        players[2] = { page: g2, seat: seat2 };
        await host.waitForFunction((s) => !seatOnline(s), seat2, { timeout: 20000 });
        console.log(`   손님2 닫음 → ${((Date.now() - closedAt) / 1000).toFixed(1)}초 뒤 방장이 끊김을 앎`);
        await g1.waitForFunction((s) => document.querySelector(`#seat-${s}`)?.classList.contains("away"), seat2, { timeout: 10000 });
        ok(await g1.evaluate((s) => !document.getElementById(`away-${s}`).hidden, seat2), "손님1 화면: 연결 끊김 · AI가 대신");
        continue;
      }
    }
    if (done.closed && !done.autoSeen) {
      const auto = await host.evaluate((s) => S.history.length >= 0 && S.m.hand.actions.some((a) => a.seat === s && a.auto), seat2);
      const out = await host.evaluate((s) => S.m.players[s].out, seat2);
      if (auto || out) {
        done.autoSeen = true;
        ok(auto || out, "끊긴 자리를 AI가 대신 둠");
        console.log(`   AI가 손님2 자리를 대신 둠${out ? " (탈락)" : ""}`);
        g2 = await newPage(g2ctx, "g2b");
        await g2.goto(`${base}#join-${code}`); // 같은 브라우저 = 같은 토큰 → 바로 다시 들어간다
        await g2.waitForFunction(() => typeof S !== "undefined" && S && S.m && S.m.hand && mode === "guest", null, { timeout: 30000 });
        await host.waitForFunction((s) => seatOnline(s), seat2, { timeout: 10000 });
        ok((await g2.evaluate(() => ME)) === seat2, "다시 연 손님이 같은 자리를 되찾음");
        players[2] = { page: g2, seat: seat2 };
        done.reopened = true;
        console.log("   손님2 다시 열기 → 같은 자리");
        continue;
      }
    }
    // 조용히 끊긴 손님 (창은 열려 있는데 아무것도 못 보냄 — 폰이 네트워크를 잃은 것처럼): 10초 뒤 방장이 끊긴 것으로 보고 AI가 대신,
    // 다시 보낼 수 있게 되면 방장이 닫은 연결을 알아채고 다시 들어와 자리를 되찾는다
    if (done.reopened && !done.silent && hs.phase === "bet") {
      done.silent = true;
      const t1 = Date.now();
      await g1.evaluate(() => { window.__silent = true; for (const dc of window.__dcs) { if (!dc.__send) dc.__send = dc.send; dc.send = function (...a) { return window.__silent ? undefined : dc.__send.apply(dc, a); }; } });
      await host.waitForFunction((s) => !seatOnline(s), seat1, { timeout: 30000 });
      const lag = (Date.now() - t1) / 1000;
      ok(lag > 5 && lag < 16, `조용한 손님을 끊긴 것으로 보는 데 ${lag.toFixed(1)}초`);
      await g1.evaluate(() => { window.__silent = false; });
      await host.waitForFunction((s) => seatOnline(s), seat1, { timeout: 30000 });
      await g1.waitForFunction(() => guest.status === "open", null, { timeout: 10000 });
      ok((await g1.evaluate(() => ME)) === seat1, "조용히 끊겼던 손님이 같은 자리로");
      console.log(`   조용한 손님: ${lag.toFixed(1)}초 뒤 끊김 처리 → 다시 연결 ${((Date.now() - t1) / 1000).toFixed(1)}초`);
      continue;
    }
    // 매치가 끝나면: 모두에게 순위, 방장이 다시 하기
    if (hs.over) {
      await sleep(2200);
      for (const p of players) {
        if (p.page.isClosed()) continue;
        const s = await snap(p.page);
        ok(s.modal === "end" && s.standings === 4, `${p.page.tag}: 최종 순위 창 (${s.modal}, ${s.standings})`);
      }
      if (done.again) break;
      await host.click("#m-again");
      done.again++;
      shove = false;
      const old = hs.match;
      for (const p of players.slice(1)) if (!p.page.isClosed()) await p.page.waitForFunction((m) => S.matchId !== m && modalScreen === "", old, { timeout: 15000 });
      ok((await g1.evaluate(() => S.m.handNo)) <= 2 && (await g1.evaluate(() => S.history.length)) <= 1, "다시 하기: 손님도 새 매치 (핸드 번호 · 기록 처음부터)");
      console.log(`   매치 끝 (${handsPlayed}핸드) → 모두 순위 창 → 다시 하기 → 손님도 새 매치`);
      againAt = handsPlayed;
      continue;
    }
    // 목표 핸드를 채우면 올인 위주로 매치를 끝내고(끝 창 · 다시 하기 확인), 새 매치에서 두 핸드 더
    if (handsPlayed >= HANDS_A && done.silent && !done.again) shove = true;
    if (done.again && handsPlayed >= Math.max(againAt + 2, HANDS_A) && hs.phase === "done") break; // 매치가 일찍 끝났으면 새 매치에서 목표 핸드까지
    await sleep(120);
  }
  const s = D.st;
  console.log(`   핸드 ${s.hands.size}, 사람 수 ${s.moves}, 화면 비교 ${s.compared} (다름 ${s.mismatch}), 칩 보존 확인 ${s.conservation}, 다시 하기 ${done.again}`);
  ok(s.hands.size >= HANDS_A, `핸드 수 ${s.hands.size}`);
  ok(s.compared > 100 && s.mismatch === 0, `화면 비교 ${s.compared} 다름 ${s.mismatch}`);
  ok(done.outOfTurn && done.stale && done.timeout && done.closed && done.autoSeen && done.reopened && done.silent && done.again, "시나리오 모두 실행 " + JSON.stringify(done));
  // 방장이 방을 닫으면 손님은 알림을 본다
  if (await host.$("#modal:not([hidden]) #mp-close")) await host.click("#mp-close"); // 끝 창에 있는 '방 닫기'
  else { await host.click("#new-game"); await host.click("#mp-close"); }
  await g1.waitForFunction(() => modalScreen === "ended" || (mode === "solo" && modalScreen === "setup"), null, { timeout: 15000 });
  ok((await g1.textContent("#modal-card h1")).includes("방"), "방을 닫으면 손님에게 알림");
  await hctx.close(); await g1ctx.close(); await g2ctx.close();
  shove = false;
  if (psServer) psServer.close();
}

// ===== B) ?net=local: 같은 브라우저의 탭 2개 =====
async function scenarioB(browser, web) {
  console.log("B) ?net=local (BroadcastChannel): 탭 2개");
  const base = `http://127.0.0.1:${web.port}/index.html?net=local`;
  const ctx = await browser.newContext(DESKTOP);
  await ctx.addInitScript(soundHook); // 방장 · 손님 모두 소리 기록
  const host = await newPage(ctx, "Bhost");
  await host.goto(`${base}&nextSec=1`);
  await host.click("#tab-mp");
  await host.fill("#mp-name", "탭방장");
  await host.click("#mp-host");
  await host.waitForFunction(() => room && room.ready, null, { timeout: 10000 });
  await host.click("[data-mpn='3']");
  const code = await host.evaluate(() => room.code);
  const g = await joinGuest(ctx, base, code, "탭손님", "Bguest");
  await g.setViewportSize({ width: 390, height: 844 });
  await host.waitForFunction(() => room.guests.length === 1 && room.guests[0].connected, null, { timeout: 10000 });
  await host.click("#mp-start");
  await g.waitForFunction(() => S && S.m && S.m.hand && modalScreen === "", null, { timeout: 10000 });
  const players = [{ page: host, seat: 0 }, { page: g, seat: await g.evaluate(() => ME) }];
  const D = makeDriver(3);
  const t0 = Date.now();
  while (Date.now() - t0 < 4 * 60000 && fails < 20) {
    const { hs } = await D.step(players);
    if (hs.none) { await sleep(150); continue; }
    if (hs.over || (D.st.hands.size >= HANDS_B && hs.phase === "done")) break;
    await sleep(120);
  }
  const s = D.st;
  console.log(`   핸드 ${s.hands.size}, 사람 수 ${s.moves}, 화면 비교 ${s.compared} (다름 ${s.mismatch})`);
  ok(s.hands.size >= HANDS_B || s.compared > 20, `local 핸드 수 ${s.hands.size}`);
  ok(s.compared > 20 && s.mismatch === 0, `local 화면 비교 ${s.compared} 다름 ${s.mismatch}`);
  // 소리: 방장 · 손님 모두 핸드마다 행동 수만큼 (손님은 받은 화면만으로), 끝난 뒤 남은 효과 없음
  const hh = await checkMpSounds(host, "Bhost"), gh = await checkMpSounds(g, "Bguest");
  const gs = await g.evaluate(() => ({ fresh: PokerMotion.stats.fresh, played: PokerMotion.stats.played, deal: __snd.filter((x) => x.n === "deal").length, turn: __snd.filter((x) => x.n === "turn").length }));
  console.log(`   소리 확인: 방장 ${hh}핸드, 손님 ${gh}핸드 ${JSON.stringify(gs)}`);
  ok(hh >= 3 && gh >= 3 && gs.fresh === 1 && gs.deal > 0 && gs.turn > 0, `local 소리 확인 ${hh}/${gh} ${JSON.stringify(gs)}`);
  await ctx.close();
}

// ===== C) 혼자 하기 회귀 =====
async function scenarioC(browser, web) {
  console.log("C) 혼자 하기 6명");
  const ctx = await browser.newContext(DESKTOP);
  const page = await newPage(ctx, "solo");
  await page.goto(`http://127.0.0.1:${web.port}/index.html`);
  await page.click("[data-count='6']");
  await page.click("#m-start");
  const hands = new Set();
  let moves = 0, seen = "", seenAt = 0, again = 0;
  const t0 = Date.now();
  while (hands.size < HANDS_C && Date.now() - t0 < 4 * 60000 && fails < 20) {
    const s = await page.evaluate(() => ({
      no: S.m.hand.no, n: S.m.hand.actions.length, phase: S.m.hand.phase, toAct: S.m.hand.toAct, mode, mine: document.getElementById("controls").classList.contains("mine"),
      modal: !document.getElementById("modal").hidden, over: S.m.over, out: S.m.players[0].out, fast,
      total: S.m.players.reduce((t, p) => t + p.stack, 0) + (S.m.hand.phase === "done" ? 0 : PokerTable.potTotal(S.m.hand)),
    }));
    ok(s.mode === "solo" && s.total === 12000, `혼자 하기 상태 ${JSON.stringify(s)}`);
    hands.add(`${again}|${s.no}`);
    // 탈락하면 계속 지켜보기(빨리 감기), 매치가 끝나면 다시 하기 (새 매치는 핸드 번호가 1부터라 따로 센다)
    if (s.modal) {
      const b = (await page.$("#m-watch")) || (await page.$("#m-again"));
      if (b) { if ((await b.getAttribute("id")) === "m-again") again++; await b.click(); }
      await sleep(200);
      continue;
    }
    if (s.phase === "bet" && s.toAct === 0 && s.mine) {
      const k = `${s.no}|${s.n}`;
      if (seen !== k) { seen = k; seenAt = Date.now(); }
      else if (Date.now() - seenAt > 450) { await randomMove(page); moves++; }
    } else if (s.phase === "done") {
      await sleep(250);
      // 탈락 · 우승 창이 1.6초 뒤 그 위에 뜰 수 있다: 그때는 다음 바퀴에서 창부터 처리한다
      const nx = await page.$("#next");
      if (nx && await page.evaluate(() => document.getElementById("modal").hidden)) await nx.click({ timeout: 3000 }).catch(() => {});
    } else if (s.out && !s.fast) {
      const ff = await page.$("#fast");
      if (ff) await ff.click({ timeout: 3000 }).catch(() => {});
    }
    await sleep(120);
  }
  console.log(`   핸드 ${hands.size}, 내 수 ${moves}`);
  ok(hands.size >= HANDS_C, `혼자 하기 핸드 수 ${hands.size}`);
  // 이번 게임 읽기: 끝난 핸드마다 한 번씩 (지금 핸드가 끝났으면 그것까지)
  const rd = await page.evaluate(() => ({ ok: PokerReads.valid(S.reads, S.m.players.length), last: S.reads.last, hands: S.reads.hands, no: S.m.hand.no, done: S.m.hand.phase === "done" }));
  ok(rd.ok && rd.last === (rd.done ? rd.no : rd.no - 1) && rd.hands === rd.last, "혼자 하기 읽기 기록 " + JSON.stringify(rd));
  await ctx.close();
}

// ===== D) 방장 새로고침 =====
async function scenarioD(browser, web) {
  console.log("D) 방장 새로고침 → 같은 코드로 이어서");
  const pport = await freePort(9100, 9199);
  let psServer = null;
  PeerServer({ port: pport, host: "127.0.0.1", path: "/myapp" }, (srv) => { psServer = srv; });
  await sleep(500);
  const base = `http://127.0.0.1:${web.port}/index.html?peerHost=127.0.0.1&peerPort=${pport}&peerPath=/myapp&peerSecure=0`;
  const hctx = await browser.newContext(DESKTOP);
  await hctx.addInitScript(soundHook);
  const host = await newPage(hctx, "Dhost");
  await host.goto(`${base}&nextSec=1`);
  await host.click("#tab-mp");
  await host.fill("#mp-name", "방장D");
  await host.click("#mp-host");
  await host.waitForFunction(() => room && room.ready, null, { timeout: 20000 });
  await host.click("[data-mpn='3']");
  const code = await host.evaluate(() => room.code);
  const gctx = await browser.newContext(MOBILE);
  await gctx.addInitScript(soundHook);
  const g = await joinGuest(gctx, base, code, "손님D", "Dguest");
  await host.waitForFunction(() => room.guests.length === 1 && room.guests[0].connected, null, { timeout: 25000 });
  await host.click("#mp-start");
  await g.waitForFunction(() => S && S.m && S.m.hand && modalScreen === "", null, { timeout: 15000 });
  const players = [{ page: host, seat: 0 }, { page: g, seat: 1 }];
  const D = makeDriver(3);
  let t0 = Date.now(), before = null;
  while (Date.now() - t0 < 120000) {
    const { hs } = await D.step(players);
    if (!hs.none && D.st.hands.size >= 2 && hs.phase === "bet" && hs.street >= 1) { before = hs; break; }
    await sleep(120);
  }
  ok(before, "새로고침 전 상태");
  if (!before) return;
  const rebased0 = await g.evaluate(() => PokerMotion.stats.rebased);
  await host.reload();
  const t1 = Date.now();
  await host.waitForFunction(() => mode === "host" && room && room.ready && modalScreen !== "resume", null, { timeout: 30000 });
  const after = await snap(host);
  ok((await host.evaluate(() => room.code)) === code, "같은 방 코드로 다시 열림");
  ok(after.no === before.no && after.n >= before.n && JSON.stringify(after.board.slice(0, before.board.length)) === JSON.stringify(before.board), `하던 핸드를 이어서 (${before.no}/${before.n} → ${after.no}/${after.n})`);
  await host.waitForFunction(() => room.guests[0].connected, null, { timeout: 40000 });
  await g.waitForFunction(() => guest.status === "open" && modalScreen === "" && S.m.hand.no >= 1, null, { timeout: 20000 });
  console.log(`   방장 새로고침 → ${((Date.now() - t1) / 1000).toFixed(1)}초 뒤 손님까지 다시 연결`);
  // 다시 연 방장 · 다시 들어온 손님: 지난 일을 다시 틀지 않는다 (이어 받은 핸드의 카드 나눠 주기 소리 없음, 손님은 기준만 다시 잡음)
  const hs0 = await host.evaluate((no) => ({ deal: __snd.filter((x) => x.no === no && x.n === "deal").length, anim: __anim }), before.no);
  const g0 = await g.evaluate(() => PokerMotion.stats.rebased);
  ok(hs0.deal === 0 && g0 > rebased0, `새로고침 · 다시 연결 뒤 지난 일을 다시 틀지 않음 ${JSON.stringify({ host: hs0, rebased: [rebased0, g0] })}`);
  const resumedNo = await host.evaluate(() => S.m.hand.no);
  t0 = Date.now();
  const startHands = D.st.hands.size;
  while (Date.now() - t0 < 120000) {
    const { hs } = await D.step(players);
    if (!hs.none && (hs.over || (D.st.hands.size >= startHands + 2 && hs.phase === "done"))) break;
    await sleep(120);
  }
  ok(D.st.hands.size >= startHands + 2 && D.st.mismatch === 0, `새로고침 뒤 계속 (핸드 ${D.st.hands.size}, 비교 ${D.st.compared}, 다름 ${D.st.mismatch})`);
  const dh = await checkMpSounds(host, "Dhost", resumedNo + 1), dg = await checkMpSounds(g, "Dguest", resumedNo + 1);
  ok(dh >= 1 && dg >= 1, `새로고침 뒤 핸드 소리 확인 ${dh}/${dg}`);
  await hctx.close(); await gctx.close();
  if (psServer) psServer.close();
}

// ===== E) 아티팩트 진입 파일 =====
async function scenarioE(browser, web) {
  console.log("E) artifact.html: 친구와 하기 꺼짐");
  const ctx = await browser.newContext(MOBILE);
  await ctx.addInitScript(() => { window.claude = { use: async () => { throw { code: "not_granted" }; } }; });
  const page = await newPage(ctx, "artifact");
  await page.goto(`http://127.0.0.1:${web.port}/artifact.html`);
  await page.click("#tab-mp");
  const info = await page.evaluate(() => ({ peer: typeof Peer, net: typeof PokerNet, host: !!document.getElementById("mp-host"), text: document.getElementById("modal-card").textContent }));
  ok(info.peer === "undefined" && info.net === "object" && !info.host && info.text.includes("swlee3286.github.io/holdem"), "아티팩트: PeerJS 없음 · 방 만들기 없음 · GitHub 주소 안내 " + JSON.stringify({ ...info, text: info.text.slice(0, 40) }));
  await page.click("#tab-solo");
  await page.click("#m-start");
  await page.waitForFunction(() => S && S.m.hand && mode === "solo", null, { timeout: 5000 });
  await ctx.close();
}

// ===== F) 소리 · 움직임 =====
// PokerSound.play를 감싸 어떤 소리가 어느 매치 · 핸드에서 났는지 기록한다 (오디오가 깨어나지 않아도 부른 것은 남는다).
// 핸드마다 행동 목록도 0.1초마다 베껴 둔다 (손님은 화면을 받을 때마다 핸드 객체가 바뀐다)
function soundHook() {
  window.__snd = [];
  window.__hands = {};
  window.__anim = 0;
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...a) { window.__anim++; return animate.apply(this, a); };
  const where = () => { try { return S && S.m && S.m.hand ? { m: S.matchId || "", no: S.m.hand.no } : { m: "", no: 0 }; } catch { return { m: "", no: 0 }; } };
  let real;
  Object.defineProperty(window, "PokerSound", {
    configurable: true,
    get() { return real; },
    set(v) {
      const play = v.play;
      v.play = (n) => { window.__snd.push({ n, ...where() }); return play(n); };
      real = v;
    },
  });
  setInterval(() => {
    try {
      if (!S || !S.m || !S.m.hand) return;
      const h = S.m.hand;
      window.__hands[`${S.matchId || ""}|${h.no}`] = { no: h.no, m: S.matchId || "", me: ME, seats: h.seats.slice(), actions: h.actions.map((a) => ({ seat: a.seat, type: a.type, allin: !!a.allin })) };
    } catch {}
  }, 100);
}
// 핸드 하나에서 행동마다 나야 하는 소리 개수 (me = 내 좌석): 카드 나눠 주기 · 체크 · 벳/블라인드(chip) · 콜 · 레이즈 · 올인 · 폴드 · 내 차례
function actionSounds(h, me) {
  const e = { deal: 2 * h.seats.length };
  const add = (k) => { e[k] = (e[k] || 0) + 1; };
  for (const a of h.actions) {
    if (a.type === "return") continue;
    if (a.type !== "fold" && a.allin) add("allin");
    else add(a.type === "sb" || a.type === "bb" || a.type === "bet" ? "chip" : a.type);
    if (a.seat === me && a.type !== "sb" && a.type !== "bb") add("turn"); // 내 차례마다 알림 한 번
  }
  return e;
}
// 혼자 하기: 끝난 핸드 하나의 소리 전부 (팟 · 보드 · 공개 · 탈락까지)
function expectedSounds(h, me, busted) {
  const e = { ...actionSounds(h, me), flip: h.board.length, bust: busted ? 1 : 0 };
  const add = (k) => { e[k] = (e[k] || 0) + 1; };
  const won = h.result.pots.some((p) => p.winners.includes(me));
  if (won) add("win");
  for (let i = 0; i < h.result.pots.length - (won ? 1 : 0); i++) add("chip"); // 팟이 이긴 사람에게 갈 때
  if (h.seats.some((s) => s !== me && !h.folded[s] && h.shown[s])) add("flip"); // 남의 카드 공개
  if (READS.revealed(h).some((x) => x.label === "bluff" && x.weakEnd && !(h.result.won[x.seat] > 0))) add("bluff"); // 쇼다운에서 들킨 뻥카 (팟을 못 가져간 자리, 핸드에 한 번)
  return e;
}
const countBy = (list) => list.reduce((c, x) => ((c[x] = (c[x] || 0) + 1), c), {});
// 친구와 하기: 끝난 핸드마다 행동 소리가 행동 수와 같은지 (다음 핸드가 1초 뒤 시작해 팟 소리는 잘릴 수 있어 칩은 '이상'만).
// minNo: 이 핸드부터 (새로고침 · 다시 연결로 중간부터 본 핸드는 뺀다)
async function checkMpSounds(page, tag, minNo = 0) {
  const r = await page.evaluate(() => ({ cur: `${S.matchId || ""}|${S.m.hand.no}`, hands: __hands, snd: __snd }));
  let hands = 0;
  for (const [key, h] of Object.entries(r.hands)) {
    if (key === r.cur || h.no < minNo) continue;
    const got = countBy(r.snd.filter((x) => `${x.m}|${x.no}` === key).map((x) => x.n)), exp = actionSounds(h, h.me);
    const diff = ["deal", "check", "call", "raise", "allin", "fold", "turn"].filter((k) => (exp[k] || 0) !== (got[k] || 0));
    if ((got.chip || 0) < (exp.chip || 0)) diff.push("chip");
    ok(!diff.length, `${tag} 핸드 ${h.no} 소리: ${diff.map((k) => `${k} ${got[k] || 0}/${exp[k] || 0}`).join(", ")}`);
    hands++;
  }
  return hands;
}
const fxState = (page) => page.evaluate(() => ({
  fx: document.querySelector(".fx-layer")?.childElementCount || 0, active: PokerMotion.active(),
  waapi: document.getAnimations().filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition)).length,
  errors: PokerMotion.stats.errors,
}));

async function scenarioF(browser, web) {
  console.log("F) 소리 · 움직임");
  const base = `http://127.0.0.1:${web.port}/index.html`;
  const ctx = await browser.newContext(MOBILE);
  await ctx.addInitScript(soundHook);
  const page = await newPage(ctx, "fx");
  await page.goto(base);
  const btn = () => page.evaluate(() => { const b = document.getElementById("sound"), r = b.getBoundingClientRect(); return { pressed: b.getAttribute("aria-pressed"), label: b.getAttribute("aria-label"), svg: !!b.querySelector("svg"), w: r.width, h: r.height, muted: PokerSound.isMuted() }; });
  const b0 = await btn();
  ok(b0.pressed === "true" && b0.label === "소리" && b0.svg && b0.w >= 40 && b0.h >= 40 && !b0.muted, "소리 버튼: 켜짐 · 이름 · 아이콘 · 40px " + JSON.stringify(b0));
  ok((await page.evaluate(() => __snd.length)) === 0, "첫 화면에 소리 없음");
  await page.click("[data-count='4']");
  await page.click("#m-start");
  let checked = 0, moves = 0, seen = "", seenAt = 0, lastDone = 0, resized = false, hidden = false;
  const skip = new Set(); // 다른 탭 흉내를 낸 핸드: 예약한 소리를 일부러 지웠다
  const t0 = Date.now();
  while (checked < 4 && Date.now() - t0 < 180000 && fails < 20) {
    const s = await page.evaluate(() => ({ no: S.m.hand.no, n: S.m.hand.actions.length, phase: S.m.hand.phase, toAct: S.m.hand.toAct, mine: document.getElementById("controls").classList.contains("mine"), modal: !document.getElementById("modal").hidden }));
    if (s.modal) { const b = (await page.$("#m-watch")) || (await page.$("#m-again")); if (b) await b.click(); await sleep(200); continue; }
    if (s.phase === "bet" && s.toAct === 0 && s.mine) {
      const k = `${s.no}|${s.n}`;
      if (seen !== k) { seen = k; seenAt = Date.now(); } else if (Date.now() - seenAt > 450) { await randomMove(page); moves++; }
    } else if (s.phase === "done") {
      if (lastDone !== s.no) {
        lastDone = s.no;
        // 팟이 다 날아가고 예약한 소리가 다 날 때까지 (효과는 진행을 막지 않으므로 기다리는 것은 테스트뿐)
        await page.waitForFunction(() => PokerMotion.active() === 0, null, { timeout: 8000 }).catch(() => {});
        await sleep(200);
        const r = await page.evaluate((no) => ({ h: JSON.parse(JSON.stringify(S.m.hand)), out: S.m.players[0].out, snd: __snd.filter((x) => x.no === no).map((x) => x.n) }), s.no);
        const got = countBy(r.snd), exp = expectedSounds(r.h, 0, r.out && r.h.start[0] > 0);
        const diff = Object.keys({ ...exp, ...got }).filter((k) => (exp[k] || 0) !== (got[k] || 0));
        ok(skip.has(s.no) || !diff.length, `핸드 ${s.no} 소리: ${diff.map((k) => `${k} ${got[k] || 0}/${exp[k] || 0}`).join(", ")}`);
        const f = await fxState(page);
        ok(f.fx === 0 && f.active === 0 && f.waapi === 0 && f.errors === 0, `핸드 ${s.no} 끝난 뒤 남은 효과 ${JSON.stringify(f)}`);
        checked++;
      }
      if (checked < 4 && await page.evaluate(() => document.getElementById("modal").hidden)) {
        const nx = await page.$("#next");
        if (nx) {
          await nx.click({ timeout: 3000 }).catch(() => {});
          // 카드를 나눠 주는 도중 화면 방향이 바뀌면(폰 ↔ 넓은 화면) 떠 있던 효과는 바로 지운다
          if (!resized && checked === 2) {
            resized = true;
            await sleep(150);
            const mid = await page.evaluate(() => document.querySelector(".fx-layer")?.childElementCount || 0);
            await page.setViewportSize({ width: 844, height: 390 });
            await sleep(50);
            const f = await fxState(page);
            ok(mid > 0 && f.fx === 0 && f.waapi === 0, `화면 방향이 바뀌면 효과를 지움 (도중 ${mid}개 → ${JSON.stringify(f)})`);
            await page.setViewportSize({ width: 390, height: 844 });
          } else if (!hidden && checked === 3) {
            // 다른 탭으로 가면 떠 있는 효과 · 예약한 소리를 지운다
            hidden = true;
            skip.add(await page.evaluate(() => S.m.hand.no));
            await sleep(120);
            const hid = await page.evaluate(() => {
              const before = PokerMotion.active();
              Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
              document.dispatchEvent(new Event("visibilitychange"));
              const after = PokerMotion.active();
              delete document.hidden;
              return { before, after };
            });
            ok(hid.before > 0 && hid.after === 0, "다른 탭으로 가면 효과를 지움 " + JSON.stringify(hid));
          }
        }
      }
    }
    await sleep(100);
  }
  const anim = await page.evaluate(() => __anim);
  console.log(`   핸드 ${checked}, 내 수 ${moves}, 움직임 ${anim}번`);
  ok(checked >= 4 && anim > 20 && resized && hidden, `핸드 ${checked} · 움직임 ${anim} · 방향 ${resized} · 탭 ${hidden}`);
  // 새로고침 → 이어하기: 지난 일의 소리 · 움직임 없음
  await page.reload();
  ok((await page.evaluate(() => __snd.length + __anim)) === 0, "새로고침한 첫 화면에 소리 · 움직임 없음");
  await page.click("#m-resume");
  await sleep(300);
  const after = await page.evaluate(() => ({ snd: __snd.map((x) => x.n), anim: __anim }));
  ok(after.snd.length === 0 && after.anim === 0, "새로고침 · 이어하기에 소리 · 움직임 없음 " + JSON.stringify(after));
  // 소리 끄기: 누르면 꺼지고, 새로고침해도 꺼진 채
  await page.click("#sound");
  ok((await btn()).pressed === "false", "소리 끄기");
  await page.reload();
  const b1 = await btn();
  ok(b1.pressed === "false" && b1.muted, "새로고침 뒤에도 꺼짐 " + JSON.stringify(b1));
  await page.click("#sound").catch(() => {}); // 창 뒤라 눌리지 않으면 아래에서 직접
  if ((await btn()).pressed !== "true") await page.evaluate(() => document.getElementById("sound").click());
  ok((await btn()).pressed === "true", "다시 켜기");
  await ctx.close();
  // 동작 줄이기: 움직임 없이 소리만
  const rctx = await browser.newContext({ ...DESKTOP, reducedMotion: "reduce" });
  await rctx.addInitScript(soundHook);
  const rp = await newPage(rctx, "fx-reduce");
  await rp.goto(base);
  await rp.click("[data-count='6']");
  await rp.click("#m-start");
  await rp.waitForFunction(() => S.m.hand.phase === "done" || (S.m.hand.toAct === 0 && document.getElementById("controls").classList.contains("mine")), null, { timeout: 30000 });
  await sleep(1200);
  const rr = await rp.evaluate(() => ({ anim: __anim, snd: __snd.length, fx: document.querySelector(".fx-layer")?.childElementCount || 0, css: document.getAnimations().length }));
  ok(rr.anim === 0 && rr.fx === 0 && rr.css === 0 && rr.snd > 0, "동작 줄이기: 움직임 없음 · 소리는 남 " + JSON.stringify(rr));
  await rctx.close();
}

// ===== G) 뻥카 읽기 =====
// 다음 핸드의 카드를 정한다: window.__force = { holes: {자리: "7c 2d"}, other: ["Ah Ad", ...](나머지 자리 차례로), board: "As Jd 9c 4s 3h" }
function forcePatch() {
  const C = (t) => RANKS.indexOf(t[0]) * 4 + SUITS.indexOf(t[1]);
  const cards = (str) => str.split(" ").filter(Boolean).map(C);
  const orig = PokerTable.startHand;
  PokerTable.startHand = (m, d) => {
    const r = orig(m, d);
    const f = window.__force;
    if (!f) return r;
    window.__force = null;
    window.__forcedNo = m.hand.no;
    const h = m.hand, used = new Set(), other = f.other.slice();
    for (const s of h.seats) { h.hole[s] = cards(f.holes[s] || other.shift()); h.hole[s].forEach((c) => used.add(c)); }
    const b = cards(f.board);
    b.forEach((c) => used.add(c));
    const rest = [...Array(52).keys()].filter((c) => !used.has(c));
    const burn = () => rest.pop();
    const b1 = burn(), b2 = burn(), b3 = burn();
    h.deck = [...rest, b[4], b3, b[3], b2, b[2], b[1], b[0], b1]; // 뒤에서부터: 번 · 플롭 3 · 번 · 턴 · 번 · 리버
    return r;
  };
}
// 정해 둔 핸드의 내 수: bluffer면 플롭부터 스트리트마다 한 번 가장 작게 벳/레이즈(그 뒤엔 콜), "fold"면 베팅에 접고, 아니면 체크 · 콜만
async function forcedMove(page, how) {
  const o = await page.evaluate(() => {
    const h = S.m.hand, mine = h.actions.some((a) => a.street === h.street && a.seat === ME && (a.type === "bet" || a.type === "raise"));
    return { street: h.street, mine, raise: !!document.getElementById("b-raise") && !document.getElementById("b-raise").disabled, fold: !!document.getElementById("b-fold") && !document.getElementById("b-fold").disabled };
  });
  if (how === true && o.street > 0 && !o.mine && o.raise) {
    await page.evaluate(() => setAmount(PokerTable.legal(S.m, ME).minTo));
    await page.click("#b-raise");
  } else if (how === "fold" && o.fold) await page.click("#b-fold");
  else await page.click("#b-call");
}
const bluffState = (page, no) => page.evaluate((no) => ({
  no: S.m.hand.no, phase: S.m.hand.phase, tags: [...document.querySelectorAll(".bet .tag.bluff")].map((t) => Number(t.parentElement.id.slice(4))),
  log: S.log.filter((l) => l.includes("bluff-line")), snd: typeof __snd === "object" ? __snd.filter((x) => x.no === no && x.n === "bluff").length : -1,
  stamp: PokerMotion.log.filter((x) => x.no === no && x.ev === "bluff").length, anim: [...document.querySelectorAll(".bet .tag.bluff")].reduce((t, el) => t + el.getAnimations().length, 0),
  reads: typeof S.reads === "object" && S.reads ? { last: S.reads.last, bluff: S.reads.seats.map((z) => z.shown.bluff) } : null,
}), no);
// 지금 핸드를 끝까지 (내 차례마다 how대로)
async function playOut(page, how) {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const s = await page.evaluate(() => ({ phase: S.m.hand.phase, mine: document.getElementById("controls").classList.contains("mine") }));
    if (s.phase === "done") return true;
    if (s.mine) { await sleep(400); await forcedMove(page, how); }
    await sleep(120);
  }
  return false;
}

// 혼자 하기 헤즈업: 나 7♣2♦ (플롭부터 가장 작게 벳 · 레이즈, 그 뒤엔 콜) vs Claude 자리(엔진) A♥A♦ — 쇼다운에 내 뻥카
async function soloBluffHand(page, tag) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => { window.__force = { holes: { 0: "7c 2d" }, other: ["Ah Ad"], board: "As Jd 9c 4s 3h" }; });
    await page.click("#next");
    await page.waitForFunction(() => window.__forcedNo === S.m.hand.no, null, { timeout: 10000 });
    const no = await page.evaluate(() => S.m.hand.no);
    await playOut(page, true);
    await page.waitForFunction(() => PokerMotion.active() === 0, null, { timeout: 8000 }).catch(() => {});
    await sleep(300);
    const st = await bluffState(page, no);
    if (st.tags.length || attempt === 2 || !(await page.$("#next"))) return st;
    console.log(`   ${tag}: 정해 둔 핸드가 쇼다운까지 가지 않아 다시 (${attempt + 1})`);
  }
}

async function scenarioG(browser, web) {
  console.log("G) 뻥카 읽기: 도장 · 기록 · 소리 · 이번 게임만");
  const base = `http://127.0.0.1:${web.port}/index.html`;
  // 1) 혼자 하기 · 넓은 화면: 첫 핸드는 접기만 → 새로고침해도 읽기 그대로 → 정해 둔 핸드 → 새 게임이면 0부터
  const ctx = await browser.newContext(DESKTOP);
  await ctx.addInitScript(soundHook);
  const page = await newPage(ctx, "G-solo");
  await page.goto(base);
  await page.click("[data-count='2']");
  await page.click("#m-start");
  await playOut(page, "fold");
  const before = await page.evaluate(() => JSON.stringify(S.reads));
  ok(JSON.parse(before).last === 1, "첫 핸드가 읽기에 기록됨 " + before.slice(0, 60));
  await page.reload();
  ok((await page.evaluate(() => JSON.stringify(S.reads))) === before, "새로고침해도 같은 게임의 읽기는 그대로");
  await page.click("#m-resume");
  await sleep(400);
  await page.evaluate(forcePatch);
  const st = await soloBluffHand(page, "G-solo");
  console.log(`   혼자 하기: 핸드 ${st.no} 도장 ${JSON.stringify(st.tags)} · 기록 ${st.log.length} · 소리 ${st.snd} · 찍힘 ${st.stamp} · 읽기 ${JSON.stringify(st.reads)}`);
  ok(st.tags.includes(0) && st.log.some((l) => l.includes("내 뻥카가 들켰어요")) && st.snd === 1 && st.stamp >= 1 && st.anim === 0, "혼자 하기 뻥카 도장 · 기록 · 소리 한 번 · 움직임 끝 " + JSON.stringify(st));
  ok(st.reads && st.reads.last === st.no && st.reads.bluff[0] >= 1, "이번 게임 읽기에 내 뻥카 기록 " + JSON.stringify(st.reads));
  // 새 게임: 0부터 (졌으면 결과 창의 다시 하기, 아니면 새 게임 → 설정 → 시작)
  await sleep(1900);
  if (await page.$("#m-again")) await page.click("#m-again");
  else {
    await page.click("#new-game");
    if (await page.$("#m-setup")) await page.click("#m-setup");
    await page.click("#m-start");
  }
  const fresh = await page.evaluate(() => ({ no: S.m.hand.no, hands: S.reads.hands, last: S.reads.last, sum: S.reads.seats.reduce((t, z) => t + z.hands + z.shown.bluff, 0) }));
  ok(fresh.no === 1 && fresh.hands === 0 && fresh.last === 0 && fresh.sum === 0, "새 게임이면 읽기 0부터 " + JSON.stringify(fresh));
  await ctx.close();

  // 2) 동작 줄이기 · 폰: 도장은 보이지만 움직이지 않고, 소리는 난다
  const rctx = await browser.newContext({ ...MOBILE, reducedMotion: "reduce" });
  await rctx.addInitScript(soundHook);
  const rp = await newPage(rctx, "G-reduce");
  await rp.goto(base);
  await rp.click("[data-count='2']");
  await rp.click("#m-start");
  await playOut(rp, "fold");
  await rp.evaluate(forcePatch);
  const rs = await soloBluffHand(rp, "G-reduce");
  const vis = await rp.evaluate(() => { const t = document.querySelector(".bet .tag.bluff"); if (!t) return null; const r = t.getBoundingClientRect(), cs = getComputedStyle(t); return { w: Math.round(r.width), h: Math.round(r.height), op: cs.opacity, anims: document.getAnimations().length }; });
  ok(rs.tags.includes(0) && rs.snd === 1 && rs.stamp === 0 && vis && vis.w > 20 && vis.op === "1" && vis.anims === 0, "동작 줄이기: 도장은 보이고 움직임 없음 · 소리 한 번 " + JSON.stringify({ rs, vis }));
  await rctx.close();

  // 3) 친구와 하기 (?net=local): 방장 K♥K♦ (체크 · 콜) vs 손님 7♣2♦ (가장 작게 벳) — 두 화면 모두 손님 자리에 도장
  const nbase = `${base}?net=local`;
  const mctx = await browser.newContext(DESKTOP);
  await mctx.addInitScript(soundHook);
  const host = await newPage(mctx, "G-host");
  await host.goto(`${nbase}&nextSec=30`);
  await host.click("#tab-mp");
  await host.fill("#mp-name", "방장G");
  await host.click("#mp-host");
  await host.waitForFunction(() => room && room.ready, null, { timeout: 10000 });
  await host.click("[data-mpn='2']");
  const code = await host.evaluate(() => room.code);
  const g = await joinGuest(mctx, nbase, code, "손님G", "G-guest");
  await g.setViewportSize({ width: 390, height: 844 });
  await host.waitForFunction(() => room.guests.length === 1 && room.guests[0].connected, null, { timeout: 10000 });
  await host.evaluate(forcePatch);
  await host.evaluate(() => { window.__force = { holes: { 0: "Kh Kd", 1: "7c 2d" }, other: [], board: "As Jd 9c 4s 3h" }; });
  await host.click("#mp-start");
  await g.waitForFunction(() => S && S.m && S.m.hand && modalScreen === "", null, { timeout: 10000 });
  const no = await host.evaluate(() => S.m.hand.no);
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const hs = await host.evaluate(() => ({ phase: S.m.hand.phase, toAct: S.m.hand.toAct }));
    if (hs.phase === "done") break;
    for (const [pg, seat, how] of [[host, 0, false], [g, 1, true]]) {
      const s = await pg.evaluate(() => ({ mine: document.getElementById("controls").classList.contains("mine"), pending: mode === "guest" ? !!guest.pending : false }));
      if (hs.phase === "bet" && hs.toAct === seat && s.mine && !s.pending) { await sleep(400); await forcedMove(pg, how); }
    }
    await sleep(150);
  }
  await g.waitForFunction((no) => S.m.hand.no === no && S.m.hand.phase === "done", no, { timeout: 10000 }).catch(() => {});
  for (const pg of [host, g]) await pg.waitForFunction(() => PokerMotion.active() === 0, null, { timeout: 8000 }).catch(() => {});
  await sleep(300);
  const hb = await bluffState(host, no), gb = await bluffState(g, no);
  console.log(`   친구와 하기: 방장 도장 ${JSON.stringify(hb.tags)} 소리 ${hb.snd} · 손님 도장 ${JSON.stringify(gb.tags)} 소리 ${gb.snd} · 손님 기록 ${JSON.stringify(gb.log)}`);
  ok(hb.tags.includes(1) && gb.tags.includes(1) && hb.snd === 1 && gb.snd === 1, "친구와 하기: 방장 · 손님 모두 손님 자리에 도장 · 소리 한 번 " + JSON.stringify({ hb, gb }));
  ok(hb.log.some((l) => l.includes("손님G</b> 뻥카였어요")) && gb.log.some((l) => l.includes("내 뻥카가 들켰어요")), "친구와 하기: 기록 줄 (방장: 이름 · 손님: 내 뻥카)");
  ok(hb.reads && hb.reads.bluff[1] >= 1 && gb.reads === null, "읽기는 방장만 (손님은 받은 화면으로 표시만) " + JSON.stringify([hb.reads, gb.reads]));
  // 사람에게 보여 주는 읽기(명패 툴팁)는 혼자 하기만: 친구와 하기에서는 방장 · 손님 모두 없다
  const tips = async (pg) => pg.evaluate(() => [...document.querySelectorAll(".plate")].map((p) => p.title).filter(Boolean));
  const ht = await tips(host), gt = await tips(g);
  ok(ht.length === 0 && gt.length === 0, "친구와 하기: 명패 읽기 툴팁 없음 (방장 · 손님 같게) " + JSON.stringify([ht, gt]));
  // 다시 하기(같은 방 새 게임) = 새 읽기
  await host.evaluate(() => { newMatchMP(); lobbyBroadcast(); });
  const mf = await host.evaluate(() => ({ hands: S.reads.hands, last: S.reads.last, bluff: S.reads.seats.map((z) => z.shown.bluff) }));
  ok(mf.hands === 0 && mf.last === 0 && mf.bluff.every((x) => x === 0), "다시 하기 = 새 게임 → 읽기 0부터 " + JSON.stringify(mf));
  await mctx.close();
}

(async () => {
  const web = await staticServer();
  const browser = await chromium.launch();
  const only = process.env.ONLY || "ABCDEFG";
  try {
    if (only.includes("A")) await scenarioA(browser, web);
    if (only.includes("B")) await scenarioB(browser, web);
    if (only.includes("C")) await scenarioC(browser, web);
    if (only.includes("D")) await scenarioD(browser, web);
    if (only.includes("E")) await scenarioE(browser, web);
    if (only.includes("F")) await scenarioF(browser, web);
    if (only.includes("G")) await scenarioG(browser, web);
  } catch (e) {
    ok(false, "예외: " + (e && e.stack || e));
  }
  for (const e of errors) ok(false, e);
  console.log(`콘솔 · 페이지 오류 ${errors.length}개`);
  await browser.close();
  web.close();
  console.log(fails ? `${fails} FAILED` : "ALL OK");
  process.exit(fails ? 1 : 0);
})();
