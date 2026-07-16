import { decode as msgpackDecode } from "@msgpack/msgpack";
import type { IncomingEvent } from "../model.js";
import { formatDuration, formatNumber, nanosToMs, truncate } from "../util.js";

/**
 * Datadog intake: agent logs (`/api/v2/logs`, `/v1/input`), metric series
 * (`/api/v1/series`, `/api/v2/series`), and APM traces (`/v0.3–v0.5/traces`,
 * msgpack or JSON). Everything normalizes to TelemetryEvents.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function idStr(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

/** Datadog log/metric timestamps: ms epoch (logs) or s epoch (metric points). */
function msFrom(t: unknown, unit: "ms" | "s"): number | undefined {
  if (t == null) return undefined;
  if (typeof t === "number") return unit === "s" ? Math.round(t * 1000) : Math.round(t);
  const parsed = Date.parse(String(t));
  return isNaN(parsed) ? undefined : parsed;
}

/** APM span duration is nanoseconds; return fractional ms. */
function durNsToMs(v: unknown): number | undefined {
  if (v == null) return undefined;
  try {
    return Number(BigInt(v as any)) / 1e6;
  } catch {
    const n = Number(v);
    return isFinite(n) ? n / 1e6 : undefined;
  }
}

function tagValue(tags: unknown, key: string): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  const prefix = `${key}:`;
  const hit = tags.find((t) => typeof t === "string" && t.startsWith(prefix));
  return hit ? (hit as string).slice(prefix.length) : undefined;
}

// -------- Logs --------

export function datadogLogsToEvents(body: unknown): IncomingEvent[] {
  const arr = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];
  return arr.map((l: any) => {
    const msg = typeof l?.message === "string" ? l.message : JSON.stringify(l?.message ?? l);
    const status = l?.status ?? l?.level;
    return {
      source: "datadog" as const,
      signal: "log" as const,
      service: l?.service || tagValue(l?.ddtags, "service") || l?.ddsource,
      timestamp: msFrom(l?.timestamp ?? l?.date, "ms"),
      summary: truncate(`${status ? `[${status}] ` : ""}${msg}`),
      attributes: {
        status,
        service: l?.service,
        ddsource: l?.ddsource,
        hostname: l?.hostname,
        ddtags: l?.ddtags,
      },
      raw: l,
    };
  });
}

// -------- Metrics --------

const V2_METRIC_TYPE = ["unspecified", "count", "rate", "gauge"];

function normalizeSeriesPoints(points: any): { value: number; timeMs?: number }[] {
  if (!Array.isArray(points)) return [];
  return points.map((p: any) => {
    if (Array.isArray(p)) return { timeMs: msFrom(p[0], "s"), value: Number(p[1]) }; // v1 [ts, val]
    return { timeMs: msFrom(p?.timestamp, "s"), value: Number(p?.value) }; // v2 {timestamp, value}
  });
}

export function datadogMetricsToEvents(body: any): IncomingEvent[] {
  const series = body?.series ?? [];
  const events: IncomingEvent[] = [];
  for (const s of series) {
    const points = normalizeSeriesPoints(s?.points);
    const last = points[points.length - 1];
    const type = typeof s?.type === "number" ? V2_METRIC_TYPE[s.type] ?? "gauge" : s?.type ?? "gauge";
    const host = s?.host ?? s?.resources?.find?.((r: any) => r?.type === "host")?.name;
    events.push({
      source: "datadog",
      signal: "metric",
      service: tagValue(s?.tags, "service") || host,
      timestamp: last?.timeMs,
      summary: truncate(
        `${s?.metric} = ${last ? formatNumber(last.value) : "?"}${s?.unit ? ` ${s.unit}` : ""} · ${type}`,
      ),
      attributes: {
        metric: s?.metric,
        type,
        unit: s?.unit,
        host,
        tags: s?.tags,
        value: last?.value,
        dataPoints: points.length,
      },
      raw: s,
    });
  }
  return events;
}

// -------- APM traces --------

