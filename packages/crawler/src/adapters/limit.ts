import type { CrawlOptions } from './index.js';

export function resolveCrawlLimit(options?: CrawlOptions): number {
  return options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
    ? options.limit
    : Number.POSITIVE_INFINITY;
}
