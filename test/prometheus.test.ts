import { describe, it, expect } from "vitest";
import { prometheusTextToEvents, prometheusRemoteWriteToEvents } from "../src/ingest/prometheus.js";

describe("prometheus text exposition", () => {
  const text = `# HELP http_requests_total Total requests
# TYPE http_requests_total counter
http_requests_total{method="get",code="200"} 1027 1710000000000
http_requests_total{method="post",code="500"} 3
# TYPE temperature gauge
temperature 21.5
`;

  it("groups samples by metric family and applies TYPE", () => {
    const events = prometheusTextToEvents(text, "http://localhost:9090/metrics");
    const byName = Object.fromEntries(events.map((e) => [e.attributes?.metric, e]));
    expect(events).toHaveLength(2);
    expect(byName["http_requests_total"].summary).toContain("counter");
    expect(byName["http_requests_total"].attributes?.series).toBe(2);
    expect(byName["temperature"].summary).toBe("temperature = 21.5 · gauge");
    expect(byName["temperature"].service).toBe("localhost:9090");
  });

  it("parses special float values", () => {
    const [ev] = prometheusTextToEvents("# TYPE g gauge\ng +Inf\n");
    expect(ev.attributes?.value).toBe(Infinity);
  });
});

describe("prometheus remote-write", () => {
  it("maps a decoded WriteRequest to metric events", () => {
    const decoded = {
      timeseries: [
        {
          labels: [
            { name: "__name__", value: "queue_depth" },
            { name: "job", value: "worker" },
          ],
          samples: [{ value: 42, timestamp: 1710000000000 }],
        },
      ],
    };
    const [ev] = prometheusRemoteWriteToEvents(decoded);
    expect(ev.signal).toBe("metric");
    expect(ev.service).toBe("worker");
    expect(ev.summary).toBe("queue_depth = 42 · remote_write");
    expect(ev.attributes?.labels).toMatchObject({ __name__: "queue_depth", job: "worker" });
  });
});
