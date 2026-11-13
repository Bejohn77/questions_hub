"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { apiFetch, readApiJson } from "../api/api-client";
import { invalidateCurrentSessionRequest } from "../api/auth-session";
import { LanguageSwitcher, ThemeSwitcher, translateUiText, useLanguage } from "../i18n/language-provider";

export type AuthMode = "login" | "register" | "admin" | "forgot" | "reset";

const pageCopy: Record<AuthMode, { title: string; description: string }> = {
  login: { title: "আবার স্বাগতম", description: "আপনার শিক্ষক অ্যাকাউন্টে প্রবেশ করুন।" },
  register: { title: "শিক্ষক অ্যাকাউন্ট তৈরি করুন", description: "কয়েক ধাপেই আপনার প্রশ্নপত্র তৈরির কাজ শুরু করুন।" },
  admin: { title: "অ্যাডমিন প্রবেশ", description: "অ্যাডমিন পোর্টালে প্রবেশের জন্য অনুমোদিত পরিচয় ব্যবহার করুন।" },
  forgot: { title: "পাসওয়ার্ড পুনরুদ্ধার", description: "আপনার অ্যাকাউন্টের ইমেইলে পাসওয়ার্ড রিসেট লিংক পাঠানো হবে।" },
  reset: { title: "নতুন পাসওয়ার্ড দিন", description: "নিরাপদ নতুন পাসওয়ার্ড দিয়ে আপনার অ্যাকাউন্টে প্রবেশ করুন।" },
};

const subscribeToSearch = () => () => {};
const getSearch = () => window.location.search;

