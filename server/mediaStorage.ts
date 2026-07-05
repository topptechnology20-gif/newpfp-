import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import { pool } from "./db";

type SupportedImageFile = {
  buffer: Buffer;
  mimetype?: string;
  originalname?: string;
  filename?: string;
  size?: number;
};

type MediaStorageMode = "cloudinary" | "database" | "local";

export type StoredMediaAsset = {
  id: string;
  imageUrl: string;
  filename: string;
  storageKind: MediaStorageMode;
  mimeType: string;
};

type StoredMediaRow = {
  id: string;
  mime_type: string;
  data_base64: string | null;
  local_path: string | null;
  remote_url: string | null;
  provider: string | null;
  storage_kind: string;
};

type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

function getMediaStorageMode(): MediaStorageMode {
  const raw = String(process.env.MEDIA_STORAGE_MODE || "").trim().toLowerCase();
  if (raw === "cloudinary") return "cloudinary";
  if (raw === "database" || raw === "db") return "database";
  if (raw === "local" || raw === "filesystem" || raw === "fs") return "local";
  if (getCloudinaryConfig()) return "cloudinary";
  return process.env.NODE_ENV === "production" ? "database" : "local";
}

function getCloudinaryConfig(): CloudinaryConfig | null {
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || "").trim();
  const folder = String(process.env.CLOUDINARY_UPLOAD_FOLDER || "bantah").trim();
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret, folder };
}

function getExtensionForFile(file: SupportedImageFile): string {
  const mime = String(file.mimetype || "").toLowerCase();
  if (mime && EXTENSION_BY_MIME[mime]) return EXTENSION_BY_MIME[mime];

  const rawName = String(file.originalname || file.filename || "").trim();
  const ext = rawName.includes(".") ? rawName.split(".").pop() : "";
  return ext ? ext.toLowerCase() : "bin";
}

function sanitizeFilenameBase(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "upload";
}

export async function storeUploadedImage(
  file: SupportedImageFile,
  options?: {
    userId?: string | null;
    prefix?: string;
  },
): Promise<StoredMediaAsset> {
  const mimeType = String(file.mimetype || "application/octet-stream").toLowerCase();
  const extension = getExtensionForFile(file);
  const filenameBase = sanitizeFilenameBase(options?.prefix || "upload");
  const filename = `${filenameBase}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${extension}`;
  const mode = getMediaStorageMode();

  if (mode === "cloudinary") {
    const cloudinary = getCloudinaryConfig();
    if (!cloudinary) {
      throw new Error("Cloudinary storage mode is enabled but Cloudinary credentials are missing.");
    }

    const folderPath = `${cloudinary.folder}/${filenameBase}`;
    const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudinary.cloudName}/image/upload`;
    const form = new FormData();
    form.set("folder", folderPath);
    form.set("public_id", filename.replace(/\.[^.]+$/, ""));
    form.set("resource_type", "image");
    form.set("file", new Blob([file.buffer], { type: mimeType }), filename);

    const basicAuth = Buffer.from(`${cloudinary.apiKey}:${cloudinary.apiSecret}`).toString("base64");
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
      },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Cloudinary upload failed (${response.status}): ${body || response.statusText}`);
    }

    const payload = await response.json() as { public_id?: string; secure_url?: string; url?: string };
    const remoteUrl = String(payload.secure_url || payload.url || "").trim();
    if (!remoteUrl) {
      throw new Error("Cloudinary upload succeeded but no asset URL was returned.");
    }

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO media_assets (id, original_filename, mime_type, storage_kind, remote_url, provider, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        String(file.originalname || filename),
        mimeType,
        "cloudinary",
        remoteUrl,
        "cloudinary",
        options?.userId || null,
      ],
    );

    return {
      id,
      imageUrl: remoteUrl,
      filename,
      storageKind: "cloudinary",
      mimeType,
    };
  }

  if (mode === "local") {
    const uploadDir = path.resolve(process.cwd(), "attached_assets");
    const uploadPath = path.join(uploadDir, filename);
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(uploadPath, file.buffer);

    return {
      id: filename,
      imageUrl: `/attached_assets/${filename}`,
      filename,
      storageKind: "local",
      mimeType,
    };
  }

  const id = crypto.randomUUID();
  const dataBase64 = file.buffer.toString("base64");

  await pool.query(
    `INSERT INTO media_assets (id, original_filename, mime_type, storage_kind, data_base64, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, String(file.originalname || filename), mimeType, "database", dataBase64, options?.userId || null],
  );

  return {
    id,
    imageUrl: `/api/media/${id}`,
    filename,
    storageKind: "database",
    mimeType,
  };
}

export async function getStoredMediaAsset(id: string): Promise<StoredMediaRow | null> {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return null;

  const result = await pool.query<StoredMediaRow>(
    `SELECT id, mime_type, data_base64, local_path, remote_url, provider, storage_kind
       FROM media_assets
      WHERE id = $1
      LIMIT 1`,
    [normalizedId],
  );

  return result.rows[0] || null;
}