interface DdSpan {
  service?: string;
  name?: string;
  resource?: string;
  traceId?: string;
  spanId?: string;
  parentId?: string;
  start?: unknown;
  duration?: unknown;
  error?: number;
  meta?: Record<string, unknown>;
  type?: string;
}

function ddSpanToEvents(sp: DdSpan): IncomingEvent[] {
  const startMs = nanosToMs(sp.start);
  const durMs = durNsToMs(sp.duration);
  const label = sp.resource || sp.name || "span";
  const base = {
    traceId: sp.traceId,
    spanId: sp.spanId,
    parentSpanId: sp.parentId,
    name: sp.name,
    resource: sp.resource,
    type: sp.type,
    durationMs: durMs,
    ...(sp.meta ?? {}),
  };
  const out: IncomingEvent[] = [
    {
      source: "datadog",
      signal: "trace",
      service: sp.service,
      timestamp: startMs,
      summary: truncate(`${label}${durMs != null ? ` · ${formatDuration(durMs)}` : ""}`),
      attributes: base,
      raw: sp,
    },
  ];
  const meta = sp.meta ?? {};
  if (sp.error || meta["error.msg"] || meta["error.message"] || meta["error.type"]) {
    const type = (meta["error.type"] as string) || "Error";
    const value = (meta["error.msg"] as string) || (meta["error.message"] as string) || "";
    out.push({
      source: "datadog",
      signal: "exception",
      service: sp.service,
      timestamp: startMs,
      summary: truncate(`${type}: ${value}`),
      attributes: {
        traceId: sp.traceId,
        spanId: sp.spanId,
        span: label,
        stack: meta["error.stack"],
        ...meta,
      },
      raw: sp,
    });
  }
  return out;
}

function isV05(d: any): boolean {
  return (
    Array.isArray(d) &&
    d.length === 2 &&
    Array.isArray(d[0]) &&
    (d[0].length === 0 || typeof d[0][0] === "string") &&
    Array.isArray(d[1])
  );
}

/** v0.5 uses a string table with positional span arrays. */
function v05ToEvents(decoded: [string[], any[]]): IncomingEvent[] {
  const [table, traces] = decoded;
  const S = (i: unknown): string => {
    const idx = typeof i === "bigint" ? Number(i) : (i as number);
    return (typeof idx === "number" && table[idx]) || "";
  };
  const out: IncomingEvent[] = [];
  for (const trace of traces ?? []) {
    for (const s of trace ?? []) {
      const [service, name, resource, traceID, spanID, parentID, start, duration, error, meta] = s;
      const metaObj: Record<string, unknown> = {};
      if (meta && typeof meta === "object") {
        for (const [k, v] of Object.entries(meta)) metaObj[S(Number(k))] = S(Number(v));
      }
      out.push(
        ...ddSpanToEvents({
          service: S(service),
          name: S(name),
          resource: S(resource),
          traceId: idStr(traceID),
          spanId: idStr(spanID),
          parentId: idStr(parentID),
          start,
          duration,
          error: Number(error ?? 0),
          meta: metaObj,
        }),
      );
    }
  }
  return out;
}

/** v0.3 / v0.4: array of traces, each an array of span maps. */
function v04ToEvents(traces: any[]): IncomingEvent[] {
  const out: IncomingEvent[] = [];
  for (const trace of traces ?? []) {
    for (const s of trace ?? []) {
      out.push(
        ...ddSpanToEvents({
          service: s?.service,
          name: s?.name,
          resource: s?.resource,
          traceId: idStr(s?.trace_id),
          spanId: idStr(s?.span_id),
          parentId: idStr(s?.parent_id),
          start: s?.start,
          duration: s?.duration,
          error: s?.error,
          meta: s?.meta,
          type: s?.type,
        }),
      );
    }
  }
  return out;
}

export function datadogTracesToEvents(buf: Buffer, contentType: string): IncomingEvent[] {
  let decoded: any;
  if (contentType.includes("json")) {
    decoded = JSON.parse(buf.toString("utf8"));
  } else {
    decoded = msgpackDecode(buf, { useBigInt64: true });
  }
  if (decoded == null) return [];
  return isV05(decoded) ? v05ToEvents(decoded) : v04ToEvents(decoded);
}
