import type { IncomingEvent } from "../model.js";
import { formatDuration, truncate } from "../util.js";

/**
 * Parses Sentry envelopes — the wire format the @vigilly/* SDKs tunnel to
 * `…/api/observe/<projectId>/envelope/`. An envelope is newline-delimited:
 * an envelope header, then repeating (item header, item payload) pairs.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

interface Envelope {
  header: any;
  items: { header: any; payload: any }[];
}

/** Byte-accurate envelope parse (honors item `length` when present). */
export function parseEnvelope(buf: Buffer): Envelope {
  let pos = 0;
  const readLine = (): Buffer => {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) {
      const line = buf.subarray(pos);
      pos = buf.length;
      return line;
    }
    const line = buf.subarray(pos, nl);
    pos = nl + 1;
    return line;
  };

  const header = safeJson(readLine().toString("utf8")) ?? {};
  const items: Envelope["items"] = [];
  while (pos < buf.length) {
    const hdrLine = readLine();
    if (hdrLine.length === 0) continue;
    const itemHeader = safeJson(hdrLine.toString("utf8")) ?? {};
    let payloadBuf: Buffer;
    if (typeof itemHeader.length === "number") {
      payloadBuf = buf.subarray(pos, pos + itemHeader.length);
      pos += itemHeader.length;
      if (buf[pos] === 0x0a) pos += 1;
    } else {
      payloadBuf = readLine();
    }
    const type = itemHeader.type;
    const payload =
      type === "attachment"
        ? `<attachment: ${payloadBuf.length} bytes>`
        : safeJson(payloadBuf.toString("utf8")) ?? payloadBuf.toString("utf8");
    items.push({ header: itemHeader, payload });
  }
  return { header, items };
}

/** Sentry timestamps are epoch seconds (float) or ISO strings. */
function timeToMs(t: unknown): number | undefined {
  if (t == null) return undefined;
  if (typeof t === "number") return Math.round(t * 1000);
  const parsed = Date.parse(String(t));
  return isNaN(parsed) ? undefined : parsed;
}

function serviceOf(p: any, projectId?: string): string | undefined {
  return p?.server_name || p?.environment || p?.release || projectId;
}

function messageText(p: any): string {
  if (typeof p?.message === "string") return p.message;
  const le = p?.logentry ?? p?.message;
  if (le?.formatted) return le.formatted;
  if (le?.message) return le.message;
  return "";
}

function userSummary(u: any): unknown {
  if (!u) return undefined;
  return u.email || u.username || u.id || u.ip_address || undefined;
}

function countFrames(values: any[]): number {
  return values.reduce((n, v) => n + (v?.stacktrace?.frames?.length ?? 0), 0);
}

function mapEvent(p: any, projectId?: string): IncomingEvent {
  const service = serviceOf(p, projectId);
  const ts = timeToMs(p?.timestamp);
  const level = p?.level;
  const values = p?.exception?.values;

  if (Array.isArray(values) && values.length) {
    const thrown = values[values.length - 1]; // chained exceptions: last is the thrown one
    const type = thrown?.type ?? "Error";
    const value = thrown?.value ?? "";
    return {
      source: "sentry",
      signal: "exception",
      service,
      timestamp: ts,
      summary: truncate(`${type}: ${value}`),
      attributes: {
        level,
        type,
        value,
        frames: countFrames(values),
        transaction: p?.transaction,
        environment: p?.environment,
        release: p?.release,
        tags: p?.tags,
        user: userSummary(p?.user),
        breadcrumbs: (p?.breadcrumbs?.values ?? p?.breadcrumbs)?.length,
      },
      raw: p,
    };
  }

  const msg = messageText(p);
  return {
    source: "sentry",
    signal: "log",
    service,
    timestamp: ts,
    summary: truncate(`${level ? `[${level}] ` : ""}${msg}`),
    attributes: {
      level,
      message: msg,
      environment: p?.environment,
      release: p?.release,
      tags: p?.tags,
    },
    raw: p,
  };
}

function mapTransaction(p: any, projectId?: string): IncomingEvent[] {
  const service = serviceOf(p, projectId);
  const traceCtx = p?.contexts?.trace ?? {};
  const traceId = traceCtx.trace_id;
  const start = timeToMs(p?.start_timestamp);
  const end = timeToMs(p?.timestamp);
  const durMs = start != null && end != null ? end - start : undefined;

  const out: IncomingEvent[] = [
    {
      source: "sentry",
      signal: "trace",
      service,
      timestamp: start,
      summary: truncate(
        `${p?.transaction ?? traceCtx.op ?? "transaction"}${durMs != null ? ` · ${formatDuration(durMs)}` : ""}`,
      ),
      attributes: {
        traceId,
        spanId: traceCtx.span_id,
        op: traceCtx.op,
        durationMs: durMs,
        transaction: p?.transaction,
        environment: p?.environment,
      },
      raw: p,
    },
  ];

  for (const s of p?.spans ?? []) {
    const ss = timeToMs(s.start_timestamp);
    const se = timeToMs(s.timestamp);
    const sd = ss != null && se != null ? se - ss : undefined;
    out.push({
      source: "sentry",
      signal: "trace",
      service,
      timestamp: ss,
      summary: truncate(`${s.op ?? s.description ?? "span"}${sd != null ? ` · ${formatDuration(sd)}` : ""}`),
      attributes: {
        traceId: s.trace_id ?? traceId,
        spanId: s.span_id,
        parentSpanId: s.parent_span_id,
        op: s.op,
        description: s.description,
        durationMs: sd,
      },
      raw: s,
    });
  }
  return out;
}

function mapLogItem(p: any, projectId?: string): IncomingEvent[] {
  const arr = Array.isArray(p?.items) ? p.items : Array.isArray(p) ? p : [p];
  return arr.map((l: any) => {
    const body = typeof l?.body === "string" ? l.body : JSON.stringify(l?.body ?? l);
    return {
      source: "sentry" as const,
      signal: "log" as const,
      service: projectId,
      timestamp: timeToMs(l?.timestamp),
      summary: truncate(`${l?.level ? `[${l.level}] ` : ""}${body}`),
      attributes: { level: l?.level, body, attributes: l?.attributes },
      raw: l,
    };
  });
}

/** Convert a decompressed Sentry envelope buffer into TelemetryEvents. */
export function sentryEnvelopeToEvents(buf: Buffer, projectId?: string): IncomingEvent[] {
  const { items } = parseEnvelope(buf);
  const events: IncomingEvent[] = [];
  for (const { header, payload } of items) {
    switch (header?.type) {
      case "event":
        events.push(mapEvent(payload, projectId));
        break;
      case "transaction":
        events.push(...mapTransaction(payload, projectId));
        break;
      case "log":
        events.push(...mapLogItem(payload, projectId));
        break;
      // session / client_report / attachment / check_in are not one of our four
      // signals and are intentionally skipped to keep the stream focused.
      default:
        break;
    }
  }
  return events;
}
