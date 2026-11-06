export async function api(method, url, body) {
  const options = { method, headers: { Accept: "application/json" } };
  if (method !== "GET") {
    options.headers["Content-Type"] = "application/json";
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
