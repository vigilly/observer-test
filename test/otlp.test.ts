import { describe, it, expect } from "vitest";
import { otlpTracesToEvents, otlpLogsToEvents, otlpMetricsToEvents } from "../src/ingest/otlp.js";

const sv = (s: string) => ({ stringValue: s });
const svc = { key: "service.name", value: sv("checkout") };

describe("otlp traces", () => {
  it("maps spans and surfaces exception span events", () => {
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [svc] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "aa", spanId: "bb", name: "GET /x", kind: 2,
                  startTimeUnixNano: "1000000000", endTimeUnixNano: "1042000000",
                  status: { code: 2, message: "fail" },
                  events: [
                    { name: "exception", timeUnixNano: "1042000000", attributes: [
                      { key: "exception.type", value: sv("Boom") },
                      { key: "exception.message", value: sv("kaboom") },
                    ] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const events = otlpTracesToEvents(payload);
    expect(events).toHaveLength(2);
    const trace = events.find((e) => e.signal === "trace")!;
    const exc = events.find((e) => e.signal === "exception")!;
    expect(trace.service).toBe("checkout");
    expect(trace.attributes?.durationMs).toBe(42);
    expect(trace.attributes?.status).toBe("error");
    expect(exc.summary).toBe("Boom: kaboom");
    expect(exc.attributes?.traceId).toBe("aa");
  });

  it("accepts snake_case (protobuf-style) keys too", () => {
    const payload = {
      resource_spans: [
        {
          resource: { attributes: [svc] },
          scope_spans: [{ spans: [{ trace_id: "cc", span_id: "dd", name: "job", start_time_unix_nano: "0", end_time_unix_nano: "5000000" }] }],
        },
      ],
    };
    const [ev] = otlpTracesToEvents(payload);
    expect(ev.signal).toBe("trace");
    expect(ev.attributes?.traceId).toBe("cc");
    expect(ev.attributes?.durationMs).toBe(5);
  });
});

describe("otlp logs", () => {
  it("maps a log record with severity and body", () => {
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [svc] },
          scopeLogs: [{ logRecords: [{ timeUnixNano: "1000000", severityNumber: 17, body: sv("disk full"), attributes: [{ key: "disk", value: sv("/") }] }] }],
        },
      ],
    };
    const [ev] = otlpLogsToEvents(payload);
    expect(ev.signal).toBe("log");
    expect(ev.summary).toBe("[ERROR] disk full");
    expect(ev.attributes?.disk).toBe("/");
  });
});

describe("otlp metrics", () => {
  it("summarizes a monotonic sum as a counter and a gauge", () => {
    const payload = {
      resourceMetrics: [
        {
          resource: { attributes: [svc] },
          scopeMetrics: [
            {
              metrics: [
                { name: "requests", unit: "1", sum: { isMonotonic: true, dataPoints: [{ asInt: "5", timeUnixNano: "1000000" }] } },
                { name: "mem", unit: "By", gauge: { dataPoints: [{ asDouble: 123.5, timeUnixNano: "1000000" }] } },
              ],
            },
          ],
        },
      ],
    };
    const events = otlpMetricsToEvents(payload);
    expect(events).toHaveLength(2);
    expect(events[0].summary).toBe("requests = 5 · counter"); // unit "1" suppressed
    expect(events[1].summary).toBe("mem = 123.5 By · gauge");
  });
});
