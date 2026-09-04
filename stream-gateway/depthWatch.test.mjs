import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDepthWatcher,
  classifyLevelTransition,
  resolveWallState,
  depthWsUrl,
  DEFAULT_WALL_MIN_NOTIONAL_USD,
  MIN_WALL_NOTIONAL_USD,
} from "./depthWatch.mjs";

// ---- fakes (same shape as ws-client.test.mjs) ---------------------------
class FakeWS {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeWS.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.fire("close", { code: 1000 });
  }
  fire(type, ev) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
}
FakeWS.instances = [];

function makeClock() {
  let t = 0;
  const jobs = [];
  return {
    now: () => t,
    schedule: (fn, ms) => {
      const job = { at: t + ms, fn, cancelled: false };
      jobs.push(job);
      return job;
    },
    cancel: (job) => {
      if (job) job.cancelled = true;
    },
    advance: (ms) => {
      t += ms;
      for (const job of [...jobs]) {
        if (!job.cancelled && job.at <= t) {
          job.cancelled = true;
          job.fn();
        }
      }
    },
  };
}

function setup(over = {}) {
  FakeWS.instances = [];
  const clock = makeClock();
  const dw = createDepthWatcher({
    WebSocketImpl: FakeWS,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    warmupMs: 0,
    ...over,
  });
  return { clock, dw, last: () => FakeWS.instances[FakeWS.instances.length - 1] };
}

function depthFrame({ b = [], a = [] }) {
  return JSON.stringify({ e: "depthUpdate", E: 1, T: 1, s: "BTCUSDT", b, a });
}

// ---- classifyLevelTransition (pure) -----------------------------------
// Argumen ke-5 = prevIsWall, status wall yang DISIMPAN caller. Bukan
// kenyamanan: histeresis punya memori, dan menurunkan ulang statusnya dari
// prevQty menghapus memori itu (lihat test regresi di bawah).
test("classifyLevelTransition: APPEARED / VANISHED / GREW / SHRANK / none", () => {
  const W = 250_000;
  // price 100 => wall needs qty >= 2500
  assert.equal(classifyLevelTransition(0, 3000, 100, W, false).type, "WALL_APPEARED");
  assert.equal(classifyLevelTransition(3000, 0, 100, W, true).type, "WALL_VANISHED");
  assert.equal(classifyLevelTransition(3000, 1000, 100, W, true).type, "WALL_VANISHED"); // below exit floor
  assert.equal(classifyLevelTransition(3000, 5000, 100, W, true).type, "WALL_GREW");
  assert.equal(classifyLevelTransition(5000, 2600, 100, W, true).type, "WALL_SHRANK");
  assert.equal(classifyLevelTransition(3000, 3100, 100, W, true), null); // +3%, still a wall, no resize
  assert.equal(classifyLevelTransition(1000, 1200, 100, W, false), null); // never a wall
});

test("classifyLevelTransition: exit hysteresis suppresses flap just below threshold", () => {
  const W = 250_000;
  // Was a wall at $300k; drop to $220k (still >= 85% of $250k = $212.5k) → stay wall.
  // Resize -26.7% < 40% → no event (null), NOT VANISHED.
  assert.equal(classifyLevelTransition(3000, 2200, 100, W, true), null);
  // Drop further to $200k (< exit floor) → VANISHED.
  assert.equal(classifyLevelTransition(3000, 2000, 100, W, true).type, "WALL_VANISHED");
  // Enter still requires full threshold: $240k from below is not a wall.
  assert.equal(classifyLevelTransition(2000, 2400, 100, W, false), null);
});

test("resolveWallState: enter at full threshold, exit only through the band", () => {
  const W = 250_000;
  assert.equal(resolveWallState(false, 240_000, W), false); // masuk butuh ambang penuh
  assert.equal(resolveWallState(false, 250_000, W), true);
  assert.equal(resolveWallState(true, 220_000, W), true); // di dalam pita -> tetap wall
  assert.equal(resolveWallState(true, 212_500, W), true); // tepat di exit floor
  assert.equal(resolveWallState(true, 212_499, W), false); // menembus pita -> bukan wall
});

// ---- REGRESSION GUARD: histeresis tidak boleh MENELAN WALL_VANISHED ----
// Histeresis diperkenalkan untuk meredam flap APPEARED<->VANISHED. Versi
// pertamanya menurunkan `wasWall` dari prevQty di dalam fungsi, sehingga
// level yang MENGENDUR ke dalam pita (tidak melaporkan apa-apa) dianggap
// "tidak pernah wall" pada tick berikutnya -- dan WALL_VANISHED-nya hilang
// SELAMANYA. Konsumen yang melacak wall terbuka akan mengira wall itu masih
// ada. Itu kegagalan yang lebih buruk daripada churn yang mau dikurangi,
// dan tidak terlihat oleh test transisi-tunggal mana pun.
//
// Helper ini menjalankan state machine PERSIS seperti applyLevels():
// simpan { qty, isWall }, buang level di bawah track floor.
function replayLevel(qtySeq, wallMin = 250_000, price = 100, trackFloorFraction = 0.5) {
  let prevQty = 0;
  let prevIsWall = false;
  const events = [];
  for (const qty of qtySeq) {
    const t = classifyLevelTransition(prevQty, qty, price, wallMin, prevIsWall);
    if (t) events.push(t.type);
    const nextIsWall = resolveWallState(prevIsWall, qty * price, wallMin);
    if (qty * price >= wallMin * trackFloorFraction) {
      prevQty = qty;
      prevIsWall = nextIsWall;
    } else {
      prevQty = 0;
      prevIsWall = false;
    }
  }
  return events;
}

