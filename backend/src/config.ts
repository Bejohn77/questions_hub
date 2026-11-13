import "dotenv/config";
import path from "node:path";

const nodeEnv = process.env.NODE_ENV ?? "development";
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const webOriginValue = required("WEB_ORIGIN");
const parsedWebOrigin = new URL(webOriginValue);

if (parsedWebOrigin.pathname !== "/" || parsedWebOrigin.search || parsedWebOrigin.hash || parsedWebOrigin.username || parsedWebOrigin.password) {
  throw new Error("WEB_ORIGIN must be an origin without credentials, path, query, or fragment");
}
if (nodeEnv === "production" && parsedWebOrigin.protocol !== "https:") {
  throw new Error("WEB_ORIGIN must use HTTPS in production");
}

function required(name: string, minimumLength = 1): string {
  const value = process.env[name];
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} must be configured with at least ${minimumLength} characters`);
  }
  return value;
}

if (Boolean(supabaseUrl) !== Boolean(supabaseServiceRoleKey)) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured together");
}
if (nodeEnv === "production" && supabaseUrl && new URL(supabaseUrl).protocol !== "https:") {
  throw new Error("SUPABASE_URL must use HTTPS");
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET", 32),
  webOrigin: parsedWebOrigin.origin,
  smtpHost: process.env.SMTP_HOST,
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpUser: process.env.SMTP_USER,
  smtpPassword: process.env.SMTP_PASSWORD,
  smtpFrom: process.env.SMTP_FROM,
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
  uploadDirectory: path.resolve(process.env.UPLOAD_DIR ?? "./uploads"),
  supabaseUrl,
  supabaseServiceRoleKey,
  supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET ?? "question-images",
  nodeEnv,
};