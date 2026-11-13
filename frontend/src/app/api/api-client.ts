const readRequestTimeoutMs = 15_000;
const pendingGetRequests = new Map<string, Promise<Response>>();

function requestKey(input: RequestInfo | URL, init: RequestInit | undefined) {
  const url = input instanceof Request ? input.url : input.toString();
  const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : "same-origin");
  return JSON.stringify([url, credentials]);
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const hasHeaders = !headers.entries().next().done;
  const shouldDeduplicate = method === "GET" && !hasHeaders;
  const key = shouldDeduplicate ? requestKey(input, init) : "";
  const existingRequest = key ? pendingGetRequests.get(key) : undefined;
  if (existingRequest) return (await existingRequest).clone();

  const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const isSessionVerification = (input instanceof Request ? input.url : input.toString()).includes("/api/auth/me");
  const timeoutSignal = method === "GET" ? AbortSignal.timeout(readRequestTimeoutMs) : undefined;
  const signal = requestSignal && timeoutSignal
    ? AbortSignal.any([requestSignal, timeoutSignal])
    : requestSignal ?? timeoutSignal;
  const requestInit = { ...init, headers, ...(signal ? { signal } : {}) };
  const request = fetch(input, requestInit);
  if (key) pendingGetRequests.set(key, request);

  try {
    return (await request).clone();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      const message = isSessionVerification
        ? "The authentication service did not respond in time. Please try again."
        : "The API request did not respond in time. Please try again.";
      throw new Error(message, { cause: error });
    }
    throw new Error("API connection failed. Verify the backend service and API_ORIGIN.", { cause: error });
  } finally {
    if (key && pendingGetRequests.get(key) === request) pendingGetRequests.delete(key);
  }
}

export async function readApiJson<T>(response: Response): Promise<T> {
  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    throw new Error(`Could not read the API response (HTTP ${response.status}). Verify backend connectivity.`, { cause: error });
  }
  if (!responseText) {
    if (response.status === 204) return undefined as T;
    throw new Error(`API returned an empty response (HTTP ${response.status}).`);
  }

  let data: unknown;
  try {
    data = JSON.parse(responseText);
  } catch (error) {
    const type = response.ok ? "successful" : "error";
    throw new Error(`API returned a non-JSON ${type} response (HTTP ${response.status}). Verify API_ORIGIN and backend logs.`, { cause: error });
  }

  return data as T;
}
