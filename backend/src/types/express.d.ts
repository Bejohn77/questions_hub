import type { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; name: string; role: Role; mustChangePassword: boolean };
      sessionId?: string;
    }
  }
}

export {};