"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchCurrentSession, type AuthenticatedUser } from "../api/auth-session";
import { readApiJson } from "../api/api-client";
import { translateUiText, useLanguage } from "../i18n/language-provider";
import PaperMaker from "../paper-maker";

type DashboardRole = "TEACHER" | "ADMIN";

export default function ProtectedDashboard({ role, view = "editor" }: {
  role: DashboardRole;
  view?: "editor" | "question-settings";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { language } = useLanguage();
  const [authorized, setAuthorized] = useState(false);
  const [authError, setAuthError] = useState("");
  const [user, setUser] = useState<AuthenticatedUser | null>(null);

  useEffect(() => {
    let active = true;
    async function checkSession() {
      try {
        const response = await fetchCurrentSession();
        if (response.status === 401) {
          if (process.env.NODE_ENV === "development") {
            console.info(JSON.stringify({ event: "admin_authorization_result", allowed: false, reason: "unauthenticated" }));
          }
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return;
        }
        const data = await readApiJson<{ user?: AuthenticatedUser; error?: string }>(response);
        if (!response.ok) throw new Error(data.error ?? "অ্যাকাউন্ট যাচাই করা যায়নি। আবার চেষ্টা করুন।");
        if (!data.user) {
          throw new Error("সার্ভার অ্যাকাউন্টের তথ্য ফেরত দেয়নি।");
        }
        if (data.user.mustChangePassword) {
          if (process.env.NODE_ENV === "development") {
            console.info(JSON.stringify({ event: "admin_authorization_result", allowed: false, reason: "password_change_required" }));
          }
          router.replace("/change-password");
          return;
        }
        if (data.user.role !== role) {
          if (process.env.NODE_ENV === "development") {
            console.info(JSON.stringify({
              event: "admin_authorization_result",
              allowed: false,
              role: data.user.role,
              expectedRole: role,
            }));
          }
          router.replace(data.user.role === "ADMIN" ? "/admin" : "/app");
          return;
        }
        if (active) {
          setUser(data.user);
          setAuthorized(true);
          if (process.env.NODE_ENV === "development") {
            console.info(JSON.stringify({
              event: "admin_authorization_result",
              allowed: true,
              role: data.user.role,
            }));
            console.info(JSON.stringify({
              event: "auth_state_transition",
              state: "authenticated",
              role: data.user.role,
            }));
          }
        }
      } catch (error) {
        if (active) {
          if (process.env.NODE_ENV === "development") {
            console.info(JSON.stringify({
              event: "auth_state_transition",
              state: "error",
              error: error instanceof Error ? error.name : "UnknownError",
            }));
          }
          setAuthError(error instanceof Error ? error.message : "অ্যাকাউন্ট যাচাই করা যায়নি।");
        }
      }
    }
    void checkSession();
    return () => { active = false; };
  }, [pathname, role, router]);

  const renderDecision = authError
    ? "auth_error"
    : authorized && user
      ? "authenticated_dashboard"
      : "verifying";
  if (process.env.NODE_ENV === "development") {
    console.info(JSON.stringify({
      event: "protected_dashboard_render",
      decision: renderDecision,
      authorized,
      hasUser: Boolean(user),
      hasAuthError: Boolean(authError),
      expectedRole: role,
      actualRole: user?.role ?? null,
      pathname,
    }));
  }

  if (renderDecision === "auth_error") {
    return (
      <main className="route-check" role="alert">
        <p>{translateUiText(authError, language)}</p>
        <button className="public-button" type="button" onClick={() => window.location.reload()}>আবার চেষ্টা করুন</button>
      </main>
    );
  }
  if (renderDecision === "verifying" || !user) {
    return <main className="route-check" aria-live="polite"><span className="route-check-mark">Q</span><p>{translateUiText("আপনার অ্যাকাউন্ট যাচাই করা হচ্ছে…", language)}</p></main>;
  }
  return <PaperMaker initialPanel={role === "ADMIN" ? "admin" : "user"} initialUser={user} initialView={view} />;
}
