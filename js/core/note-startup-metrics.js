const MAX_LAUNCH_AGE_MS = 10 * 60 * 1000;

function roundedMilliseconds(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function cloneDetails(value = {}) {
  return structuredClone(value && typeof value === "object" ? value : {});
}

export function createNoteStartupMetrics({
  enabled = true,
  now = () => globalThis.performance?.now?.() || 0,
  timeOrigin = globalThis.performance?.timeOrigin || Date.now(),
  launchAtEpochMs = 0,
  navigationType = "navigate",
  publish = () => {}
} = {}) {
  const origin = Number(timeOrigin) || Date.now();
  const requestedLaunch = Number(launchAtEpochMs);
  const launchDelay = navigationType === "navigate" &&
    Number.isFinite(requestedLaunch) &&
    requestedLaunch > 0 &&
    origin >= requestedLaunch &&
    origin - requestedLaunch <= MAX_LAUNCH_AGE_MS
    ? origin - requestedLaunch
    : 0;
  const marks = [];
  const spans = [];
  const counters = {};
  let context = {};
  let spanSequence = 0;
  let publishedSnapshot = null;

  const elapsed = () => Math.max(0, Number(now()) || 0);
  const sinceLaunch = atMs => roundedMilliseconds(launchDelay + atMs);

  function snapshot() {
    const elapsedMs = roundedMilliseconds(elapsed());
    return {
      schemaVersion: 1,
      navigationType,
      navigationStartedAt: new Date(origin).toISOString(),
      launchToNavigationMs: roundedMilliseconds(launchDelay),
      elapsedMs,
      totalSinceLaunchMs: roundedMilliseconds(launchDelay + elapsedMs),
      context: cloneDetails(context),
      counters: cloneDetails(counters),
      marks: cloneDetails(marks),
      spans: cloneDetails(spans)
    };
  }

  function notify() {
    if (!enabled) return;
    publishedSnapshot = snapshot();
    publish(publishedSnapshot);
  }

  function mark(name, details = {}) {
    if (!enabled) return null;
    const atMs = roundedMilliseconds(elapsed());
    const entry = {
      name: String(name),
      atMs,
      sinceLaunchMs: sinceLaunch(atMs),
      details: cloneDetails(details)
    };
    marks.push(entry);
    notify();
    return cloneDetails(entry);
  }

  function startSpan(name, details = {}) {
    if (!enabled) return () => null;
    const id = ++spanSequence;
    const startMs = roundedMilliseconds(elapsed());
    let ended = false;
    return (endDetails = {}, status = "ok") => {
      if (ended) return null;
      ended = true;
      const endMs = roundedMilliseconds(elapsed());
      const entry = {
        id,
        name: String(name),
        status: String(status),
        startMs,
        endMs,
        durationMs: roundedMilliseconds(Math.max(0, endMs - startMs)),
        sinceLaunchMs: sinceLaunch(endMs),
        details: { ...cloneDetails(details), ...cloneDetails(endDetails) }
      };
      spans.push(entry);
      notify();
      return cloneDetails(entry);
    };
  }

  function increment(name, amount = 1) {
    if (!enabled) return 0;
    const key = String(name);
    counters[key] = Number(counters[key] || 0) + Number(amount || 0);
    notify();
    return counters[key];
  }

  function setContext(details = {}) {
    if (!enabled) return;
    context = { ...context, ...cloneDetails(details) };
    notify();
  }

  return {
    enabled,
    mark,
    startSpan,
    increment,
    setContext,
    snapshot: () => cloneDetails(publishedSnapshot || snapshot())
  };
}
