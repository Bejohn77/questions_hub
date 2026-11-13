import type { Metadata } from "next";
import "./globals.css";
import { LanguageProvider, ThemeProvider } from "./i18n/language-provider";

export const metadata: Metadata = {
  title: "প্রশ্নপত্র নির্মাতা",
  description: "বাংলা ও ইংরেজি প্রশ্নপত্র তৈরি, সাজানো ও প্রিন্ট করুন।",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="bn" data-theme="light">
      <body><LanguageProvider><ThemeProvider>{children}</ThemeProvider></LanguageProvider></body>
    </html>
  );
}
