// Shared client state, kept current by the global Server-Sent Events stream.
export const state = {
  auth: null,
  settings: null,
  repos: [],
  tasks: new Map(),
  connected: false,
};

const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notify(kind) {
  for (const listener of [...listeners]) {
    try {
      listener(kind);
    } catch (error) {
      console.error(error);
    }
  }
}

export const needsModels = () => !state.settings?.authorModel || !state.settings?.reviewerModel;
