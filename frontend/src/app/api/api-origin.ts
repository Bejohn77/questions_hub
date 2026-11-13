export function getApiOrigin(environment: NodeJS.ProcessEnv = process.env): string {
  const apiOrigin = environment.API_ORIGIN
    ?? (environment.NODE_ENV === "production" ? undefined : "http://localhost:4000");
  if (!apiOrigin) {
    throw new Error("API_ORIGIN must be configured for production");
  }

  const parsedOrigin = new URL(apiOrigin);
  if (
    parsedOrigin.pathname !== "/"
    || parsedOrigin.search
    || parsedOrigin.hash
    || parsedOrigin.username
    || parsedOrigin.password
  ) {
    throw new Error("API_ORIGIN must be an origin without credentials, path, query, or fragment");
  }
  if (environment.NODE_ENV === "production" && parsedOrigin.protocol !== "https:") {
    throw new Error("API_ORIGIN must use HTTPS in production");
  }
  const hostname = parsedOrigin.hostname.toLowerCase();
  const reservedPlaceholder = /(^|\.)example\.(com|org|net|test)$|(^|\.)invalid$/i.test(hostname);
  const loopbackOrigin = hostname === "localhost" || hostname === "::1" || /^127\./.test(hostname);
  if (
    environment.NODE_ENV === "production"
    && (reservedPlaceholder || (loopbackOrigin && !environment.CI))
  ) {
    throw new Error("API_ORIGIN must be the real backend origin, not a placeholder or loopback address");
  }

  return parsedOrigin.origin;
}
