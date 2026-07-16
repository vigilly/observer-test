import { describe, it, expect } from "vitest";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import {
  datadogLogsToEvents,
  datadogMetricsToEvents,
  datadogTracesToEvents,
} from "../src/ingest/datadog.js";

describe("datadog logs", () => {
  it("maps a log array", () => {
    const events = datadogLogsToEvents([
      { message: "ok", service: "api", status: "info", timestamp: 1710000000000 },
    ]);
    expect(events[0].signal).toBe("log");
    expect(events[0].service).toBe("api");
    expect(events[0].summary).toBe("[info] ok");
  });
});

describe("datadog metrics", () => {
  it("handles v1 series ([ts,val], string type)", () => {
    const [ev] = datadogMetricsToEvents({
      series: [{ metric: "orders", points: [[1710000000, 3]], type: "count", tags: ["service:api"], host: "h1" }],
    });
    expect(ev.signal).toBe("metric");
    expect(ev.service).toBe("api");
    expect(ev.summary).toBe("orders = 3 · count");
  });

  it("handles v2 series ({timestamp,value}, numeric type)", () => {
    const [ev] = datadogMetricsToEvents({
      series: [{ metric: "cpu", points: [{ timestamp: 1710000000, value: 0.5 }], type: 3, unit: "percent" }],
    });
    expect(ev.summary).toBe("cpu = 0.5 percent · gauge");
  });
});

describe("datadog apm traces", () => {
  it("decodes msgpack v0.4 and emits trace + exception for error spans", () => {
    const trace = [
      { trace_id: 1, span_id: 2, parent_id: 0, name: "web.request", resource: "GET /x", service: "api", start: 1000000n, duration: 5000000n, error: 0, meta: {} },
      { trace_id: 1, span_id: 3, parent_id: 2, name: "db", resource: "SELECT", service: "db", start: 2000000n, duration: 1000000n, error: 1, meta: { "error.type": "PgError", "error.msg": "nope" } },
    ];
    const buf = Buffer.from(msgpackEncode([trace], { useBigInt64: true }));
    const events = datadogTracesToEvents(buf, "application/msgpack");
    const traces = events.filter((e) => e.signal === "trace");
    const excs = events.filter((e) => e.signal === "exception");
    expect(traces).toHaveLength(2);
    expect(excs).toHaveLength(1);
    expect(traces[0].attributes?.durationMs).toBe(5);
    expect(excs[0].summary).toBe("PgError: nope");
  });

  it("also accepts JSON trace bodies", () => {
    const body = Buffer.from(JSON.stringify([[{ trace_id: 9, span_id: 8, name: "t", service: "s", start: 0, duration: 2000000 }]]));
    const [ev] = datadogTracesToEvents(body, "application/json");
    expect(ev.signal).toBe("trace");
    expect(ev.attributes?.durationMs).toBe(2);
  });
});
