import type { IncomingEvent } from "../model.js";
import { formatDuration, formatNumber, nanosToMs, toHex, truncate } from "../util.js";
import type { OtlpKind } from "../proto.js";

/**
 * Normalizes OTLP payloads (traces / logs / metrics) into TelemetryEvents.
 * Accepts an already-decoded object, whether it came from OTLP/JSON, decoded
 * OTLP/protobuf, or a gRPC request — snake_case and camelCase are both handled.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function camelKey(k: string): string {
  return k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** Deep-camelize object keys so protobuf (snake_case) and JSON (camelCase) unify. Ids stay bytes. */
function camelize(v: any): any {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[camelKey(k)] = camelize(val);
    return out;
  }
  return v;
}

/** OTLP AnyValue -> plain JS value. */
function anyValue(v: any): unknown {
  if (v == null || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("bytesValue" in v) return toHex(v.bytesValue);
  if ("arrayValue" in v) return (v.arrayValue?.values ?? []).map(anyValue);
  if ("kvlistValue" in v) return attrsToObject(v.kvlistValue?.values ?? []);
  return undefined;
}

/** OTLP KeyValue[] -> flat object. */
function attrsToObject(attrs: any[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) {
    if (a && typeof a.key === "string") out[a.key] = anyValue(a.value);
  }
  return out;
}

function serviceName(resource: any): string | undefined {
  const name = attrsToObject(resource?.attributes)["service.name"];
  return typeof name === "string" ? name : undefined;
}

const SPAN_KIND = ["unspecified", "internal", "server", "client", "producer", "consumer"];
function spanKind(k: unknown): string {
  const n = typeof k === "number" ? k : Number(k);
  return SPAN_KIND[n] ?? "internal";
}

const STATUS = ["unset", "ok", "error"];
function statusName(c: unknown): string | undefined {
  if (c == null) return undefined;
  return STATUS[typeof c === "number" ? c : Number(c)] ?? "unset";
}

const SEVERITY: Record<number, string> = {
  1: "TRACE", 5: "DEBUG", 9: "INFO", 13: "WARN", 17: "ERROR", 21: "FATAL",
};
function severityName(n: unknown): string | undefined {
  if (n == null) return undefined;
  const num = typeof n === "number" ? n : Number(n);
  // Round down to the nearest defined level (e.g. 10 -> INFO, 18 -> ERROR).
  for (let lvl = num; lvl >= 1; lvl--) if (SEVERITY[lvl]) return SEVERITY[lvl];
  return undefined;
}

function bodyToString(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

export function otlpTracesToEvents(payloadIn: unknown): IncomingEvent[] {
  const payload = camelize(payloadIn);
  const events: IncomingEvent[] = [];
  for (const rs of payload?.resourceSpans ?? []) {
    const service = serviceName(rs?.resource);
    const scopes = rs?.scopeSpans ?? rs?.instrumentationLibrarySpans ?? [];
    for (const ss of scopes) {
      for (const span of ss?.spans ?? []) {
        const start = nanosToMs(span.startTimeUnixNano);
        const end = nanosToMs(span.endTimeUnixNano);
        const durMs = start != null && end != null ? end - start : undefined;
        const traceId = toHex(span.traceId);
        const spanId = toHex(span.spanId);
        const status = span.status ?? {};
        events.push({
          source: "otlp",
          signal: "trace",
          service,
          timestamp: start,
          summary: truncate(`${span.name ?? "span"}${durMs != null ? ` · ${formatDuration(durMs)}` : ""}`),
          attributes: {
            traceId,
            spanId,
            parentSpanId: toHex(span.parentSpanId),
            kind: spanKind(span.kind),
            durationMs: durMs,
            status: statusName(status.code),
            statusMessage: status.message,
            ...attrsToObject(span.attributes),
          },
          raw: span,
        });
        for (const ev of span.events ?? []) {
          if (ev?.name === "exception") {
            const ea = attrsToObject(ev.attributes);
            events.push({
              source: "otlp",
              signal: "exception",
              service,
              timestamp: nanosToMs(ev.timeUnixNano) ?? start,
              summary: truncate(
                `${ea["exception.type"] ?? "Exception"}: ${ea["exception.message"] ?? ""}`,
              ),
              attributes: { traceId, spanId, span: span.name, ...ea },
              raw: ev,
            });
          }
        }
      }
    }
  }
  return events;
}

export function otlpLogsToEvents(payloadIn: unknown): IncomingEvent[] {
  const payload = camelize(payloadIn);
  const events: IncomingEvent[] = [];
  for (const rl of payload?.resourceLogs ?? []) {
    const service = serviceName(rl?.resource);
    const scopes = rl?.scopeLogs ?? rl?.instrumentationLibraryLogs ?? [];
    for (const sl of scopes) {
      for (const rec of sl?.logRecords ?? sl?.log_records ?? []) {
        const severity = rec.severityText ?? severityName(rec.severityNumber);
        const body = bodyToString(anyValue(rec.body));
        events.push({
          source: "otlp",
          signal: "log",
          service,
          timestamp: nanosToMs(rec.timeUnixNano ?? rec.observedTimeUnixNano),
          summary: truncate(`${severity ? `[${severity}] ` : ""}${body}`),
          attributes: {
            severity,
            body,
            traceId: toHex(rec.traceId),
            spanId: toHex(rec.spanId),
            ...attrsToObject(rec.attributes),
          },
          raw: rec,
        });
      }
    }
  }
  return events;
}

function dataPointValue(p: any): number {
  if (p.asDouble != null) return Number(p.asDouble);
  if (p.asInt != null) return Number(p.asInt);
  if (p.sum != null) return Number(p.sum);
  if (p.count != null) return Number(p.count);
  return NaN;
}

function metricInfo(m: any): { type: string; points: { value: number; timeMs?: number; labels: Record<string, unknown> }[] } {
  const kinds: [string, string][] = [
    ["gauge", "gauge"],
    ["sum", "sum"],
    ["histogram", "histogram"],
    ["exponentialHistogram", "exp.histogram"],
    ["summary", "summary"],
  ];
  for (const [field, type] of kinds) {
    const d = m[field];
    if (d && Array.isArray(d.dataPoints)) {
      const points = d.dataPoints.map((p: any) => ({
        value: dataPointValue(p),
        timeMs: nanosToMs(p.timeUnixNano),
        labels: attrsToObject(p.attributes),
      }));
      return { type: d.isMonotonic ? "counter" : type, points };
    }
  }
  return { type: "unknown", points: [] };
}

export function otlpMetricsToEvents(payloadIn: unknown): IncomingEvent[] {
  const payload = camelize(payloadIn);
  const events: IncomingEvent[] = [];
  for (const rm of payload?.resourceMetrics ?? []) {
    const service = serviceName(rm?.resource);
    const scopes = rm?.scopeMetrics ?? rm?.instrumentationLibraryMetrics ?? [];
    for (const sm of scopes) {
      for (const m of sm?.metrics ?? []) {
        const { type, points } = metricInfo(m);
        const last = points[points.length - 1];
        const unit = m.unit && m.unit !== "1" ? ` ${m.unit}` : ""; // "1" is OTel's dimensionless unit
        events.push({
          source: "otlp",
          signal: "metric",
          service,
          timestamp: last?.timeMs,
          summary: truncate(
            `${m.name} = ${last ? formatNumber(last.value) : "?"}${unit} · ${type}`,
          ),
          attributes: {
            metric: m.name,
            type,
            unit: m.unit || undefined,
            description: m.description || undefined,
            value: last?.value,
            labels: last?.labels,
            dataPoints: points.length,
          },
          raw: m,
        });
      }
    }
  }
  return events;
}

export function otlpToEvents(kind: OtlpKind, payload: unknown): IncomingEvent[] {
  switch (kind) {
    case "traces":
      return otlpTracesToEvents(payload);
    case "logs":
      return otlpLogsToEvents(payload);
    case "metrics":
      return otlpMetricsToEvents(payload);
  }
}
