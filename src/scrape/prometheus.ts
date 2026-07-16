import type { EventStore } from "../model.js";
import { prometheusTextToEvents } from "../ingest/prometheus.js";

export interface ScrapeHandle {
  stop(): void;
}

/**
 * Periodically pull `/metrics` from each target and feed the text-exposition
 * parser. The first scrape fires immediately so the UI shows data right away.
 */
export function startScraper(
  store: EventStore,
  targets: string[],
  intervalMs: number,
): ScrapeHandle {
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];

  async function scrapeOne(url: string): Promise<void> {
    if (stopped) return;
    try {
      const res = await fetch(url, { headers: { accept: "text/plain; version=0.0.4" } });
      const text = await res.text();
      if (res.ok) {
        store.addMany(prometheusTextToEvents(text, url));
      } else {
        console.error(`[scrape] ${url} -> HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`[scrape] ${url} failed: ${(err as Error).message}`);
    }
  }

  for (const url of targets) {
    void scrapeOne(url);
    timers.push(setInterval(() => void scrapeOne(url), intervalMs));
  }

  return {
    stop() {
      stopped = true;
      timers.forEach(clearInterval);
    },
  };
}
