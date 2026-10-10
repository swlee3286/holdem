// 온라인(친구와 하기) 끝까지 테스트 — 진짜 브라우저 여러 개: node test/mp.e2e.js
// 준비: playwright(Chromium 포함)와 peer(PeerJS 시그널링 서버) 패키지가 require로 보여야 한다. 예)
//   npm i --no-save playwright peer && npx playwright install chromium && node test/mp.e2e.js
// 이 테스트가 직접 띄우는 것: 정적 서버(이 폴더) + 로컬 PeerJS 서버. 외부 인터넷은 쓰지 않는다 (Google Fonts는 막는다)
//  A) PeerJS: 방장(넓은 화면) + 손님 2(폰 390x844), 핸드 25개 이상 무작위로 — 모든 화면이 방장과 같은지, 칩 보존,
//     콘솔 오류 · 멈춤 없음, 차례가 아닌 수 · 늦은 수 무시, 시간 초과, 손님이 창을 닫으면 AI가 대신 → 다시 열면 자리 되찾기,
//     매치가 끝나면 모두에게 순위 → 다시 하기
//  B) ?net=local (BroadcastChannel): 같은 브라우저의 탭 2개
//  C) 혼자 하기 회귀: 6명, 핸드 15개
//  D) 방장 새로고침: 같은 코드로 다시 열고 하던 핸드를 잇는다, 손님은 알아서 다시 들어온다
//  E) 아티팩트 진입 파일(artifact.html, PeerJS 없음 · window.claude 있음): 친구와 하기를 끄고 GitHub 주소 안내
const http = require("http");
const fs = require("fs");
const path = require("path");
const netm = require("net");
const { chromium } = require("playwright");
const { PeerServer } = require("peer");

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
    if (done.again && handsPlayed >= againAt + 2 && hs.phase === "done") break;
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
  let moves = 0, seen = "", seenAt = 0;
  const t0 = Date.now();
  while (hands.size < HANDS_C && Date.now() - t0 < 4 * 60000 && fails < 20) {
    const s = await page.evaluate(() => ({
      no: S.m.hand.no, n: S.m.hand.actions.length, phase: S.m.hand.phase, toAct: S.m.hand.toAct, mode, mine: document.getElementById("controls").classList.contains("mine"),
      modal: !document.getElementById("modal").hidden, over: S.m.over, out: S.m.players[0].out, fast,
      total: S.m.players.reduce((t, p) => t + p.stack, 0) + (S.m.hand.phase === "done" ? 0 : PokerTable.potTotal(S.m.hand)),
    }));
    ok(s.mode === "solo" && s.total === 12000, `혼자 하기 상태 ${JSON.stringify(s)}`);
    hands.add(s.no);
    if (s.modal) { const b = await page.$("#m-watch, #m-again"); if (b) await b.click(); await sleep(200); continue; }
    if (s.phase === "bet" && s.toAct === 0 && s.mine) {
      const k = `${s.no}|${s.n}`;
      if (seen !== k) { seen = k; seenAt = Date.now(); }
      else if (Date.now() - seenAt > 450) { await randomMove(page); moves++; }
    } else if (s.phase === "done") {
      await sleep(250);
      const nx = await page.$("#next");
      if (nx) await nx.click();
    } else if (s.out && !s.fast) {
      const ff = await page.$("#fast");
      if (ff) await ff.click();
    }
    await sleep(120);
  }
  console.log(`   핸드 ${hands.size}, 내 수 ${moves}`);
  ok(hands.size >= HANDS_C, `혼자 하기 핸드 수 ${hands.size}`);
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
  const host = await newPage(hctx, "Dhost");
  await host.goto(`${base}&nextSec=1`);
  await host.click("#tab-mp");
  await host.fill("#mp-name", "방장D");
  await host.click("#mp-host");
  await host.waitForFunction(() => room && room.ready, null, { timeout: 20000 });
  await host.click("[data-mpn='3']");
  const code = await host.evaluate(() => room.code);
  const gctx = await browser.newContext(MOBILE);
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
  await host.reload();
  const t1 = Date.now();
  await host.waitForFunction(() => mode === "host" && room && room.ready && modalScreen !== "resume", null, { timeout: 30000 });
  const after = await snap(host);
  ok((await host.evaluate(() => room.code)) === code, "같은 방 코드로 다시 열림");
  ok(after.no === before.no && after.n >= before.n && JSON.stringify(after.board.slice(0, before.board.length)) === JSON.stringify(before.board), `하던 핸드를 이어서 (${before.no}/${before.n} → ${after.no}/${after.n})`);
  await host.waitForFunction(() => room.guests[0].connected, null, { timeout: 40000 });
  await g.waitForFunction(() => guest.status === "open" && modalScreen === "" && S.m.hand.no >= 1, null, { timeout: 20000 });
  console.log(`   방장 새로고침 → ${((Date.now() - t1) / 1000).toFixed(1)}초 뒤 손님까지 다시 연결`);
  t0 = Date.now();
  const startHands = D.st.hands.size;
  while (Date.now() - t0 < 120000) {
    const { hs } = await D.step(players);
    if (!hs.none && (hs.over || (D.st.hands.size >= startHands + 2 && hs.phase === "done"))) break;
    await sleep(120);
  }
  ok(D.st.hands.size >= startHands + 2 && D.st.mismatch === 0, `새로고침 뒤 계속 (핸드 ${D.st.hands.size}, 비교 ${D.st.compared}, 다름 ${D.st.mismatch})`);
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

(async () => {
  const web = await staticServer();
  const browser = await chromium.launch();
  const only = process.env.ONLY || "ABCDE";
  try {
    if (only.includes("A")) await scenarioA(browser, web);
    if (only.includes("B")) await scenarioB(browser, web);
    if (only.includes("C")) await scenarioC(browser, web);
    if (only.includes("D")) await scenarioD(browser, web);
    if (only.includes("E")) await scenarioE(browser, web);
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
