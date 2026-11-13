import { apiFetch } from "./api-client";

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  mustChangePassword: boolean;
};

const sessionRequestTimeoutMs = 14_000;
let pendingSessionRequest: Promise<Response> | null = null;

export function invalidateCurrentSessionRequest() {
  pendingSessionRequest = null;
}

export async function fetchCurrentSession(): Promise<Response> {
  if (!pendingSessionRequest) {
    const requestStartedAt = performance.now();
    if (process.env.NODE_ENV === "development") {
      console.info(JSON.stringify({ event: "auth_verification_started" }));
    }
    const request = apiFetch("/api/auth/me", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(sessionRequestTimeoutMs),
    });
    const trackedRequest = request.then(
      (response) => {
        if (process.env.NODE_ENV === "development") {
          console.info(JSON.stringify({
            event: "auth_verification_response",
            status: response.status,
            durationMs: Math.round(performance.now() - requestStartedAt),
          }));
        }
        if (pendingSessionRequest === trackedRequest) pendingSessionRequest = null;
        return response;
      },
      (error: unknown) => {
        if (process.env.NODE_ENV === "development") {
          console.info(JSON.stringify({
            event: "auth_verification_failed",
            error: error instanceof Error
              ? error.cause instanceof Error ? error.cause.name : error.name
              : "UnknownError",
            durationMs: Math.round(performance.now() - requestStartedAt),
          }));
        }
        if (pendingSessionRequest === trackedRequest) pendingSessionRequest = null;
        throw error;
      },
    );
    pendingSessionRequest = trackedRequest;
  }

  return (await pendingSessionRequest).clone();
}
