import { test } from "node:test";
import assert from "node:assert/strict";
import { createWsClient, BACKOFF_MS } from "./ws-client.mjs";

// ---- fakes -----------------------------------------------------------------
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

function setup() {
  FakeWS.instances = [];
  const clock = makeClock();
  const messages = [];
  const client = createWsClient({
    url: "wss://example/stream",
    WebSocketImpl: FakeWS,
    onMessage: (raw) => messages.push(raw),
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    livenessTimeoutMs: 300_000,
  });
  return { clock, messages, client, last: () => FakeWS.instances[FakeWS.instances.length - 1] };
}

// ---- tests ---------------------------------------------------------------
test("start() opens a socket to the configured url", () => {
  const { client, last } = setup();
  client.start();
  assert.equal(FakeWS.instances.length, 1);
  assert.equal(last().url, "wss://example/stream");
});

test("forwards message frames to onMessage and tracks lastMessageAge", () => {
  const { client, last, messages, clock } = setup();
  client.start();
  last().fire("open", {});
  last().fire("message", { data: '{"hi":1}' });
  assert.deepEqual(messages, ['{"hi":1}']);
  clock.advance(2000);
  assert.equal(client.getHealth().lastMessageAgeMs, 2000);
});

test("reconnects with exponential backoff after a close, capped", () => {
  const { client, last, clock } = setup();
  client.start();

  for (let i = 0; i < BACKOFF_MS.length + 2; i++) {
    last().fire("open", {}); // socket connects...
    const before = FakeWS.instances.length;
    last().fire("close", { code: 1006 }); // ...then drops right away
    const wait = BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
    clock.advance(wait - 1);
    assert.equal(FakeWS.instances.length, before, `no reconnect before ${wait}ms (step ${i})`);
    clock.advance(1);
    assert.equal(FakeWS.instances.length, before + 1, `reconnected at ${wait}ms (step ${i})`);
  }
  assert.equal(client.getHealth().reconnectCount, BACKOFF_MS.length + 2);
});

test("backoff resets after the connection stays up past the stable threshold", () => {
  const { client, last, clock } = setup();
  client.start();
  last().fire("open", {});
  last().fire("close", { code: 1006 });
  clock.advance(BACKOFF_MS[0]); // first reconnect
  last().fire("open", {});
  clock.advance(61_000); // stable > 60s
  last().fire("close", { code: 1006 });
  const before = FakeWS.instances.length;
  clock.advance(BACKOFF_MS[0]);
  assert.equal(FakeWS.instances.length, before + 1, "next backoff is back to the first step");
});

test("liveness watchdog forces a reconnect when no message arrives in the window", () => {
  const { client, last, clock } = setup();
  client.start();
  last().fire("open", {});
  const first = last();
  clock.advance(300_001);
  assert.equal(first.closed, true, "stale socket was closed");
  clock.advance(BACKOFF_MS[0]); // reconnect is scheduled behind the normal backoff
  assert.ok(FakeWS.instances.length >= 2, "a fresh socket was opened");
});

test("getHealth reports ok=false until first open, true after", () => {
  const { client, last } = setup();
  client.start();
  assert.equal(client.getHealth().ok, false);
  last().fire("open", {});
  assert.equal(client.getHealth().ok, true);
  assert.equal(typeof client.getHealth().connectedSince, "number");
});

test("stop() cancels pending reconnects and closes the socket", () => {
  const { client, last, clock } = setup();
  client.start();
  last().fire("open", {});
  const sock = last();
  client.stop();
  assert.equal(sock.closed, true);
  last().fire("close", { code: 1000 });
  const before = FakeWS.instances.length;
  clock.advance(60_000);
  assert.equal(FakeWS.instances.length, before, "no reconnect after stop()");
});

test("records the last error message from an error event", () => {
  const { client, last } = setup();
  client.start();
  last().fire("error", { message: "ECONNREFUSED" });
  assert.equal(client.getHealth().lastError, "ECONNREFUSED");
});
