import type { Page } from "playwright";

/**
 * Tabs left open for the human, by job id. This is a cache: after a worker restart, or
 * if the human closes a tab, it is simply empty for that job and the job starts again
 * on a new tab, where its steps skip what is already done.
 *
 * The worker never navigates, reloads or closes a parked tab. The human owns it.
 */
export interface ParkedPages {
  park(jobId: string, page: Page): void;
  /** Whether the job's tab is still open. */
  has(jobId: string): boolean;
  /** Hands the tab back for a resume, or `undefined` if it is gone. */
  take(jobId: string): Page | undefined;
}

export function createParkedPages(): ParkedPages {
  const pages = new Map<string, Page>();
  const openPage = (jobId: string): Page | undefined => {
    const page = pages.get(jobId);
    return page === undefined || page.isClosed() ? undefined : page;
  };

  return {
    park: (jobId, page) => {
      pages.set(jobId, page);
    },
    has: (jobId) => openPage(jobId) !== undefined,
    take: (jobId) => {
      const page = openPage(jobId);
      pages.delete(jobId);
      return page;
    },
  };
}
