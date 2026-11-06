// Shared client state, kept current by the global Server-Sent Events stream.
export const state = {
  auth: null,
  settings: null,
  /** The hub's version, commit and UI fingerprint when this page was loaded (GET /api/health). */
  build: null,
  repos: [],
  tasks: new Map(),
  /** Recent manager <-> sub-agent messages (oldest first). */
  comm: [],
  /** Manager monitoring info: { monitorIntervalSec, lastCheckAt, startedAt }. */
  manager: null,
  connected: false,
};

const COMM_LIMIT = 600;
const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notify(kind, payload) {
  for (const listener of [...listeners]) {
    try {
      listener(kind, payload);
    } catch (error) {
      console.error(error);
    }
  }
}

/** Adds manager messages, ignoring ones already known (by sequence number). */
export function mergeComm(entries) {
  const known = new Set(state.comm.map((entry) => entry.seq));
  const added = entries.filter((entry) => !known.has(entry.seq));
  if (!added.length) return added;
  state.comm = [...state.comm, ...added].sort((a, b) => a.seq - b.seq).slice(-COMM_LIMIT);
  return added;
}

export const needsModels = () => !state.settings?.authorModel || !state.settings?.reviewerModel;