export default function AuthPage({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const { language } = useLanguage();
  const search = useSyncExternalStore(subscribeToSearch, getSearch, () => "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const submissionLock = useRef(false);
  const params = new URLSearchParams(search);
  const resetToken = params.get("token") ?? "";
  const queryNotice = mode === "login" && params.get("reset") === "sent"
      ? "যদি এই ইমেইলে অ্যাকাউন্ট থাকে, রিসেট নির্দেশনা পাঠানো হয়েছে।"
      : mode === "login" && params.get("reset") === "success"
        ? "পাসওয়ার্ড পরিবর্তন হয়েছে। নতুন পাসওয়ার্ড দিয়ে সাইন ইন করুন।"
        : "";
  const [isSubmitting, setIsSubmitting] = useState(false);
  const t = (value: string) => translateUiText(value, language);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionLock.current) return;
    submissionLock.current = true;
    setError("");
    setIsSubmitting(true);
    try {
      if (mode === "forgot" || mode === "reset") {
        const response = await apiFetch(`/api/auth/${mode === "forgot" ? "forgot-password" : "reset-password"}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mode === "forgot" ? { email } : { token: resetToken, password }),
        });
        const data = await readApiJson<{ error?: string; message: string }>(response);
        if (!response.ok) throw new Error(data.error ?? "অনুরোধটি সম্পন্ন করা যায়নি");
        if (mode === "reset") invalidateCurrentSessionRequest();
        setNotice(data.message);
        return;
      }

      const endpoint = mode === "register"
        ? "/api/auth/register"
        : mode === "admin" ? "/api/auth/admin-login" : "/api/auth/login";
      const payload = mode === "register" ? { name, email, password } : { email, password };
      const isLoginRequest = mode === "admin" || mode === "login";
      const response = await apiFetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        ...(isLoginRequest ? { signal: AbortSignal.timeout(14_000) } : {}),
      });
      const data = await readApiJson<{ error?: string; user?: { role: string; mustChangePassword?: boolean } }>(response);
      if (!response.ok) throw new Error(data.error ?? "অনুরোধটি সম্পন্ন করা যায়নি");
      invalidateCurrentSessionRequest();
      if (data.user?.mustChangePassword) {
        router.replace("/change-password");
        return;
      }
      const dashboard = data.user?.role === "ADMIN" ? "/admin" : "/app";
      const requestedPath = params.get("next");
      const requestedPathAllowed = requestedPath === dashboard
        || (dashboard === "/app" && requestedPath === "/app/settings");
      router.replace(requestedPathAllowed ? requestedPath : dashboard);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "অনুরোধটি সম্পন্ন করা যায়নি");
    } finally {
      submissionLock.current = false;
      setIsSubmitting(false);
    }
  }

  const copy = pageCopy[mode];
  return (
    <main className="auth-page">
      <header className="auth-page-nav">
        <Link className="public-brand" href="/">
          <span className="public-brand-mark">Q</span>
          <span><strong>প্রশ্নপত্র</strong><small>প্রশ্নপত্র নির্মাতা</small></span>
        </Link>
        <div className="auth-page-nav-actions">
          <LanguageSwitcher />
          <ThemeSwitcher />
          <Link className="auth-home-link" href="/">{t("হোম পেজে ফিরুন")}</Link>
        </div>
      </header>
      <section className={`auth-page-card${mode === "admin" ? " admin-auth-card" : ""}`}>
        <span className="auth-page-symbol" aria-hidden="true">{mode === "admin" ? "A" : "Q"}</span>
        <p className="public-eyebrow">{t(mode === "admin" ? "নিরাপদ প্রশাসনিক প্রবেশ" : "প্রশ্নপত্র অ্যাকাউন্ট")}</p>
        <h1>{t(copy.title)}</h1>
        <p className="auth-page-description">{t(copy.description)}</p>
        <form className="auth-page-form" onSubmit={(event) => void submit(event)}>
          {mode === "register" && (
            <label className="auth-page-field">
              <span>{t("আপনার নাম")}</span>
              <input autoComplete="name" required minLength={2} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          )}
          {(mode !== "reset") && (
            <label className="auth-page-field">
              <span>{t("ইমেইল")}</span>
              <input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
          )}
          {(mode === "login" || mode === "register" || mode === "admin" || mode === "reset") && (
            <label className="auth-page-field">
              <span>{t("পাসওয়ার্ড")}</span>
              <input
                type="password"
                autoComplete={mode === "register" || mode === "reset" ? "new-password" : "current-password"}
                required
                minLength={mode === "register" || mode === "reset" ? 12 : 1}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {(mode === "register" || mode === "reset") && <small>{t("কমপক্ষে ১২ অক্ষর")}</small>}
            </label>
          )}
          {(notice || queryNotice) && <p className="auth-page-notice" role="status">{translateUiText(notice || queryNotice, language)}</p>}
          {error && <p className="auth-page-error" role="alert">{translateUiText(error, language)}</p>}
          <button className="public-button auth-page-submit" type="submit" disabled={isSubmitting}>
            {isSubmitting ? t("অপেক্ষা করুন…") :
              mode === "register" ? t("অ্যাকাউন্ট তৈরি করুন") :
                mode === "admin" ? t("অ্যাডমিন হিসেবে প্রবেশ") :
                  mode === "forgot" ? t("রিসেট লিংক পাঠান") :
                    mode === "reset" ? t("নতুন পাসওয়ার্ড সংরক্ষণ") : t("সাইন ইন")}
          </button>
        </form>
        {mode === "login" && <Link className="auth-page-muted-link" href="/forgot-password">{t("পাসওয়ার্ড ভুলে গেছেন?")}</Link>}
        {mode === "login" && <p className="auth-page-switch">{t("নতুন শিক্ষক?")} <Link href="/register">{t("নিবন্ধন করুন")}</Link></p>}
        {mode === "register" && <p className="auth-page-switch">{t("আগে থেকেই অ্যাকাউন্ট আছে?")} <Link href="/login">{t("সাইন ইন")}</Link></p>}
        {(mode === "forgot" || mode === "reset") && <p className="auth-page-switch"><Link href="/login">{t("সাইন ইন-এ ফিরে যান")}</Link></p>}
        {mode === "login" && <Link className="auth-page-admin-link" href="/admin/login">{t("অ্যাডমিন প্রবেশ")} <span aria-hidden="true">→</span></Link>}
      </section>
      <footer className="auth-page-footer">{t("আপনার অ্যাকাউন্ট ও প্রশ্নপত্র নিরাপদে সংরক্ষিত থাকে।")}</footer>
    </main>
  );
}