test("hysteresis never swallows WALL_VANISHED after a dwell inside the band", () => {
  // $300k -> $220k (di dalam pita, senyap) -> 0. VANISHED WAJIB tetap keluar.
  assert.deepEqual(replayLevel([3000, 2200, 0]), ["WALL_APPEARED", "WALL_VANISHED"]);
  // Kontrol: tanpa singgah di pita, perilakunya memang sudah benar sebelumnya.
  assert.deepEqual(replayLevel([3000, 0]), ["WALL_APPEARED", "WALL_VANISHED"]);
  // Singgah berkali-kali pun tetap harus menutup.
  assert.deepEqual(replayLevel([3000, 2200, 2300, 2200, 0]), ["WALL_APPEARED", "WALL_VANISHED"]);
});

test("hysteresis still does its job: flap around the threshold stays quiet", () => {
  // Inilah alasan histeresis ada. Tanpa histeresis deret ini menghasilkan
  // APPEARED/VANISHED berulang; dengan histeresis cuma satu APPEARED.
  assert.deepEqual(replayLevel([3000, 2200, 3000, 2200, 3000]), ["WALL_APPEARED"]);
});

test("hysteresis does not let a level sneak in through the band from below", () => {
  // $240k < ambang penuh $250k -- mendekat dari bawah tidak boleh jadi wall
  // hanya karena berada di atas exit floor.
  assert.deepEqual(replayLevel([0, 2400, 2400, 2450]), []);
});

test("depthWsUrl builds the per-symbol stream path", () => {
  assert.equal(depthWsUrl("wss://fstream.binance.com/ws", "BTCUSDT"), "wss://fstream.binance.com/ws/btcusdt@depth@100ms");
  assert.equal(depthWsUrl("wss://x/ws/", "ETHUSDT"), "wss://x/ws/ethusdt@depth@100ms");
});

// ---- watcher ---------------------------------------------------------
test("watch() opens one socket to the @depth@100ms url and reports watching", () => {
  const { dw, last } = setup();
  const r = dw.watch("btcusdt", 60_000);
  assert.equal(r.ok, true);
  assert.equal(r.watching, true);
  assert.equal(r.symbol, "BTCUSDT");
  assert.equal(FakeWS.instances.length, 1);
  assert.match(last().url, /\/btcusdt@depth@100ms$/);
});

test("a bid level crossing the wall threshold emits WALL_APPEARED", () => {
  const { dw, last, clock } = setup();
  dw.watch("BTCUSDT", 60_000);
  last().fire("open", {});
  clock.advance(1_000);
  last().fire("message", { data: depthFrame({ b: [["100", "3000"]] }) }); // 300k notional
  const diff = dw.queryDepthDiff("BTCUSDT", 0);
  assert.equal(diff.watching, true);
  assert.equal(diff.events.length, 1);
  assert.equal(diff.events[0].type, "WALL_APPEARED");
  assert.equal(diff.events[0].side, "bid");
  assert.equal(diff.events[0].price, 100);
  assert.equal(diff.events[0].notionalUsd, 300_000);
});

test("warmup suppresses the connect-time WALL_APPEARED burst but not later moves", () => {
  const { dw, last, clock } = setup({ warmupMs: 1_000 });
  dw.watch("BTCUSDT", 60_000);
  last().fire("open", {});
  // within warmup: a resting wall ticks -> no APPEARED, but book is seeded
  last().fire("message", { data: depthFrame({ a: [["200", "2000"]] }) }); // 400k
  assert.equal(dw.queryDepthDiff("BTCUSDT", 0).events.length, 0);
  clock.advance(1_100);
  // after warmup: same wall drops below the threshold -> VANISHED
  // (prior state was seeded during warmup, so the transition is seen)
  last().fire("message", { data: depthFrame({ a: [["200", "600"]] }) }); // 120k, below wall
  const evs = dw.queryDepthDiff("BTCUSDT", 0).events;
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "WALL_VANISHED");
});

test("queryDepthDiff filters by sinceMs and returns watching:false for an unknown symbol", () => {
  const { dw, last, clock } = setup();
  dw.watch("BTCUSDT", 60_000);
  last().fire("open", {});
  clock.advance(1_000);
  last().fire("message", { data: depthFrame({ b: [["100", "3000"]] }) });
  const firstTs = dw.queryDepthDiff("BTCUSDT", 0).events[0].ts;
  clock.advance(500);
  last().fire("message", { data: depthFrame({ b: [["100", "6000"]] }) }); // GREW
  const since = dw.queryDepthDiff("BTCUSDT", firstTs);
  assert.equal(since.events.length, 1);
  assert.equal(since.events[0].type, "WALL_GREW");

  assert.deepEqual(dw.queryDepthDiff("ETHUSDT", 0), {
    watching: false,
    symbol: "ETHUSDT",
    events: [],
    meta: { count: 0 },
  });
});

