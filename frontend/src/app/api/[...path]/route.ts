import { getApiOrigin } from "../api-origin";

type RouteContext = { params: Promise<{ path: string[] }> };
const authRequestTimeoutMs = 12_000;
const apiReadTimeoutMs = 15_000;

async function forwardApiRequest(request: Request, { params }: RouteContext): Promise<Response> {
  const { path } = await params;
  const isSessionRequest = path[0] === "auth" && ["admin-login", "login", "me", "change-password"].includes(path[1] ?? "");
  const requestStartedAt = performance.now();
  const timeoutMs = isSessionRequest ? authRequestTimeoutMs : request.method === "GET" ? apiReadTimeoutMs : undefined;
  let origin: string;
  try {
    origin = getApiOrigin();
  } catch (error) {
    console.error(JSON.stringify({
      event: "api_proxy_configuration_invalid",
      error: error instanceof Error ? error.message : "Unknown API_ORIGIN configuration error",
    }));
    return Response.json({ error: "API_ORIGIN is not configured correctly for the backend." }, { status: 503 });
  }
  const target = new URL(`/api/${path.map(encodeURIComponent).join("/")}${new URL(request.url).search}`, origin);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("accept-encoding");

  let upstream: Response;
  try {
    const requestBody = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: requestBody,
      ...(requestBody ? { duplex: "half" } : {}),
      ...(timeoutMs
        ? { signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) }
        : { signal: request.signal }),
      cache: "no-store",
      redirect: "manual",
    } as RequestInit & { duplex?: "half" });
  } catch (error) {
    if (timeoutMs && error instanceof DOMException && error.name === "TimeoutError") {
      console.error(JSON.stringify({
        event: "api_proxy_request_timed_out",
        method: request.method,
        path: `/api/${path.join("/")}`,
        timeoutMs,
        durationMs: Math.round(performance.now() - requestStartedAt),
      }));
      return Response.json(
        { error: isSessionRequest
          ? "The authentication service did not respond in time. Please try again."
          : "The API request did not respond in time. Please try again." },
        { status: 504 },
      );
    }
    console.error(JSON.stringify({
      event: "api_proxy_connection_failed",
      method: request.method,
      path: `/api/${path.join("/")}`,
      origin: new URL(origin).origin,
      error: error instanceof Error ? error.message : "Unknown connection error",
    }));
    return Response.json({ error: "API backend is unavailable; verify API_ORIGIN and backend health." }, { status: 502 });
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");
  if (request.method === "GET" && process.env.NODE_ENV === "development") {
    console.info(JSON.stringify({
      event: "api_proxy_response",
      path: `/api/${path.join("/")}`,
      status: upstream.status,
      durationMs: Math.round(performance.now() - requestStartedAt),
    }));
  }

  const contentType = responseHeaders.get("content-type")?.toLowerCase() ?? "";
  if (!upstream.ok && !contentType.includes("json")) {
    const responseText = await upstream.text();
    console.error(JSON.stringify({
      event: "api_proxy_non_json_error",
      method: request.method,
      path: `/api/${path.join("/")}`,
      status: upstream.status,
      contentType: contentType || null,
      responseLength: responseText.length,
    }));
    return Response.json(
      { error: "API backend returned a non-JSON error response.", status: upstream.status },
      { status: upstream.status },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = forwardApiRequest;
export const HEAD = forwardApiRequest;
export const POST = forwardApiRequest;
export const PUT = forwardApiRequest;
export const PATCH = forwardApiRequest;
export const DELETE = forwardApiRequest;
export const OPTIONS = forwardApiRequest;
