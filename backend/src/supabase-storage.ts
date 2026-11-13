import { config } from "./config";

function storageConfig() {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error("Supabase Storage is not configured");
  }
  return {
    url: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    bucket: config.supabaseStorageBucket,
  };
}

function objectUrl(ownerId: string, filename: string) {
  const { url, bucket } = storageConfig();
  const objectPath = [ownerId, filename].map(encodeURIComponent).join("/");
  return `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`;
}

function storageHeaders(contentType?: string) {
  const { serviceRoleKey } = storageConfig();
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

export async function saveQuestionImage(ownerId: string, filename: string, contentType: string, data: Buffer) {
  const body = new Uint8Array(data.length);
  body.set(data);
  const response = await fetch(objectUrl(ownerId, filename), {
    method: "POST",
    headers: { ...storageHeaders(contentType), "x-upsert": "false" },
    body: body.buffer,
  });
  if (!response.ok) {
    throw new Error(`Supabase Storage upload failed with status ${response.status}`);
  }
}

export async function readQuestionImage(ownerId: string, filename: string) {
  const response = await fetch(objectUrl(ownerId, filename), { headers: storageHeaders() });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Supabase Storage download failed with status ${response.status}`);
  }
  return {
    data: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type"),
  };
}
