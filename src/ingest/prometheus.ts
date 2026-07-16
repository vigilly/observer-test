import type { IncomingEvent } from "../model.js";
import { formatNumber, truncate } from "../util.js";

/**
 * Prometheus ingest in both directions:
 *  - scrape (pull): parse the text exposition format from an app's /metrics
 *  - remote-write (push): decoded protobuf WriteRequest -> metric events
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function parseValue(v: string): number {
  if (v === "+Inf") return Infinity;
  if (v === "-Inf") return -Infinity;
  if (v === "NaN") return NaN;
  return Number(v);
}

function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = s.replace(/^\{/, "").replace(/\}$/, "");
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    out[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  return out;
}

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
  timeMs?: number;
}

function parseSampleLine(line: string): Sample | null {
  const braceStart = line.indexOf("{");
  let name: string;
  let labels: Record<string, string> = {};
  let rest: string;
  if (braceStart !== -1) {
    const braceEnd = line.indexOf("}", braceStart);
    if (braceEnd === -1) return null;
    name = line.slice(0, braceStart).trim();
    labels = parseLabels(line.slice(braceStart, braceEnd + 1));
    rest = line.slice(braceEnd + 1).trim();
  } else {
    const sp = line.indexOf(" ");
    if (sp === -1) return null;
    name = line.slice(0, sp).trim();
    rest = line.slice(sp + 1).trim();
  }
  if (!name) return null;
  const parts = rest.split(/\s+/);
  const value = parseValue(parts[0]);
  const timeMs = parts[1] != null ? Number(parts[1]) : undefined;
  return { name, labels, value, timeMs };
}

function hostFromTarget(target?: string): string | undefined {
  if (!target) return undefined;
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

/**
 * Parse the Prometheus text exposition format, grouping samples by metric name
 * so one scrape yields one event per metric family (not per series) — enough to
 * see what's exposed without flooding the stream.
 */
export function prometheusTextToEvents(text: string, target?: string): IncomingEvent[] {
  const types = new Map<string, string>();
  const families = new Map<string, Sample[]>();

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const m = /^#\s+TYPE\s+(\S+)\s+(\S+)/.exec(line);
      if (m) types.set(m[1], m[2]);
      continue;
    }
    const sample = parseSampleLine(line);
    if (!sample) continue;
    const list = families.get(sample.name) ?? [];
    list.push(sample);
    families.set(sample.name, list);
  }

  const service = hostFromTarget(target);
  const events: IncomingEvent[] = [];
  for (const [name, samples] of families) {
    const last = samples[samples.length - 1];
    const type = types.get(name) ?? types.get(name.replace(/_(bucket|sum|count)$/, "")) ?? "untyped";
    events.push({
      source: "prometheus",
      signal: "metric",
      service,
      timestamp: last?.timeMs,
      summary: truncate(
        `${name} = ${last ? formatNumber(last.value) : "?"} · ${type}${samples.length > 1 ? ` · ${samples.length} series` : ""}`,
      ),
      attributes: {
        metric: name,
        type,
        value: last?.value,
        labels: last?.labels,
        series: samples.length,
        target,
      },
      raw: { name, type, samples },
    });
  }
  return events;
}

/** Decoded protobuf WriteRequest -> one metric event per timeseries. */
export function prometheusRemoteWriteToEvents(decoded: any): IncomingEvent[] {
  const timeseries = decoded?.timeseries ?? [];
  const events: IncomingEvent[] = [];
  for (const series of timeseries) {
    const labels: Record<string, string> = {};
    for (const l of series?.labels ?? []) labels[l.name] = l.value;
    const name = labels["__name__"] ?? "series";
    const samples = series?.samples ?? [];
    const last = samples[samples.length - 1];
    const value = last != null ? Number(last.value) : undefined;
    events.push({
      source: "prometheus",
      signal: "metric",
      service: labels["job"] || labels["service"] || labels["instance"],
      // remote-write sample timestamps are epoch ms
      timestamp: last?.timestamp != null ? Number(last.timestamp) : undefined,
      summary: truncate(`${name} = ${value != null ? formatNumber(value) : "?"} · remote_write`),
      attributes: { metric: name, labels, value, samples: samples.length },
      raw: { labels, samples },
    });
  }
  return events;
}
