import { describe, it, expect } from "vitest";
import { parseEnvelope, sentryEnvelopeToEvents } from "../src/ingest/sentry.js";

function envelope(header: object, items: [object, object][]): Buffer {
  const lines = [JSON.stringify(header)];
  for (const [ih, payload] of items) {
    lines.push(JSON.stringify(ih));
    lines.push(JSON.stringify(payload));
  }
  return Buffer.from(lines.join("\n") + "\n");
}

describe("sentry envelope parsing", () => {
  it("parses an envelope with multiple items", () => {
    const buf = envelope({ event_id: "abc" }, [
      [{ type: "event" }, { message: "hi" }],
      [{ type: "session" }, { status: "ok" }],
    ]);
    const parsed = parseEnvelope(buf);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].header.type).toBe("event");
    expect(parsed.items[1].payload.status).toBe("ok");
  });

  it("honors an explicit item length header", () => {
    const payload = JSON.stringify({ message: "with\nnewline inside is not used here" });
    const raw =
      JSON.stringify({ event_id: "x" }) +
      "\n" +
      JSON.stringify({ type: "event", length: Buffer.byteLength(payload) }) +
      "\n" +
      payload +
      "\n";
    const parsed = parseEnvelope(Buffer.from(raw));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].payload.message).toContain("newline");
  });

  it("maps an exception event to an exception signal", () => {
    const buf = envelope({ event_id: "e1" }, [
      [
        { type: "event" },
        {
          level: "error",
          server_name: "svc-a",
          exception: {
            values: [
              { type: "TypeError", value: "boom", stacktrace: { frames: [{ filename: "a.js" }, { filename: "b.js" }] } },
            ],
          },
        },
      ],
    ]);
    const events = sentryEnvelopeToEvents(buf, "proj");
    expect(events).toHaveLength(1);
    expect(events[0].signal).toBe("exception");
    expect(events[0].source).toBe("sentry");
    expect(events[0].service).toBe("svc-a");
    expect(events[0].summary).toBe("TypeError: boom");
    expect(events[0].attributes?.frames).toBe(2);
  });

  it("maps a message event to a log and uses projectId as fallback service", () => {
    const buf = envelope({ event_id: "e2" }, [[{ type: "event" }, { level: "info", message: "hello world" }]]);
    const [ev] = sentryEnvelopeToEvents(buf, "my-proj");
    expect(ev.signal).toBe("log");
    expect(ev.service).toBe("my-proj");
    expect(ev.summary).toBe("[info] hello world");
  });

  it("maps a transaction to trace events including child spans", () => {
    const buf = envelope({ event_id: "e3" }, [
      [
        { type: "transaction" },
        {
          transaction: "GET /home",
          start_timestamp: 1000,
          timestamp: 1000.5,
          contexts: { trace: { trace_id: "t1", span_id: "s1", op: "http.server" } },
          spans: [{ op: "db.query", trace_id: "t1", span_id: "s2", parent_span_id: "s1", start_timestamp: 1000.1, timestamp: 1000.2 }],
        },
      ],
    ]);
    const events = sentryEnvelopeToEvents(buf, "proj");
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.signal === "trace")).toBe(true);
    expect(events[0].attributes?.traceId).toBe("t1");
    expect(events[1].attributes?.parentSpanId).toBe("s1");
  });
});
