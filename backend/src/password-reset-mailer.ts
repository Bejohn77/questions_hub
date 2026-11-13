import nodemailer from "nodemailer";
import { config } from "./config";

export const passwordResetMailer = {
  isConfigured() {
    return Boolean(
      config.smtpHost &&
      Number.isInteger(config.smtpPort) &&
      config.smtpPort > 0 &&
      config.smtpPort <= 65535 &&
      config.smtpUser &&
      config.smtpPassword &&
      config.smtpFrom,
    );
  },

  async send(recipient: string, resetUrl: string) {
    if (!this.isConfigured()) {
      throw new Error("SMTP password reset delivery is not configured");
    }

    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      requireTLS: config.smtpPort !== 465,
      auth: { user: config.smtpUser, pass: config.smtpPassword },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    await transport.sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: "Reset your School Question Paper Generator password",
      text: `Use this link within 30 minutes to reset your password:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    });
  },
};