test("renewing a watch extends expiresAt without opening a second socket", () => {
  const { dw, clock } = setup();
  const a = dw.watch("BTCUSDT", 60_000);
  clock.advance(30_000);
  const b = dw.watch("BTCUSDT", 60_000);
  assert.equal(b.renewed, true);
  assert.equal(FakeWS.instances.length, 1);
  assert.ok(b.expiresAt > a.expiresAt);
});

test("per-watch wall threshold: used for classification + returned; renew keeps the arming value", () => {
  const { dw, last, clock } = setup();
  const armed = dw.watch("BTCUSDT", 60_000, 1_000_000);
  assert.equal(armed.wallMinNotionalUsd, 1_000_000);
  last().fire("open", {});
  clock.advance(1_000);
  // price 100 => $1M wall needs qty >= 10000. 8000 (=$800k) is below.
  last().fire("message", { data: depthFrame({ b: [["100", "8000"]] }) });
  assert.equal(dw.queryDepthDiff("BTCUSDT", 0).events.length, 0, "$800k not a wall at a $1M threshold");
  last().fire("message", { data: depthFrame({ b: [["100", "12000"]] }) }); // $1.2M
  const evs = dw.queryDepthDiff("BTCUSDT", 0).events;
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "WALL_APPEARED");
  assert.equal(dw.queryDepthDiff("BTCUSDT", 0).meta.wallMinNotionalUsd, 1_000_000);

  // renew with a different threshold -> ignored, locked to 1M
  const renewed = dw.watch("BTCUSDT", 60_000, 50_000);
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.wallMinNotionalUsd, 1_000_000);
});

test("wall threshold falls back to the ctor default when not given, and clamps to MIN", () => {
  const { dw } = setup({ wallMinNotionalUsd: 400_000 });
  assert.equal(dw.watch("BTCUSDT").wallMinNotionalUsd, 400_000);
  assert.equal(dw.watch("ETHUSDT", undefined, 1).wallMinNotionalUsd, MIN_WALL_NOTIONAL_USD);
  assert.equal(dw.watch("SOLUSDT", undefined, 0).wallMinNotionalUsd, 400_000); // 0 -> default
});

test("maxWatches caps concurrent watches", () => {
  const { dw } = setup({ maxWatches: 2 });
  assert.equal(dw.watch("BTCUSDT").ok, true);
  assert.equal(dw.watch("ETHUSDT").ok, true);
  const third = dw.watch("SOLUSDT");
  assert.equal(third.ok, false);
  assert.match(third.error, /batas 2/);
  assert.deepEqual(third.activeWatches, ["BTCUSDT", "ETHUSDT"]);
});

test("an invalid symbol is rejected without opening a socket", () => {
  const { dw } = setup();
  const r = dw.watch("bad!");
  assert.equal(r.ok, false);
  assert.equal(FakeWS.instances.length, 0);
});

test("the TTL sweep closes an expired watch", () => {
  const { dw, last, clock } = setup({ sweepIntervalMs: 10_000 });
  dw.watch("BTCUSDT", 30_000);
  const sock = last();
  clock.advance(31_000); // past TTL; sweep runs at 10s,20s,30s,40s...
  clock.advance(10_000);
  assert.equal(sock.closed, true);
  assert.equal(dw.queryDepthDiff("BTCUSDT", 0).watching, false);
  assert.equal(dw.stats().count, 0);
});

test("stopAll closes every socket and cancels the sweep", () => {
  const { dw, clock } = setup();
  dw.watch("BTCUSDT");
  dw.watch("ETHUSDT");
  assert.equal(dw.stats().count, 2);
  dw.stopAll();
  assert.equal(dw.stats().count, 0);
  for (const s of FakeWS.instances) assert.equal(s.closed, true);
  // no throw / no work after stop
  clock.advance(60_000);
});

test("malformed and non-depthUpdate frames are ignored", () => {
  const { dw, last } = setup();
  dw.watch("BTCUSDT");
  last().fire("open", {});
  last().fire("message", { data: "{not json" });
  last().fire("message", { data: JSON.stringify({ e: "trade", p: "1" }) });
  last().fire("message", { data: JSON.stringify({ e: "depthUpdate", b: "nope" }) });
  assert.equal(dw.queryDepthDiff("BTCUSDT", 0).events.length, 0);
});

test("stats() and default wall threshold are exposed", () => {
  assert.equal(typeof DEFAULT_WALL_MIN_NOTIONAL_USD, "number");
  const { dw } = setup();
  dw.watch("BTCUSDT");
  const s = dw.stats();
  assert.equal(s.count, 1);
  assert.equal(s.activeWatches[0].symbol, "BTCUSDT");
});
