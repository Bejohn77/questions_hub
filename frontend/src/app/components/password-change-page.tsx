"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { fetchCurrentSession, invalidateCurrentSessionRequest } from "../api/auth-session";
import { apiFetch, readApiJson } from "../api/api-client";
import { LanguageSwitcher, ThemeSwitcher, translateUiText, useLanguage } from "../i18n/language-provider";

type User = { role: string };

export default function PasswordChangePage() {
  const router = useRouter();
  const { language } = useLanguage();
  const t = (value: string) => translateUiText(value, language);
  const [user, setUser] = useState<User | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    async function checkSession() {
      try {
        const response = await fetchCurrentSession();
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        const data = await readApiJson<{ user?: User; error?: string }>(response);
        if (!response.ok) throw new Error(data.error ?? "অ্যাকাউন্ট যাচাই করা যায়নি। আবার চেষ্টা করুন।");
        if (!data.user) throw new Error("সার্ভার অ্যাকাউন্টের তথ্য ফেরত দেয়নি।");
        if (active) setUser(data.user);
      } catch (loadError) {
        if (active) setLoadError(loadError instanceof Error ? loadError.message : "অ্যাকাউন্ট যাচাই করা যায়নি।");
      }
    }
    void checkSession();
    return () => { active = false; };
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("নতুন পাসওয়ার্ড দুটি মিলছে না।");
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await apiFetch("/api/auth/change-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(data.error ?? "পাসওয়ার্ড পরিবর্তন করা যায়নি");
      invalidateCurrentSessionRequest();
      router.replace(user?.role === "ADMIN" ? "/admin" : "/app");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "পাসওয়ার্ড পরিবর্তন করা যায়নি");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (loadError) {
    return <main className="route-check" role="alert"><p>{t(loadError)}</p><button className="public-button" type="button" onClick={() => window.location.reload()}>{t("আবার চেষ্টা করুন")}</button></main>;
  }
  if (!user) {
    return <main className="route-check" aria-live="polite"><p>{t("অ্যাকাউন্ট যাচাই করা হচ্ছে…")}</p></main>;
  }
  return (
    <main className="auth-page">
      <header className="auth-page-nav"><Link className="public-brand" href="/"><span className="public-brand-mark">Q</span><span><strong>প্রশ্নপত্র</strong><small>{t("প্রশ্নপত্র নির্মাতা")}</small></span></Link><div className="auth-page-nav-actions"><LanguageSwitcher /><ThemeSwitcher /></div></header>
      <section className="auth-page-card">
        <span className="auth-page-symbol" aria-hidden="true">✓</span>
        <p className="public-eyebrow">{t("নিরাপত্তা আপডেট")}</p>
        <h1>{t("নতুন পাসওয়ার্ড সেট করুন")}</h1>
        <p className="auth-page-description">{t("আপনার অ্যাকাউন্ট সুরক্ষিত রাখতে বর্তমান পাসওয়ার্ড বদলে একটি শক্তিশালী নতুন পাসওয়ার্ড দিন।")}</p>
        <form className="auth-page-form" onSubmit={(event) => void submit(event)}>
          <label className="auth-page-field"><span>{t("বর্তমান পাসওয়ার্ড")}</span><input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          <label className="auth-page-field"><span>{t("নতুন পাসওয়ার্ড")}</span><input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /><small>{t("কমপক্ষে ১২ অক্ষর")}</small></label>
          <label className="auth-page-field"><span>{t("নতুন পাসওয়ার্ড নিশ্চিত করুন")}</span><input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
          {error && <p className="auth-page-error" role="alert">{translateUiText(error, language)}</p>}
          <button className="public-button auth-page-submit" type="submit" disabled={isSubmitting}>{isSubmitting ? t("সংরক্ষণ হচ্ছে…") : t("পাসওয়ার্ড পরিবর্তন করুন")}</button>
        </form>
      </section>
      <footer className="auth-page-footer">{t("নতুন পাসওয়ার্ডটি অন্য কারও সঙ্গে শেয়ার করবেন না।")}</footer>
    </main>
  );
}
