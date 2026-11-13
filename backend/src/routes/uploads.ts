import { randomUUID } from "node:crypto";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { config } from "../config";
import { prisma } from "../db";
import { authenticate, requirePasswordChanged } from "../middleware/auth";
import { readQuestionImage } from "../supabase-storage";

const router = Router();
router.use(authenticate, requirePasswordChanged);

const allowedTypes: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!allowedTypes[file.mimetype]) {
      callback(null, false);
      return;
    }
    callback(null, true);
  },
});

router.get("/images/:id", async (request, response) => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(request.params.id)) {
    response.status(400).json({ error: "Invalid image identifier" });
    return;
  }
  const image = await prisma.questionImage.findUnique({
    where: { id: request.params.id },
    select: { id: true, ownerId: true, mimeType: true, originalFilename: true, data: true, question: { select: { author: { select: { role: true } } } } },
  });
  if (!image) {
    response.status(404).json({ error: "Image not found" });
    return;
  }
  const isOwner = request.user!.id === image.ownerId;
  const isAdmin = request.user!.role === "ADMIN";
  const isPublicAdminQuestionImage = image.question?.author.role === "ADMIN";
  if (!isOwner && !isAdmin && !isPublicAdminQuestionImage) {
    response.status(404).json({ error: "Image not found" });
    return;
  }
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Type", image.mimeType);
  response.setHeader("Content-Disposition", `inline; filename="${image.originalFilename.replace(/["\\\r\n]/g, "_")}"`);
  response.setHeader("Cache-Control", "private, no-store");
  response.send(Buffer.from(image.data));
});

router.post("/", upload.single("image"), async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: "Image file is required" });
    return;
  }
  const signature = request.file.buffer.subarray(0, 12);
  const detectedType = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
    ? ".jpg"
    : signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? ".png"
      : signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP"
        ? ".webp"
        : null;
  if (!detectedType || detectedType !== allowedTypes[request.file.mimetype]) {
    response.status(415).json({ error: "The uploaded file is not a supported image" });
    return;
  }
  const filename = request.file.originalname.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "question-image";
  const image = await prisma.questionImage.create({
    data: {
      id: randomUUID(),
      ownerId: request.user!.id,
      originalFilename: filename,
      mimeType: request.file.mimetype,
      data: Uint8Array.from(request.file.buffer),
      size: request.file.size,
    },
    select: { id: true },
  });
  response.status(201).json({
    filename,
    url: `/api/uploads/images/${image.id}`,
    size: request.file.size,
  });
});

router.get("/:ownerId/:filename", async (request, response, next) => {
  const { ownerId, filename } = request.params;
  if (path.basename(filename) !== filename || !Object.values(allowedTypes).includes(path.extname(filename))) {
    response.status(400).json({ error: "Invalid image path" });
    return;
  }
  if (request.user!.role !== "ADMIN" && request.user!.id !== ownerId) {
    const imageUrl = `/api/uploads/${ownerId}/${filename}`;
    const referencedAdminImage = await prisma.question.findFirst({
      where: {
        authorId: ownerId,
        author: { role: "ADMIN" },
        content: { path: ["imageUrl"], equals: imageUrl },
      },
      select: { id: true },
    });
    if (!referencedAdminImage) {
      response.status(404).json({ error: "Image not found" });
      return;
    }
  }
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (config.supabaseUrl && config.supabaseServiceRoleKey) {
    const image = await readQuestionImage(ownerId, filename);
    if (!image) {
      response.status(404).json({ error: "Image not found" });
      return;
    }
    response.setHeader("Content-Type", image.contentType ?? `image/${path.extname(filename).slice(1)}`);
    response.setHeader("Cache-Control", "private, no-store");
    response.send(image.data);
    return;
  }
  const filePath = path.join(config.uploadDirectory, ownerId, filename);
  response.sendFile(filePath, (error) => {
    if (error && !response.headersSent) next(error);
  });
});

export default router;