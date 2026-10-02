// How a screenshot the worker recorded ("screenshots/<run-id>/<job-id>/<file>.png",
// relative to the data dir) maps to the URL the UI loads it from, and back.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAME = /^\d{4}-[a-z0-9]+(-[a-z0-9]+)*\.png$/;

const DIRECTORY = "screenshots";
const ROUTE = "/api/screenshots";

/** The URL for a recorded screenshot path. */
export function screenshotUrl(recordedPath: string): string {
  const relative = recordedPath.startsWith(`${DIRECTORY}/`)
    ? recordedPath.slice(DIRECTORY.length + 1)
    : recordedPath;
  return `${ROUTE}/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The recorded path a request's segments name, or `null` unless they are exactly
 * `<run uuid>/<job uuid>/<nnnn-label>.png`. Nothing else is ever looked up, so no
 * segment can be `..`, absolute, or anything but a screenshot file name.
 */
export function recordedPathFromSegments(segments: readonly string[]): string | null {
  const [runId, jobId, fileName, ...rest] = segments;
  if (runId === undefined || jobId === undefined || fileName === undefined || rest.length > 0) {
    return null;
  }
  if (!UUID.test(runId) || !UUID.test(jobId) || !FILE_NAME.test(fileName)) return null;
  return `${DIRECTORY}/${runId}/${jobId}/${fileName}`;
}
