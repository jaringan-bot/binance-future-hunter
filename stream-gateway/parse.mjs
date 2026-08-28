// Pure parsers for Binance combined-stream messages. Never throw — a single
// odd frame must not take down the WebSocket loop. Unknown / malformed →
// { kind: null }.

/**
 * @param {string} raw  a WebSocket text frame
 * @returns {{kind: "liquidation"|"contract"|null, record?: object}}
 */
export function parseEnvelope(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: null };
  }
  if (!msg || typeof msg !== "object") return { kind: null };

  // Combined-stream frames wrap the event as { stream, data }. A bare
  // single-stream frame is the event itself.
  const data = msg.data && typeof msg.data === "object" ? msg.data : msg;

  if (data.e === "forceOrder") return parseForceOrder(data);
  if (data.e === "contractInfo") return parseContractInfo(data);
  return { kind: null };
}

function num(v) {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseForceOrder(data) {
  const o = data.o;
  if (!o || typeof o !== "object") return { kind: null };
  const price = num(o.p);
  const origQty = num(o.q);
  const tradeTime = num(o.T);
  const eventTime = num(data.E);
  if (price === null || origQty === null || tradeTime === null || !o.s || !o.S) {
    return { kind: null };
  }
  return {
    kind: "liquidation",
    record: {
      symbol: String(o.s),
      side: String(o.S),
      price,
      orig_qty: origQty,
      avg_price: num(o.ap),
      notional_usd: price * origQty,
      order_status: o.X ? String(o.X) : null,
      event_time: eventTime ?? tradeTime,
      trade_time: tradeTime,
    },
  };
}

function parseContractInfo(data) {
  if (!data.s) return { kind: null };
  const eventTime = num(data.E);
  return {
    kind: "contract",
    record: {
      symbol: String(data.s),
      pair: data.ps ? String(data.ps) : null,
      contract_type: data.ct ? String(data.ct) : null,
      contract_status: data.cs ? String(data.cs) : null,
      delivery_date: num(data.dt),
      onboard_date: num(data.ot),
      event_time: eventTime ?? Date.now(),
      raw_json: JSON.stringify(data),
    },
  };
}
