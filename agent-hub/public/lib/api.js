/** Fingerprint of the UI files this page was loaded with, sent with every change so the hub can refuse an outdated page. */
let uiBuild = null;
let onOutdated = null;

export function setUiBuild(build, outdated) {
  uiBuild = build;
  onOutdated = outdated;
}

export async function api(method, url, body) {
  const options = { method, headers: { Accept: "application/json" } };
  if (method !== "GET") {
    options.headers["Content-Type"] = "application/json";
    if (uiBuild) options.headers["X-Hub-UI"] = uiBuild;
    options.body = JSON.stringify(body ?? {});
  }
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    if (data?.reload) onOutdated?.();
    const error = new Error(data?.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export const get = (url) => api("GET", url);
export const post = (url, body) => api("POST", url, body);
export const put = (url, body) => api("PUT", url, body);
export const patch = (url, body) => api("PATCH", url, body);
export const del = (url, body) => api("DELETE", url, body);
