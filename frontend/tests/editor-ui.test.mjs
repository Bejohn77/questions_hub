import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium } from "playwright";

const webDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PAPER_MAKER_TEST_PORT ?? 4317);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let browser;
let serverOutput = "";

function contrastRatio(foreground, background) {
  const luminance = (color) => {
    const [red, green, blue] = color.match(/[a-f\d]{2}/gi).map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function adminDashboard(overrides = {}) {
  const totals = {
    totalQuestions: 0,
    mcqQuestions: 0,
    cqQuestions: 0,
    classes: 0,
    subjects: 0,
    chapters: 0,
    topics: 0,
    registeredUsers: 0,
    admins: 0,
    activeUsers: 0,
    inactiveUsers: 0,
    ...overrides.totals,
  };
  return {
    classDistribution: [],
    subjectDistribution: [],
    recentMcqQuestions: [],
    recentCqQuestions: [],
    recentUsers: [],
    registrationTrend: [],
    questionUploadTrend: [],
    uploadStats: { attempts: 0, importedRows: 0, failedRows: 0, duplicateRows: 0 },
    recentImports: [],
    recentManualUploads: [],
    recentActivities: [],
    capabilities: { activeSessions: true, loginAudit: false, userManagement: false },
    ...overrides,
    totals,
  };
}

before(async () => {
  server = spawn(process.execPath, [
    path.join(webDirectory, "node_modules", "next", "dist", "bin", "next"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd: webDirectory,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Next.js exited before starting:\n${serverOutput}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await delay(500);
    }
  }
  if (!ready) throw new Error(`Next.js did not become ready:\n${serverOutput}`);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await Promise.race([exited, delay(5000)]);
  }
});

async function openQuestionCreator(page) {
  const navigation = page.getByRole("navigation", { name: "প্রধান নেভিগেশন" });
  await navigation.getByRole("button", { name: "প্রশ্নপত্র তৈরি", exact: true }).click();
  await page.waitForSelector(".paper-page, .section-empty");
}

async function openEditor(t) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: "teacher-1", email: "teacher@example.com", name: "Test Teacher", role: "TEACHER", mustChangePassword: false } },
  }));
  await page.route("**/api/papers", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/papers" && route.request().method() === "GET") {
      return route.fulfill({ json: { papers: [] } });
    }
    return route.continue();
  });
  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  await openQuestionCreator(page);
  return page;
}

test("teacher dashboard uses the top navigation and actual saved paper records", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: "teacher-1", email: "teacher@example.com", name: "Test Teacher", role: "TEACHER", mustChangePassword: false } },
  }));
  await page.route("**/api/papers", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/papers" && route.request().method() === "GET") {
      return route.fulfill({ json: { papers: [{
        id: "paper-1",
        title: "Term 1 examination",
        createdAt: "2026-10-01T10:00:00.000Z",
        updatedAt: "2026-10-02T10:00:00.000Z",
        _count: { items: 8 },
      }] } });
    }
    return route.continue();
  });
  await page.route("**/api/papers/paper-1", (route) => route.fulfill({
    json: {
      paper: {
        id: "paper-1",
        settings: { questionType: "MCQ", exam: "Term 1 examination", institution: "Test School" },
        items: [{ question: { id: "question-1", type: "MCQ", marks: 1, content: { text: "A saved question" } } }],
      },
    },
  }));
  await page.route("**/api/plans/subscription", (route) => route.fulfill({
    json: { subscription: { status: "ACTIVE", plan: { name: "Starter plan" } } },
  }));

  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  await page.locator(".user-panel-hero h1").waitFor();
  assert.match(await page.locator(".user-panel-hero h1").innerText(), /Test Teacher/);
  assert.equal(await page.locator(".user-creation-card").count(), 2);
  assert.equal(await page.locator(".admin-sidebar, .guest-menu").count(), 0);
  const dashboardStyles = await page.evaluate(() => ({
    heroBackground: getComputedStyle(document.querySelector(".user-panel-hero")).backgroundImage,
    heroRadius: getComputedStyle(document.querySelector(".user-panel-hero")).borderRadius,
    primary: getComputedStyle(document.querySelector(".app-shell")).getPropertyValue("--primary").trim(),
    secondary: getComputedStyle(document.querySelector(".app-shell")).getPropertyValue("--secondary").trim(),
    navigationBackground: getComputedStyle(document.querySelector(".top-navigation")).backgroundColor,
    creationColumns: getComputedStyle(document.querySelector(".user-creation-grid")).gridTemplateColumns,
    cardRadius: getComputedStyle(document.querySelector(".user-creation-card")).borderRadius,
    savedPaperRadius: getComputedStyle(document.querySelector(".user-saved-paper")).borderRadius,
    savedPaperBackground: getComputedStyle(document.querySelector(".user-saved-paper")).backgroundImage,
  }));
  assert.notEqual(dashboardStyles.heroBackground, "none");
  assert.equal(dashboardStyles.heroRadius, "22px");
  assert.equal(dashboardStyles.primary, "#287a74");
  assert.equal(dashboardStyles.secondary, "#399b91");
  assert.equal(dashboardStyles.navigationBackground, "rgba(0, 0, 0, 0)");
  assert.equal(dashboardStyles.creationColumns.trim().split(/\s+/).length, 2);
  assert.equal(dashboardStyles.cardRadius, "17px");
  assert.equal(dashboardStyles.savedPaperRadius, "13px");
  assert.notEqual(dashboardStyles.savedPaperBackground, "none");
  const navigation = page.getByRole("navigation", { name: "প্রধান নেভিগেশন" });
  for (const label of ["হোম", "প্রশ্নপত্র তৈরি", "আমার প্রশ্নপত্র", "নোটিফিকেশন"]) {
    assert.equal(await navigation.getByRole("button", { name: label, exact: true }).count(), 1);
  }
  await page.locator(".account-menu > summary").click();
  for (const label of ["আমার প্রোফাইল", "অ্যাকাউন্ট সেটিংস", "সাবস্ক্রিপশন", "সাহায্য ও সহায়তা", "লগআউট"]) {
    assert.equal(await page.getByRole("button", { name: label, exact: true }).count(), 1);
  }
  await page.getByRole("button", { name: "আমার প্রোফাইল", exact: true }).click();
  await page.locator(".user-profile-card").waitFor();
  await page.locator(".account-menu > summary").click();
  await page.getByRole("button", { name: "সাবস্ক্রিপশন", exact: true }).click();
  await page.getByText("Starter plan").waitFor();
  await navigation.getByRole("button", { name: "আমার প্রশ্নপত্র", exact: true }).click();
  await page.getByText("Term 1 examination").waitFor();
  await page.getByRole("button", { name: "প্রশ্নপত্র খুলুন" }).click();
  await page.waitForFunction(() => document.querySelector("#exam")?.value === "Term 1 examination");

  await navigation.getByRole("button", { name: "হোম", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole("button", { name: "নেভিগেশন খুলুন" }).isVisible(), true);
  const mobileGridColumns = await page.locator(".user-creation-grid").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns);
  assert.equal(mobileGridColumns.trim().split(/\s+/).length, 1);
  await page.getByRole("button", { name: "নেভিগেশন খুলুন" }).click();
  assert.equal(await page.getByRole("navigation", { name: "মোবাইল নেভিগেশন" }).isVisible(), true);
  assert.equal(await page.locator(".guest-menu").count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors.filter((message) =>
    !message.startsWith("Failed to load resource: the server responded with a status of 502")), []);
});

test("public home page links to separate authentication flows", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(".public-hero h1").waitFor();
  const homePalette = await page.locator(".public-home").evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      primary: styles.getPropertyValue("--primary").trim(),
      secondary: styles.getPropertyValue("--secondary").trim(),
      heading: getComputedStyle(element.querySelector("h1")).color,
      body: getComputedStyle(element.querySelector(".public-hero-description")).color,
    };
  });
  assert.equal(homePalette.primary, "#287a74");
  assert.equal(homePalette.secondary, "#399b91");
  assert.equal(homePalette.heading, "rgb(22, 78, 73)");
  assert.equal(homePalette.body, "rgb(49, 95, 89)");
  for (const section of ["about", "services", "features", "how-it-works", "contact"]) {
    assert.equal(await page.locator(`#${section}`).count(), 1);
  }
  assert.equal(await page.locator(".public-nav-actions a[href='/login']").getAttribute("href"), "/login");
  assert.equal(await page.locator(".public-nav-actions a[href='/register']").getAttribute("href"), "/register");
  assert.equal(await page.locator(".public-nav-actions a[href='/admin/login']").count(), 0);
  assert.equal(await page.locator(".public-nav-actions .public-login-link").evaluate((element) => getComputedStyle(element).borderRadius), "12px");
  assert.equal(await page.locator(".public-nav-actions .public-button-small").evaluate((element) => getComputedStyle(element).borderRadius), "12px");
  const widths = [];
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    widths.push(await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    })));
  }
  assert.ok(widths.every(({ viewport, content }) => content <= viewport), JSON.stringify(widths));
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  const adminSignIn = page.locator(".auth-page-admin-link");
  await adminSignIn.waitFor();
  assert.equal(await adminSignIn.getAttribute("href"), "/admin/login");
});

test("language selection translates UI, persists after refresh, and preserves question content", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(".language-switcher").waitFor();
  assert.equal(await page.locator(".language-switcher").getAttribute("aria-label"), "ভাষা");
  assert.equal(await page.locator("html").getAttribute("lang"), "bn");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("heading", { name: "Create question papers easily, quickly, beautifully" }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.equal(await page.evaluate(() => localStorage.getItem("school-question-paper-language")), "en");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Create question papers easily, quickly, beautifully" }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  const appPage = await openEditor(t);
  await appPage.getByRole("button", { name: /DEMO/ }).click();
  await appPage.waitForSelector(".paper-question p");
  const originalQuestion = await appPage.locator(".paper-question p").first().textContent();
  await appPage.getByRole("button", { name: "English", exact: true }).click();
  await appPage.waitForFunction(() => document.documentElement.lang === "en");
  assert.equal(await appPage.locator(".paper-question p").first().textContent(), originalQuestion);
  assert.ok(pageErrors.every((message) => !message.includes("418")), pageErrors.join("\n"));
});

test("theme selection covers public, auth, and editor pages and persists independently from language", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(".theme-switcher").waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.match(await page.locator(".theme-switcher").innerText(), /লাইট মোড.*ডার্ক মোড/s);
  assert.equal(await page.evaluate(() => localStorage.getItem("school-question-paper-theme")), null);

  await page.getByRole("button", { name: "ডার্ক মোড" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(16, 43, 40)");
  assert.notEqual(await page.locator(".public-service-card").first().evaluate((element) => getComputedStyle(element).backgroundImage), "none");
  assert.equal(await page.locator(".public-service-card").first().evaluate((element) => getComputedStyle(element).color), "rgb(232, 245, 241)");
  await page.mouse.move(0, 0);
  await page.waitForFunction(() =>
    getComputedStyle(document.querySelector(".public-nav-actions .public-login-link")).color === "rgb(232, 245, 241)");
  assert.equal(await page.locator(".public-nav-actions .public-login-link").evaluate((element) => getComputedStyle(element).color), "rgb(232, 245, 241)");
  assert.equal(await page.locator(".public-nav .theme-switcher button[aria-pressed=\"true\"]").evaluate((element) => getComputedStyle(element).color), "rgb(154, 219, 197)");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.equal(await page.evaluate(() => localStorage.getItem("school-question-paper-theme")), "dark");
  const responsiveWidths = [];
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator(".theme-switcher").isVisible(), true);
    if (width === 375) {
      assert.equal(await page.locator(".theme-option-compact").first().isVisible(), true);
      assert.equal(await page.locator(".theme-option-full").first().isVisible(), false);
    }
    responsiveWidths.push(await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    })));
  }
  assert.ok(responsiveWidths.every(({ viewport, content }) => content <= viewport), JSON.stringify(responsiveWidths));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark" && document.documentElement.lang === "en");
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.locator(".auth-page-card").waitFor();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  assert.notEqual(await page.locator(".auth-page-card").evaluate((element) => getComputedStyle(element).backgroundImage), "none");
  assert.equal(await page.locator(".auth-page-field input").first().evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(15, 48, 45, 0.82)");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator(".theme-switcher").isVisible(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  }
  await page.getByRole("button", { name: "Light Mode" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.equal(await page.evaluate(() => localStorage.getItem("school-question-paper-language")), "en");

  const editor = await openEditor(t);
  assert.equal(await editor.locator(".topbar .theme-switcher button[aria-pressed=\"true\"]").evaluate((element) => getComputedStyle(element).color), "rgb(255, 255, 255)");
  const glassToolbar = editor.locator(".question-preview-navbar");
  const glassStyles = await glassToolbar.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      radius: styles.borderRadius,
      background: styles.backgroundColor,
      border: styles.borderColor,
      color: styles.color,
      backdropFilter: styles.backdropFilter,
      shadow: styles.boxShadow,
    };
  });
  assert.equal(glassStyles.radius, "18px");
  assert.equal(glassStyles.background, "rgba(255, 255, 255, 0.42)");
  assert.equal(glassStyles.border, "rgba(255, 255, 255, 0.75)");
  assert.equal(glassStyles.color, "rgb(49, 95, 89)");
  assert.match(glassStyles.backdropFilter, /blur\(25px\)/);
  assert.notEqual(glassStyles.background, "rgb(255, 255, 255)");
  assert.notEqual(glassStyles.shadow, "none");
  await editor.getByRole("button", { name: "ডার্ক মোড" }).click();
  await editor.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await editor.locator(".editor-pane").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(18, 57, 52)");
  assert.equal(await editor.locator(".topbar .theme-switcher button[aria-pressed=\"true\"]").evaluate((element) => getComputedStyle(element).color), "rgb(255, 255, 255)");
  const darkGlassStyles = await glassToolbar.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    backdropFilter: getComputedStyle(element).backdropFilter,
    color: getComputedStyle(element).color,
  }));
  assert.equal(darkGlassStyles.background, "rgba(18, 57, 52, 0.72)");
  assert.match(darkGlassStyles.backdropFilter, /blur\(25px\)/);
  assert.equal(darkGlassStyles.color, "rgb(232, 245, 241)");
  assert.ok(contrastRatio("#f9fafb", "#1f2937") >= 4.5);
  assert.equal(await editor.locator(".paper-page").first().evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(255, 254, 250)");
  for (const width of [375, 768, 1440]) {
    await editor.setViewportSize({ width, height: 900 });
    assert.equal(await editor.locator(".topbar .theme-switcher").isVisible(), true);
  }
});

test("Question Preview uses one responsive glass navbar without changing Main Navbar", async (t) => {
  const page = await openEditor(t);
  const toolbar = page.locator(".question-preview-navbar");
  const mainNavbar = page.locator(".topbar");
  const lightStyles = await toolbar.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      radius: styles.borderRadius,
      background: styles.backgroundColor,
      border: styles.borderColor,
      color: styles.color,
      backdropFilter: styles.backdropFilter,
      shadow: styles.boxShadow,
    };
  });
  assert.equal(lightStyles.radius, "18px");
  assert.equal(lightStyles.background, "rgba(255, 255, 255, 0.42)");
  assert.equal(lightStyles.border, "rgba(255, 255, 255, 0.75)");
  assert.equal(lightStyles.color, "rgb(49, 95, 89)");
  assert.notEqual(lightStyles.background, "rgb(255, 255, 255)");
  assert.match(lightStyles.backdropFilter, /blur\(25px\)/);
  assert.notEqual(lightStyles.shadow, "none");
  assert.equal(await page.locator(".editor-toolbar").count(), 0,
    "the separate Secondary Navbar should be removed from the teacher editor");
  assert.equal(await page.locator(".preview-pane .question-preview-navbar").count(), 1);
  const navbarColor = await mainNavbar.evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.equal(navbarColor, "rgb(40, 122, 116)");

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if (width <= 760) {
      await page.locator(".mobile-pane-tabs:visible").getByRole("tab", { name: "প্রিভিউ" }).click();
      await page.waitForFunction(() => [...document.querySelectorAll(".work-area")]
        .some((area) => area.getClientRects().length > 0 && area.dataset.activePane === "preview"));
    }
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      toolbar: document.querySelector(".question-preview-navbar").getBoundingClientRect().toJSON(),
    }));
    assert.ok(dimensions.content <= dimensions.viewport,
      `The Secondary Navbar should not overflow at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.ok(dimensions.toolbar.width <= dimensions.viewport && dimensions.toolbar.height > 0,
      `The glass navbar should fit and remain visible at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.equal(await mainNavbar.evaluate((element) => getComputedStyle(element).backgroundColor), navbarColor);
  }

  await page.getByRole("button", { name: "ডার্ক মোড" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const darkStyles = await toolbar.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    backdropFilter: getComputedStyle(element).backdropFilter,
    color: getComputedStyle(element).color,
  }));
  assert.notEqual(darkStyles.background, "rgb(31, 41, 55)");
  assert.match(darkStyles.backdropFilter, /blur\(25px\)/);
  assert.equal(darkStyles.color, "rgb(232, 245, 241)");
  assert.equal(await mainNavbar.evaluate((element) => getComputedStyle(element).backgroundColor), navbarColor);
});

test("Question Preview navbar stays fixed while only preview content scrolls", async (t) => {
  const page = await openEditor(t);
  const scrollContent = page.locator(".preview-pane:visible .preview-scroll-content");
  await page.locator(".question-preview-navbar").getByRole("button", { name: "DEMO প্রশ্নপত্র তৈরি / খুলুন" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".page-stack .paper-page").length > 0);

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if (width <= 760) {
      await page.locator(".mobile-pane-tabs:visible").getByRole("tab", { name: "প্রিভিউ" }).click();
      await page.waitForFunction(() => [...document.querySelectorAll(".work-area")]
        .some((area) => area.getClientRects().length > 0 && area.dataset.activePane === "preview"));
    }
    const scrollMetrics = await scrollContent.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      display: getComputedStyle(element.parentElement).display,
      activePane: element.parentElement?.parentElement?.dataset.activePane,
      pane: element.parentElement?.getBoundingClientRect().toJSON(),
      workArea: element.parentElement?.parentElement?.getBoundingClientRect().toJSON(),
      workAreaStyle: {
        display: getComputedStyle(element.parentElement.parentElement).display,
        minHeight: getComputedStyle(element.parentElement.parentElement).minHeight,
        overflow: getComputedStyle(element.parentElement.parentElement).overflow,
        gridRows: getComputedStyle(element.parentElement.parentElement).gridTemplateRows,
      },
      page: element.querySelector(".paper-page")?.getBoundingClientRect().toJSON(),
    }));
    assert.ok(scrollMetrics.scrollHeight > scrollMetrics.clientHeight,
      `Question content should overflow its dedicated scroll area at ${width}px: ${JSON.stringify(scrollMetrics)}`);
    await scrollContent.evaluate((element) => { element.scrollTop = 0; });
    const before = await page.evaluate(() => ({
      pane: [...document.querySelectorAll(".preview-pane")].find((element) => element.getClientRects().length > 0).getBoundingClientRect().toJSON(),
      toolbar: [...document.querySelectorAll(".preview-toolbar")].find((element) => element.getClientRects().length > 0).getBoundingClientRect().toJSON(),
      content: [...document.querySelectorAll(".preview-scroll-content")].find((element) => element.getClientRects().length > 0).getBoundingClientRect().toJSON(),
      styles: {
        paneOverflow: getComputedStyle([...document.querySelectorAll(".preview-pane")].find((element) => element.getClientRects().length > 0)).overflowY,
        contentOverflow: getComputedStyle([...document.querySelectorAll(".preview-scroll-content")].find((element) => element.getClientRects().length > 0)).overflowY,
        toolbarPosition: getComputedStyle([...document.querySelectorAll(".preview-toolbar")].find((element) => element.getClientRects().length > 0)).position,
        toolbarZIndex: Number(getComputedStyle([...document.querySelectorAll(".preview-toolbar")].find((element) => element.getClientRects().length > 0)).zIndex),
        backdropFilter: getComputedStyle([...document.querySelectorAll(".preview-toolbar")].find((element) => element.getClientRects().length > 0)).backdropFilter,
      },
    }));
    assert.equal(before.styles.paneOverflow, "hidden");
    assert.equal(before.styles.contentOverflow, "auto");
    assert.equal(before.styles.toolbarPosition, "sticky");
    assert.ok(before.styles.toolbarZIndex > 0);
    assert.match(before.styles.backdropFilter, /blur\(25px\)/);
    assert.ok(before.toolbar.bottom <= before.content.top + 1,
      `Toolbar should not overlap scrollable question content at ${width}px: ${JSON.stringify(before)}`);
    assert.ok(before.content.height > 0);

    await scrollContent.evaluate((element) => { element.scrollTop = Math.min(240, element.scrollHeight); });
    const after = await page.evaluate(() => ({
      pane: [...document.querySelectorAll(".preview-pane")].find((element) => element.getClientRects().length > 0).getBoundingClientRect().toJSON(),
      toolbar: [...document.querySelectorAll(".preview-toolbar")].find((element) => element.getClientRects().length > 0).getBoundingClientRect().toJSON(),
      scrollTop: [...document.querySelectorAll(".preview-scroll-content")].find((element) => element.getClientRects().length > 0).scrollTop,
      paneScrollTop: [...document.querySelectorAll(".preview-pane")].find((element) => element.getClientRects().length > 0).scrollTop,
      windowScrollY: window.scrollY,
    }));
    assert.ok(after.scrollTop > 0, `Question content should scroll at ${width}px`);
    assert.equal(after.paneScrollTop, 0, "the preview container itself should not scroll");
    assert.equal(after.windowScrollY, 0, "preview scrolling should not move the browser viewport");
    assert.ok(Math.abs(after.toolbar.top - before.toolbar.top) <= 1,
      `Toolbar should remain pinned within its preview container at ${width}px: ${JSON.stringify({ before, after })}`);
    assert.ok(Math.abs(after.pane.top - before.pane.top) <= 1);
    assert.ok(Math.abs(after.pane.bottom - before.pane.bottom) <= 1);
  }
});

test("API proxy returns JSON for unreachable backend responses", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const response = await page.request.get(`${baseUrl}/api/health`);
  assert.equal(response.status(), 502);
  assert.match(response.headers()["content-type"] ?? "", /application\/json/i);
  assert.deepEqual(await response.json(), {
    error: "API backend is unavailable; verify API_ORIGIN and backend health.",
  });
});

test("authentication surfaces non-JSON API errors and network failures clearly", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route("**/api/auth/login", (route) => route.fulfill({
    status: 500,
    contentType: "text/plain",
    body: "Internal Server Error",
  }));
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("ইমেইল").fill("teacher@example.com");
  await page.getByLabel("পাসওয়ার্ড").fill("Some-Password-123");
  await page.getByRole("button", { name: "সাইন ইন", exact: true }).click();
  const nonJsonError = page.locator(".auth-page-error");
  await nonJsonError.waitFor();
  await page.waitForFunction(() => document.querySelector(".auth-page-error")?.textContent?.includes("JSON নয়"));
  assert.match(await nonJsonError.textContent(), /HTTP ৫০০/);
  assert.doesNotMatch(await nonJsonError.textContent(), /Unexpected token/);

  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await page.getByLabel("Email").waitFor();

  await page.unroute("**/api/auth/login");
  await page.route("**/api/auth/login", (route) => route.abort());
  await page.locator(".auth-page-submit").click();
  const networkError = page.locator(".auth-page-error");
  await networkError.waitFor();
  assert.match(await networkError.textContent(), /API connection failed/);
});

test("authentication pages create and route teacher/admin sessions; dashboards reject unauthorized users", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  let currentRole = "TEACHER";
  let mustChangePassword = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const request = route.request();
    if (request.method() === "POST") {
      requests.push({
        path: url.pathname,
        method: request.method(),
        body: request.postData() ? request.postDataJSON() : undefined,
      });
    }
    if (url.pathname === "/api/auth/register") {
      currentRole = "TEACHER";
      mustChangePassword = false;
      await route.fulfill({ status: 201, json: { user: { role: "TEACHER", mustChangePassword: false } } });
      return;
    }
    if (url.pathname === "/api/auth/login") {
      currentRole = "TEACHER";
      mustChangePassword = false;
      await route.fulfill({ json: { user: { role: "TEACHER", mustChangePassword: false } } });
      return;
    }
    if (url.pathname === "/api/auth/admin-login") {
      currentRole = "ADMIN";
      mustChangePassword = true;
      await route.fulfill({ json: { user: { role: "ADMIN", mustChangePassword } } });
      return;
    }
    if (url.pathname === "/api/auth/change-password") {
      mustChangePassword = false;
      await route.fulfill({ json: { message: "Password changed successfully" } });
      return;
    }
    if (url.pathname === "/api/auth/logout") {
      await route.fulfill({ status: 204 });
      return;
    }
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: {
          user: {
            id: currentRole === "ADMIN" ? "admin-1" : "teacher-1",
            email: currentRole === "ADMIN" ? "admin@example.com" : "teacher@example.com",
            name: currentRole === "ADMIN" ? "Test Admin" : "Test Teacher",
            role: currentRole,
            mustChangePassword,
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/admin/questions/dashboard") {
      await route.fulfill({
        json: adminDashboard(),
      });
      return;
    }
    if (url.pathname === "/api/admin/questions/academic") {
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    if (url.pathname === "/api/admin/questions/catalog" || url.pathname === "/api/questions/catalog") {
      await route.fulfill({ json: { classes: [], groups: [], subjects: [], chapters: [], topics: [] } });
      return;
    }
    if (url.pathname === "/api/admin/questions" && request.method() === "GET") {
      await route.fulfill({ json: { questions: [], total: 0, limit: 100, offset: 0 } });
      return;
    }
    if (url.pathname === "/api/papers/settings") {
      await route.fulfill({ json: { settings: {} } });
      return;
    }
    if (url.pathname === "/api/tokens") {
      await route.fulfill({ json: { balance: 0, tokenRates: { MCQ: 1, CQ: 10, SHORT: 5 }, transactions: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/register`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("আপনার নাম").fill("Test Teacher");
  await page.getByLabel("ইমেইল").fill("teacher@example.com");
  await page.getByLabel("পাসওয়ার্ড").fill("Strong-Teacher-Password-42");
  await page.getByRole("button", { name: "অ্যাকাউন্ট তৈরি করুন" }).click();
  await page.waitForURL("**/app");
  assert.deepEqual(requests[0], {
    path: "/api/auth/register",
    method: "POST",
    body: { name: "Test Teacher", email: "teacher@example.com", password: "Strong-Teacher-Password-42" },
  });

  await page.goto(`${baseUrl}/login?next=%2Fadmin`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("ইমেইল").fill("teacher@example.com");
  await page.getByLabel("পাসওয়ার্ড").fill("Strong-Teacher-Password-42");
  await page.getByRole("button", { name: "সাইন ইন", exact: true }).click();
  await page.waitForURL("**/app");
  assert.equal(requests[1].path, "/api/auth/login");
  assert.equal(await page.locator(".auth-dialog").count(), 0, "authentication should use the dedicated route, not a dashboard modal");

  await page.goto(`${baseUrl}/login?next=%2Fapp%2Fsettings`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("ইমেইল").fill("teacher@example.com");
  await page.getByLabel("পাসওয়ার্ড").fill("Strong-Teacher-Password-42");
  await page.getByRole("button", { name: "সাইন ইন", exact: true }).click();
  await page.waitForURL("**/app/settings");
  await page.getByRole("heading", { name: "পরীক্ষার সেটিংস" }).waitFor();

  await page.goto(`${baseUrl}/admin/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("ইমেইল").fill("admin@gmail.com");
  await page.getByLabel("পাসওয়ার্ড").fill("1234");
  await page.getByRole("button", { name: "অ্যাডমিন হিসেবে প্রবেশ" }).click();
  await page.waitForURL("**/change-password");
  await page.getByRole("heading", { name: "নতুন পাসওয়ার্ড সেট করুন" }).waitFor();
  assert.equal(requests[3].path, "/api/auth/admin-login");
  assert.deepEqual(requests[3].body, { email: "admin@gmail.com", password: "1234" });
  await page.locator(".auth-page-field input").nth(0).fill("1234");
  await page.locator(".auth-page-field input").nth(1).fill("Long-Admin-Password-42");
  await page.locator(".auth-page-field input").nth(2).fill("Long-Admin-Password-42");
  await page.getByRole("button", { name: "পাসওয়ার্ড পরিবর্তন করুন" }).click();
  await page.waitForURL("**/admin");
  assert.deepEqual(requests[4], {
    path: "/api/auth/change-password",
    method: "POST",
    body: { currentPassword: "1234", newPassword: "Long-Admin-Password-42" },
  });
  await page.waitForSelector(".admin-dashboard");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 401, json: { error: "Authentication required" } }));
  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/login?next=%2Fapp");
  assert.equal(await page.locator(".editor-pane").count(), 0, "protected dashboard content should not render before authentication");
});

test("admin login ignores duplicate submissions while authentication is processing", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  let loginRequests = 0;
  await page.route("**/api/auth/admin-login", async (route) => {
    loginRequests += 1;
    await delay(300);
    await route.fulfill({ json: { user: { role: "ADMIN", mustChangePassword: false } } });
  });
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { role: "ADMIN", mustChangePassword: false } },
  }));

  await page.goto(`${baseUrl}/admin/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("ইমেইল").fill("admin@example.com");
  await page.getByLabel("পাসওয়ার্ড").fill("Strong-Admin-Password-42");
  await page.locator(".auth-page-form").evaluate((form) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await page.waitForFunction(() => document.querySelector(".auth-page-submit")?.disabled);
  await delay(100);
  assert.equal(loginRequests, 1, "a rapid second submit must not issue another login request");
  await page.waitForURL("**/admin");
  assert.equal(loginRequests, 1);
});

test("admin dashboard uses the verified session on login, direct navigation, refresh, and logout", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  const pageErrors = [];
  const hydrationErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydration|did not match|server rendered html/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  let signedIn = false;
  let role = "ADMIN";
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    requests.push({ path: url.pathname, method });

    if (url.pathname === "/api/auth/admin-login" && method === "POST") {
      signedIn = true;
      role = "ADMIN";
      await route.fulfill({ json: { user: { role, mustChangePassword: false } } });
      return;
    }
    if (url.pathname === "/api/auth/me") {
      if (!signedIn) {
        await route.fulfill({ status: 401, json: { error: "Authentication required" } });
        return;
      }
      await route.fulfill({
        json: { user: { id: "admin-1", email: "admin@example.com", name: "Admin", role, mustChangePassword: false } },
      });
      return;
    }
    if (url.pathname === "/api/auth/logout" && method === "POST") {
      signedIn = false;
      await route.fulfill({ status: 204 });
      return;
    }
    if (url.pathname === "/api/admin/questions/dashboard") {
      await route.fulfill({
        json: adminDashboard({ totals: { totalQuestions: 5, mcqQuestions: 3, cqQuestions: 2, classes: 1, subjects: 1, chapters: 1, topics: 1, registeredUsers: 1 } }),
      });
      return;
    }
    if (url.pathname === "/api/admin/questions/academic") {
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    if (url.pathname === "/api/admin/questions/catalog") {
      await route.fulfill({ json: { classes: [], groups: [], subjects: [], chapters: [], topics: [] } });
      return;
    }
    if (url.pathname === "/api/questions/catalog") {
      await route.fulfill({ json: { classes: [], groups: [], subjects: [], chapters: [], topics: [] } });
      return;
    }
    if (url.pathname === "/api/admin/questions" && method === "GET") {
      await route.fulfill({ json: { questions: [], total: 0, limit: 100, offset: 0 } });
      return;
    }
    if (url.pathname === "/api/papers/settings") {
      await route.fulfill({ json: { settings: {} } });
      return;
    }
    if (url.pathname === "/api/tokens") {
      await route.fulfill({ json: { balance: 0, tokenRates: { MCQ: 1, CQ: 10, SHORT: 5 }, transactions: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/admin/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("ইমেইল").fill("admin@example.com");
  await page.getByLabel("পাসওয়ার্ড").fill("Strong-Admin-Password-42");
  await page.getByRole("button", { name: "অ্যাডমিন হিসেবে প্রবেশ" }).click();
  await page.waitForURL("**/admin");
  await page.locator(".admin-dashboard").waitFor();
  assert.equal(await page.getByText("আপনার অ্যাকাউন্ট যাচাই করা হচ্ছে…").count(), 0,
    "successful verification must remove the verification screen");
  assert.equal(await page.locator(".admin-dashboard").count(), 1,
    "the authenticated Admin dashboard must mount");
  assert.deepEqual(pageErrors, [], "the authenticated dashboard must not trigger React runtime errors");
  assert.deepEqual(hydrationErrors, [], "the authenticated dashboard must not trigger hydration errors");
  assert.equal(await page.locator(".admin-dashboard-stat strong").first().innerText(), "5");
  assert.equal(requests.filter(({ path }) => path === "/api/questions/catalog").length, 0,
    "user question-generation catalog data should not load in the admin panel");
  assert.equal(requests.filter(({ path }) => path === "/api/tokens").length, 0,
    "user token data should not load in the admin panel");
  const userCatalogResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/questions/catalog");
  const tokenResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/tokens");
  await page.getByRole("button", { name: "ইউজার প্যানেল" }).click();
  await Promise.all([userCatalogResponse, tokenResponse]);
  assert.equal(requests.filter(({ path }) => path === "/api/questions/catalog").length, 1);
  assert.equal(requests.filter(({ path }) => path === "/api/tokens").length, 1);
  await page.getByRole("button", { name: "অ্যাডমিন প্যানেল" }).click();
  await page.locator(".admin-dashboard-stat strong").first().waitFor();
  await page.getByRole("button", { name: "ডার্ক মোড" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await page.locator(".admin-dashboard-stat").first().evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(21, 58, 54)");
  assert.equal(await page.locator(".admin-dashboard-stat strong").first().evaluate((element) => getComputedStyle(element).color), "rgb(220, 231, 228)");
  assert.ok(contrastRatio("#dce7e4", "#102f2c") >= 4.5);
  assert.equal(requests.filter(({ path }) => path === "/api/auth/me").length, 1,
    "the verified session should initialize the dashboard without a second /me request");
  assert.ok(requests.some(({ path }) => path === "/api/admin/questions/dashboard"),
    "dashboard data should load from the root-relative API path");
  assert.ok(requests.every(({ path }) => !path.startsWith("/admin/api/")),
    "admin API requests must not be relative to /admin");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".admin-dashboard").waitFor();
  assert.equal(await page.getByText("আপনার অ্যাকাউন্ট যাচাই করা হচ্ছে…").count(), 0,
    "refreshing an authenticated route must also leave verification state");
  assert.equal(requests.filter(({ path }) => path === "/api/auth/me").length, 2,
    "a direct page refresh should verify one fresh session");

  await page.locator(".account-menu summary").click();
  await page.getByRole("button", { name: "সাইন আউট" }).click();
  await page.waitForURL(`${baseUrl}/`);
  assert.ok(requests.some(({ path, method }) => path === "/api/auth/logout" && method === "POST"));

  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/login?next=%2Fadmin");
  assert.equal(await page.locator(".admin-dashboard").count(), 0,
    "unauthenticated direct navigation must not render admin data");

  signedIn = true;
  role = "TEACHER";
  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/app");
  assert.equal(await page.getByRole("button", { name: "অ্যাডমিন প্যানেল" }).count(), 0,
    "a teacher must not see the admin panel");
});

test("admin dashboard shows API failures and retries loading its data", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  let dashboardRequests = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: "admin-1", email: "admin@example.com", name: "Admin", role: "ADMIN", mustChangePassword: false } } });
      return;
    }
    if (path === "/api/admin/questions/dashboard") {
      dashboardRequests += 1;
      if (dashboardRequests === 1) {
        await route.fulfill({ status: 503, json: { error: "Dashboard temporarily unavailable" } });
        return;
      }
      await route.fulfill({
        json: adminDashboard({ totals: { totalQuestions: 6, mcqQuestions: 4, cqQuestions: 2, classes: 1, subjects: 1, chapters: 1, topics: 1, registeredUsers: 1 } }),
      });
      return;
    }
    if (path === "/api/admin/questions/academic") {
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    if (path === "/api/admin/questions/catalog" || path === "/api/questions/catalog") {
      await route.fulfill({ json: { classes: [], groups: [], subjects: [], chapters: [], topics: [] } });
      return;
    }
    if (path === "/api/admin/questions") {
      await route.fulfill({ json: { questions: [], total: 0, limit: 100, offset: 0 } });
      return;
    }
    if (path === "/api/papers/settings") {
      await route.fulfill({ json: { settings: {} } });
      return;
    }
    if (path === "/api/tokens") {
      await route.fulfill({ json: { balance: 0, tokenRates: { MCQ: 1, CQ: 10, SHORT: 5 }, transactions: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  const dashboardError = page.locator(".admin-dashboard-error[role='alert']").filter({ hasText: "Dashboard temporarily unavailable" });
  await dashboardError.waitFor();
  await dashboardError.getByRole("button", { name: "আবার চেষ্টা করুন" }).click();
  await page.locator(".admin-dashboard").waitFor();
  assert.equal(await page.locator(".admin-dashboard-stat strong").first().innerText(), "6");
  assert.equal(dashboardRequests, 2, "retry should issue a new dashboard request");
  assert.match(await page.locator("#admin-dashboard").innerText(), /গত ৩০ দিনে কোনো প্রশ্ন যোগ করা হয়নি/);
  assert.match(await page.locator("#admin-dashboard").innerText(), /এই সময়ে কোনো নতুন নিবন্ধন নেই/);
});

test("admin dashboard presents database metrics, activity, shortcuts, and responsive layout", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  let dashboardRequests = 0;
  let academicRequests = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: "admin-1", email: "admin@example.com", name: "Admin", role: "ADMIN", mustChangePassword: false } } });
      return;
    }
    if (path === "/api/admin/questions/dashboard") {
      dashboardRequests += 1;
      await route.fulfill({ json: adminDashboard({
        totals: { totalQuestions: 12, mcqQuestions: 8, cqQuestions: 4, classes: 3, subjects: 5, chapters: 7, topics: 9, registeredUsers: 14, admins: 2, activeUsers: 6, inactiveUsers: 8 },
        classDistribution: [{ name: "Class 9", count: 8 }, { name: "Class 10", count: 4 }],
        subjectDistribution: [{ name: "Physics", count: 8 }],
        recentMcqQuestions: [{
          id: "question-1",
          type: "MCQ",
          classLevel: "Class 9",
          subject: "Physics",
          chapter: "Motion",
          marks: 1,
          createdAt: "2025-01-03T00:00:00.000Z",
          content: { text: "What is velocity?" },
          author: { name: "Admin", email: "admin@example.com" },
        }],
        recentCqQuestions: [{
          id: "question-cq",
          type: "CQ",
          classLevel: "Class 9",
          subject: "Physics",
          chapter: "Motion",
          marks: 10,
          createdAt: "2025-01-03T00:00:00.000Z",
          content: { text: "Explain acceleration." },
          author: { name: "Admin", email: "admin@example.com" },
        }],
        recentUsers: [{ id: "teacher-1", name: "Teacher One", email: "teacher@example.com", role: "TEACHER", createdAt: "2025-01-02T00:00:00.000Z" }],
        registrationTrend: [{ day: "2025-01-02T00:00:00.000Z", count: 1 }],
        questionUploadTrend: [{ day: "2025-01-02T00:00:00.000Z", mcqCount: 2, cqCount: 1 }],
        uploadStats: { attempts: 3, importedRows: 22, failedRows: 2, duplicateRows: 1 },
        recentImports: [{
          id: "import-1",
          filename: "physics.csv",
          questionType: "MCQ",
          status: "COMPLETED",
          totalRows: 10,
          importedRows: 10,
          failedRows: 0,
          createdAt: "2025-01-03T00:00:00.000Z",
          admin: { name: "Admin", email: "admin@example.com" },
        }],
        recentManualUploads: [{
          id: "activity-manual-1",
          action: "CREATE_QUESTION",
          entityType: "Question",
          entityId: "question-1",
          createdAt: "2025-01-03T00:00:00.000Z",
          details: { type: "MCQ" },
          admin: { name: "Admin", email: "admin@example.com" },
        }],
        recentActivities: [{
          id: "activity-1",
          action: "DELETE_QUESTION",
          entityType: "Question",
          entityId: "question-old",
          createdAt: "2025-01-03T00:00:00.000Z",
          details: null,
          admin: { name: "Admin", email: "admin@example.com" },
        }],
      }) });
      return;
    }
    if (path === "/api/admin/questions/academic") {
      academicRequests += 1;
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    if (path === "/api/admin/questions/catalog" || path === "/api/questions/catalog") {
      await route.fulfill({ json: { classes: [], groups: [], subjects: [], chapters: [], topics: [] } });
      return;
    }
    if (path === "/api/admin/questions" && route.request().method() === "GET") {
      await route.fulfill({ json: { questions: [], total: 0, limit: 100, offset: 0 } });
      return;
    }
    if (path === "/api/papers/settings") {
      await route.fulfill({ json: { settings: {} } });
      return;
    }
    if (path === "/api/tokens") {
      await route.fulfill({ json: { balance: 0, tokenRates: { MCQ: 1, CQ: 10, SHORT: 5 }, transactions: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  const dashboard = page.locator("#admin-dashboard");
  await dashboard.waitFor();
  await dashboard.locator(".admin-dashboard-stat").first().waitFor();
  assert.equal(await dashboard.locator(".admin-dashboard-stat").count(), 8);
  assert.match(await dashboard.innerText(), /মোট প্রশ্ন[\s\S]*12/);
  assert.match(await dashboard.innerText(), /স্বাগতম, Admin/);
  assert.match(await dashboard.innerText(), /Teacher One/);
  assert.match(await dashboard.innerText(), /What is velocity\?/);
  assert.match(await dashboard.innerText(), /physics\.csv/);
  assert.match(await dashboard.innerText(), /সফল সারি[\s\S]*22/);
  assert.match(await dashboard.innerText(), /সক্রিয় সেশন[\s\S]*6/);
  assert.equal(await dashboard.locator(".admin-dashboard-panel").count(), 7);
  assert.equal(await dashboard.locator(".admin-question-trend .admin-trend-day").count(), 1);
  assert.equal(await dashboard.locator(".admin-dashboard-legend").count(), 2);
  assert.equal(await dashboard.locator(".admin-dashboard-filter button").count(), 2);
  assert.equal(await dashboard.locator(".admin-dashboard-actions a[href='#questions']").count(), 1);
  assert.equal(await dashboard.locator(".admin-dashboard-actions a[href='#admin-user-statistics']").count(), 1);

  await dashboard.getByRole("button", { name: "Question Upload · MCQ", exact: true }).click();
  assert.equal(await page.locator('input[name="question-upload-type"][value="MCQ"]').isChecked(), true);
  await page.locator('input[name="question-upload-type"][value="CQ"]').check();
  assert.equal(await page.locator('input[name="question-upload-type"][value="CQ"]').isChecked(), true);
  await dashboard.getByRole("button", { name: "MCQ হাতে যোগ", exact: true }).click();
  await dashboard.getByRole("button", { name: "CQ হাতে যোগ", exact: true }).click();
  await page.locator("#bank-type").selectOption("");
  assert.equal(await page.locator("#questions .question-card").count(), 2);
  await dashboard.getByRole("link", { name: "প্রশ্ন পরিচালনা" }).click();
  assert.equal(new URL(page.url()).hash, "#questions");
  await dashboard.getByRole("link", { name: "ব্যবহারকারী দেখুন" }).click();
  assert.equal(new URL(page.url()).hash, "#admin-user-statistics");
  await dashboard.locator(".admin-dashboard-filter").getByRole("button", { name: "CQ", exact: true }).click();
  assert.match(await dashboard.locator(".admin-dashboard-wide").innerText(), /Explain acceleration\./);
  assert.doesNotMatch(await dashboard.locator(".admin-dashboard-wide").innerText(), /What is velocity\?/);

  const dashboardRequestsBeforeRefresh = dashboardRequests;
  const academicRequestsBeforeRefresh = academicRequests;
  const refreshResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/admin/questions/dashboard");
  await dashboard.getByRole("button", { name: "ড্যাশবোর্ড রিফ্রেশ" }).click();
  await refreshResponse;
  assert.equal(dashboardRequests, dashboardRequestsBeforeRefresh + 1);
  assert.equal(academicRequests, academicRequestsBeforeRefresh, "dashboard refresh should not reload unrelated academic data");

  const widths = [];
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    widths.push(await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    })));
    assert.equal(await page.locator(".admin-sidebar").isVisible(), true);
    assert.equal(await page.locator("#admin-dashboard").isVisible(), true);
  }
  assert.ok(widths.every(({ viewport, content }) => content <= viewport), JSON.stringify(widths));

  await page.setViewportSize({ width: 1440, height: 1000 });
  const lightInk = await page.locator(".app-shell").evaluate((element) => getComputedStyle(element).getPropertyValue("--ink").trim());
  assert.equal(lightInk, "#164e49");
  await page.getByRole("button", { name: "ডার্ক মোড" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const darkColors = await page.locator(".app-shell").evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      ink: styles.getPropertyValue("--ink").trim(),
      surface: styles.getPropertyValue("--surface").trim(),
      panel: getComputedStyle(element.querySelector(".admin-dashboard-panel")).backgroundColor,
      heading: getComputedStyle(element.querySelector(".admin-dashboard-panel h3")).color,
      body: getComputedStyle(element.querySelector(".admin-dashboard-welcome p:last-child")).color,
      navigation: getComputedStyle(element.querySelector(".topbar")).backgroundColor,
    };
  });
  assert.equal(darkColors.ink, "#dce7e4");
  assert.equal(darkColors.surface, "#153a36");
  assert.equal(darkColors.panel, "rgb(21, 58, 54)");
  assert.equal(darkColors.heading, "rgb(220, 231, 228)");
  assert.equal(darkColors.body, "rgb(182, 199, 195)");
  assert.equal(darkColors.navigation, "rgb(18, 59, 54)");
  assert.ok(contrastRatio("#b6c7c3", "#102b28") >= 4.5);
  assert.ok(contrastRatio("#b6c7c3", "#153a36") >= 4.5);
  assert.ok(contrastRatio("#94aaa5", "#153a36") >= 4.5);
});

test("overlapping admin dashboard loads share one in-flight API request", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  let dashboardRequests = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") {
      await route.fulfill({
        json: { user: { id: "admin-1", email: "admin@example.com", name: "Admin", role: "ADMIN", mustChangePassword: false } },
      });
      return;
    }
    if (path === "/api/admin/questions/dashboard") {
      dashboardRequests += 1;
      await delay(2_000);
      await route.fulfill({
        json: adminDashboard({ totals: { totalQuestions: 3, mcqQuestions: 2, cqQuestions: 1, classes: 1, subjects: 1, chapters: 1, topics: 1, registeredUsers: 1 } }),
      });
      return;
    }
    if (path === "/api/admin/questions/academic") {
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    if (path === "/api/admin/questions/catalog") {
      await route.fulfill({ json: { classes: [], groups: [], subjects: [], chapters: [], topics: [] } });
      return;
    }
    if (path === "/api/admin/questions") {
      await route.fulfill({ json: { questions: [], total: 0, limit: 100, offset: 0 } });
      return;
    }
    if (path === "/api/papers/settings") {
      await route.fulfill({ json: { settings: {} } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  const dashboardRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/admin/questions/dashboard");
  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  await dashboardRequest;
  await page.getByRole("button", { name: "ইউজার প্যানেল" }).click();
  await page.getByRole("button", { name: "অ্যাডমিন প্যানেল" }).click();
  await page.locator(".admin-dashboard-stat strong").first().waitFor();
  assert.equal(dashboardRequests, 1, "overlapping GETs for the same dashboard data should be deduplicated");
  assert.equal(await page.locator(".admin-dashboard-stat strong").first().innerText(), "3");
});

test("admin dashboard reports when a data request times out", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (milliseconds) => timeout(Math.min(milliseconds, 50));
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") {
      await route.fulfill({
        json: { user: { id: "admin-1", email: "admin@example.com", name: "Admin", role: "ADMIN", mustChangePassword: false } },
      });
      return;
    }
    if (path === "/api/admin/questions/dashboard") {
      await delay(250);
      try {
        await route.fulfill({ json: adminDashboard() });
      } catch {
        return;
      }
      return;
    }
    if (path === "/api/admin/questions/academic") {
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    if (path === "/api/admin/questions/catalog") {
      await route.fulfill({ json: { classes: [], groups: [], subjects: [], chapters: [], topics: [] } });
      return;
    }
    if (path === "/api/admin/questions") {
      await route.fulfill({ json: { questions: [], total: 0, limit: 100, offset: 0 } });
      return;
    }
    if (path === "/api/papers/settings") {
      await route.fulfill({ json: { settings: {} } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  const timeoutErrors = page.locator(".admin-dashboard-error[role='alert']")
    .filter({ hasText: "API অনুরোধটি সময়মতো সাড়া দেয়নি" });
  await timeoutErrors.first().waitFor();
  assert.ok(await timeoutErrors.count() >= 1);
  assert.equal(await page.getByText("আপনার অ্যাকাউন্ট যাচাই করা হচ্ছে…").count(), 0);
});

test("admin login displays a credential error and clears loading after a 401 response", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route("**/api/auth/admin-login", (route) => route.fulfill({
    status: 401,
    json: { error: "Email or password is incorrect" },
  }));
  await page.goto(`${baseUrl}/admin/login`, { waitUntil: "domcontentloaded" });
  const inputs = page.locator(".auth-page-field input");
  await inputs.nth(0).fill("admin@example.com");
  await inputs.nth(1).fill("Incorrect-Password");
  await page.locator(".auth-page-submit").click();

  const loginError = page.locator(".auth-page-error");
  await loginError.waitFor();
  assert.match(await loginError.innerText(), /ইমেইল অথবা পাসওয়ার্ড সঠিক নয়/);
  assert.equal(await page.locator(".auth-page-submit").isEnabled(), true);
  assert.equal(new URL(page.url()).pathname, "/admin/login");
});

test("admin dashboard shows an error when account verification times out", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (milliseconds) => timeout(Math.min(milliseconds, 50));
  });
  await page.route("**/api/auth/me", async (route) => {
    await delay(250);
    try {
      await route.fulfill({ json: { user: { role: "ADMIN", mustChangePassword: false } } });
    } catch {
      // The client has already aborted its timed-out verification request.
    }
  });

  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  const verificationError = page.locator(".route-check[role='alert']");
  await verificationError.waitFor();
  assert.match(await verificationError.innerText(), /অ্যাকাউন্ট যাচাই সেবা সময়মতো সাড়া দেয়নি/);
  assert.equal(await page.getByText("আপনার অ্যাকাউন্ট যাচাই করা হচ্ছে…").count(), 0);
});

test("MathLive mounts after hydration without changing server-rendered markup", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const hydrationErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydration|did not match|server rendered html/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (/hydration|did not match|server rendered html/i.test(error.message)) {
      hydrationErrors.push(error.message);
    }
  });

  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: "teacher-1", email: "teacher@example.com", name: "Test Teacher", role: "TEACHER" } },
  }));
  const response = await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  assert.ok(response);
  assert.doesNotMatch(await response.text(), /<math-field\b/i,
    "server markup should contain stable hosts rather than custom elements that MathLive mutates");
  await openQuestionCreator(page);
  await page.waitForFunction(() =>
    document.querySelectorAll(".measure-layer .paper-equation math-field").length > 1,
  );
  const fields = await page.locator(".measure-layer .paper-equation math-field").evaluateAll((elements) =>
    elements.map((element) => ({
      value: element.value,
      readOnly: element.readOnly,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    })),
  );
  assert.ok(fields.length > 1, "multiple measurement equations should initialize");
  assert.ok(fields.every(({ value, readOnly, width, height }) =>
    value && readOnly && width > 0 && height > 0), JSON.stringify(fields));
  assert.deepEqual(hydrationErrors, []);
});

test("MathLive fonts load from production assets without runtime font errors", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const fontResponses = [];
  const mathLiveErrors = [];
  page.on("response", (response) => {
    if (/KaTeX_.*\.woff2(?:$|\?)/i.test(response.url())) {
      fontResponses.push({ url: response.url(), status: response.status() });
    }
  });
  page.on("console", (message) => {
    if (/MathLive.*math fonts could not be loaded/i.test(message.text())) {
      mathLiveErrors.push(message.text());
    }
  });

  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: "teacher-1", email: "teacher@example.com", name: "Test Teacher", role: "TEACHER" } },
  }));
  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--ML__static-fonts").trim(),
  ), "true");
  const loadedFonts = await page.evaluate(async () => {
    const mathLiveFaces = [...document.fonts].filter((face) =>
      face.family.replace(/["']/g, "").startsWith("KaTeX_"),
    );
    return Promise.all(mathLiveFaces.map(async (face) => {
      await face.load();
      return { family: face.family, status: face.status };
    }));
  });
  assert.equal(loadedFonts.length, 20, "all MathLive font faces should be declared in the bundled stylesheet");
  assert.ok(loadedFonts.every(({ status }) => status === "loaded"), JSON.stringify(loadedFonts));
  assert.equal(fontResponses.length, 20, "every bundled MathLive font asset should be requested");
  assert.ok(fontResponses.every(({ status }) => status === 200), JSON.stringify(fontResponses));
  assert.deepEqual(mathLiveErrors, []);
});

test("paper generation previews the requested question count and charges on confirmed generation", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const generatedRequests = [];
  const catalogRequests = [];
  const question = {
    id: "generator-question",
    type: "MCQ",
    marks: 5,
    classLevel: "Class 9",
    group: "Science",
    subject: "Physics",
    chapter: "Motion",
    topic: "Speed",
    content: { text: "What is velocity?", options: ["Rate of displacement", "Force"] },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: "teacher-1", email: "teacher@example.com", name: "Teacher", role: "TEACHER" } } });
      return;
    }
    if (url.pathname === "/api/tokens" && request.method() === "GET") {
      await route.fulfill({ json: { balance: 100, tokenRates: { MCQ: 1, CQ: 10, SHORT: 5 }, transactions: [] } });
      return;
    }
    if (url.pathname === "/api/questions/catalog") {
      catalogRequests.push({
        classLevel: url.searchParams.get("classLevel"),
        subject: url.searchParams.get("subject"),
        chapter: url.searchParams.get("chapter"),
      });
      const classLevel = url.searchParams.get("classLevel");
      const subject = url.searchParams.get("subject");
      const chapter = url.searchParams.get("chapter");
      if (chapter) {
        await route.fulfill({
          json: {
            classes: [classLevel],
            groups: ["Science"],
            subjects: [subject],
            chapters: [chapter],
            topics: chapter === "Motion" ? ["Speed"] : ["Balanced forces"],
          },
        });
      } else if (subject) {
        await route.fulfill({
          json: {
            classes: [classLevel],
            groups: ["Science"],
            subjects: [subject],
            chapters: classLevel === "Class 9"
              ? subject === "Physics" ? ["Motion", "Forces"] : ["Cells"]
              : ["Atoms"],
            topics: [],
          },
        });
      } else if (classLevel) {
        await route.fulfill({
          json: {
            classes: [classLevel],
            groups: ["Science"],
            subjects: classLevel === "Class 9" ? ["Biology", "Physics"] : ["Chemistry"],
            chapters: [],
            topics: [],
          },
        });
      } else {
        await route.fulfill({
          json: {
            classes: ["Class 9", "Class 10"],
            groups: ["Science"],
            subjects: ["Physics", "Chemistry"],
            chapters: [],
            topics: [],
          },
        });
      }
      return;
    }
    if (url.pathname === "/api/questions" && request.method() === "GET") {
      await route.fulfill({ json: { questions: [], total: 0 } });
      return;
    }
    if (url.pathname === "/api/papers/preview") {
      const body = request.postDataJSON();
      assert.equal(body.classLevel, "Class 9");
      assert.equal(body.subject, "Physics");
      assert.deepEqual(body.chapters, []);
      assert.deepEqual(body.topics, []);
      if (body.mode === "manual" && body.questionIds.length === 0) {
        await route.fulfill({
          json: { questions: [], candidates: [question], totalMarks: 0, estimatedTokens: 0, balance: 95, affordable: true },
        });
        return;
      }
      if (body.mode === "manual") {
        assert.deepEqual(body.questionIds, [question.id]);
        await route.fulfill({
          json: { questions: [question], candidates: [question], totalMarks: 5, estimatedTokens: 1, balance: 95, affordable: true },
        });
        return;
      }
      if (body.questionCount > 1) {
        await route.fulfill({
          status: 422,
          json: { error: "Insufficient eligible questions: 1 available, 2 requested", availableCount: 1 },
        });
        return;
      }
      await route.fulfill({
        json: { questions: [question], totalMarks: 5, estimatedTokens: 1, balance: 100, affordable: true },
      });
      return;
    }
    if (url.pathname === "/api/papers/generate") {
      generatedRequests.push(request.postDataJSON());
      await route.fulfill({
        status: 201,
        json: {
          paper: { id: "paid-paper", settings: { className: "Class 9", subject: "Physics" }, items: [{ question }] },
          totalMarks: 5,
          chargedTokens: 1,
          balance: 95,
          duplicate: false,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  await openQuestionCreator(page);
  const workspaceStyles = await page.evaluate(() => {
    const shell = document.querySelector(".user-panel-shell");
    const editor = document.querySelector(".editor-pane");
    const preview = document.querySelector(".preview-pane");
    const toolbar = document.querySelector(".preview-toolbar");
    const paper = document.querySelector(".page-stack .paper-page");
    const editorRect = editor.getBoundingClientRect();
    const workspaceRect = document.querySelector(".work-area").getBoundingClientRect();
    const paperRect = paper.getBoundingClientRect();
    return {
      navbar: getComputedStyle(document.querySelector(".topbar")).backgroundColor,
      workspaceColumns: editorRect.width / workspaceRect.width,
      editorOverflow: getComputedStyle(editor).overflowY,
      previewOverflow: getComputedStyle(preview).overflowY,
      toolbarRadius: getComputedStyle(toolbar).borderRadius,
      paperWidthHeightRatio: paperRect.width / paperRect.height,
      shellBackground: getComputedStyle(shell).backgroundColor,
    };
  });
  assert.equal(workspaceStyles.navbar, "rgb(40, 122, 116)");
  assert.ok(workspaceStyles.workspaceColumns > 0.37 && workspaceStyles.workspaceColumns < 0.43,
    JSON.stringify(workspaceStyles));
  assert.equal(workspaceStyles.editorOverflow, "auto");
  assert.equal(workspaceStyles.previewOverflow, "hidden");
  assert.equal(workspaceStyles.toolbarRadius, "18px");
  assert.ok(Math.abs(workspaceStyles.paperWidthHeightRatio - 210 / 297) < 0.005,
    JSON.stringify(workspaceStyles));
  assert.equal(workspaceStyles.shellBackground, "rgb(232, 248, 243)");
  const mainNavigation = page.getByRole("navigation", { name: "প্রধান নেভিগেশন" });
  await mainNavigation.getByRole("button", { name: "প্রশ্নপত্র তৈরি", exact: true }).waitFor();
  assert.equal(await mainNavigation.getByRole("button", { name: "প্রশ্নপত্র তৈরি", exact: true }).getAttribute("aria-current"), "page");
  assert.equal(await page.locator(".topbar-brand-copy strong").textContent(), "প্রশ্নপত্র নির্মাতা");
  assert.equal(await page.locator(".topbar-brand-mark").isVisible(), true);
  assert.equal(await page.locator(".user-panel-label").count(), 0);
  assert.ok(await page.locator(".account-menu > summary .account-avatar").isVisible());
  const editorToolbar = page.locator(".question-preview-navbar");
  const setupSection = editorToolbar;
  assert.equal(await setupSection.locator(".paper-identity .eyebrow").textContent(), "নতুন প্রশ্নপত্র");
  assert.equal(await setupSection.locator(".paper-count").count(), 0);
  assert.equal(await page.locator("#questions .section-head .paper-count").count(), 1);
  assert.ok(await editorToolbar.getByRole("button", { name: "MCQ প্রশ্নপত্র", exact: true }).isVisible());
  assert.ok(await editorToolbar.getByRole("button", { name: "CQ প্রশ্নপত্র", exact: true }).isVisible());
  assert.equal(await page.locator(".editor-pane .section-bank h2.section-title").textContent(), "প্রশ্ন ব্যাংক থেকে যোগ করুন");
  assert.ok(await page.locator(".editor-pane .bank-results").isVisible());
  assert.ok(await setupSection.locator("#questions").count() === 0);
  assert.ok(await setupSection.locator("#exam").isVisible());
  assert.equal(await editorToolbar.evaluate((element) => element.closest(".preview-pane") !== null), true);
  assert.equal(await page.locator(".editor-toolbar").count(), 0,
    "teacher creation should not render a separate Secondary Navbar");
  assert.ok(await editorToolbar.getByRole("button", { name: /PDF \/ প্রিন্ট/ }).isVisible());
  assert.ok(await editorToolbar.locator("#exam").isVisible(), "Editable paper title should remain in the toolbar");
  assert.equal(await editorToolbar.locator("#institution").count(), 0, "Paper settings start collapsed");
  assert.ok(await editorToolbar.locator(".document-format-controls").isVisible(),
    "document formatting stays available in the permanent toolbar");
  assert.equal(await editorToolbar.locator(".document-format-controls #font-size").count(), 1);
  assert.equal(await editorToolbar.locator("#paper-settings #font-size").count(), 0,
    "formatting controls should not be inside the expandable settings section");
  assert.match(await editorToolbar.locator(".format-layout-note").textContent(), /MCQ: ২ · CQ: ২ \(ল্যান্ডস্কেপ\)/);
  await editorToolbar.locator("#font-size").fill("11");
  await editorToolbar.locator("#page-margin").fill("14");
  await editorToolbar.locator("#column-gap").fill("10");
  await editorToolbar.locator("#line-spacing").fill("1.7");
  await page.waitForFunction(() => {
    const paper = document.querySelector(".page-stack .paper-page");
    return paper?.style.getPropertyValue("--paper-size") === "11pt"
      && paper.style.getPropertyValue("--page-margin") === "14mm"
      && paper.style.getPropertyValue("--column-gap") === "10mm"
      && paper.style.getPropertyValue("--paper-leading") === "1.7";
  });
  assert.equal(await editorToolbar.locator(".paper-settings-summary").count(), 0,
    "the settings summary should not be rendered in the secondary toolbar");
  assert.equal(await editorToolbar.locator(".settings-save-button").count(), 0,
    "the settings Save button should not be rendered in the secondary toolbar");
  await editorToolbar.getByRole("button", { name: "পরীক্ষার সেটিংস" }).click();
  const questionSettingsPage = page.locator(".question-settings-full-page");
  await questionSettingsPage.waitFor();
  await page.waitForURL("**/app/settings");
  assert.equal(await questionSettingsPage.isVisible(), true);
  assert.equal(await editorToolbar.isVisible(), false, "the formatting toolbar should be hidden on the separate settings page");
  assert.equal(await page.locator(".work-area").isVisible(), false, "editor and document preview should be hidden on the settings page");
  for (const selector of ["#institution", "#settings-exam", "#class", "#group", "#subject", "#chapter", "#topic", "#duration", "#marks", "#instructions"]) {
    assert.ok(await questionSettingsPage.locator(selector).isVisible(), `${selector} should be available on the settings page`);
  }
  await questionSettingsPage.locator("#institution").fill("DEMO · শিক্ষণ অনুশীলন কেন্দ্র");
  await questionSettingsPage.locator("#settings-exam").fill("বিজ্ঞান মডেল পরীক্ষা");
  await questionSettingsPage.locator("#class").fill("নবম–দশম শ্রেণি");
  await questionSettingsPage.locator("#subject").fill("সাধারণ বিজ্ঞান");
  await questionSettingsPage.locator("#duration").fill("৩ ঘণ্টা");
  await questionSettingsPage.locator("#marks").fill("100");
  await questionSettingsPage.locator("#instructions").fill("সব বহুনির্বাচনি প্রশ্নের উত্তর দাও। সৃজনশীল প্রশ্নে উদ্দীপক পড়ে ক, খ, গ ও ঘ-এর উত্তর ধারাবাহিকভাবে লেখ। গণনায় একক উল্লেখ কর।");
  const liveHeaderPreview = questionSettingsPage.locator(".exam-header-preview-paper");
  assert.match(await liveHeaderPreview.innerText(), /DEMO · শিক্ষণ অনুশীলন কেন্দ্র/);
  assert.match(await liveHeaderPreview.innerText(), /নবম–দশম শ্রেণি · বিজ্ঞান মডেল পরীক্ষা/);
  assert.match(await liveHeaderPreview.innerText(), /নবম–দশম শ্রেণি \| সাধারণ বিজ্ঞান \| সময়: ৩ ঘণ্টা \| পূর্ণমান: ১০০/);
  assert.match(await liveHeaderPreview.innerText(), /নির্দেশনা: সব বহুনির্বাচনি প্রশ্নের উত্তর দাও।/);
  await questionSettingsPage.getByRole("button", { name: "এডিটরে ফিরে যান" }).click();
  await page.waitForURL("**/app");
  await questionSettingsPage.waitFor({ state: "hidden" });
  assert.equal(await editorToolbar.isVisible(), true, "returning should restore the editor and toolbar");
  assert.equal(await editorToolbar.locator("#font-size").inputValue(), "11",
    "returning should preserve editor formatting state");
  assert.equal(await editorToolbar.getByRole("button", { name: "MCQ প্রশ্নপত্র", exact: true }).getAttribute("aria-pressed"), "true",
    "returning should preserve the active question type");
  assert.ok(await editorToolbar.locator(".toolbar-mode-picker").isVisible());
  assert.ok(await editorToolbar.getByRole("button", { name: "MCQ প্রশ্নপত্র", exact: true }).isVisible());
  assert.ok(await editorToolbar.getByRole("button", { name: "CQ প্রশ্নপত্র", exact: true }).isVisible());
  const questionBankFilters = page.locator("#question-bank .question-bank-filters");
  assert.equal(await questionBankFilters.locator("#bank-class").isVisible(), true);
  assert.equal(await questionBankFilters.locator("#bank-group").isVisible(), true);
  assert.equal(await questionBankFilters.locator("#bank-subject").isVisible(), true);
  assert.equal(await questionBankFilters.locator("#bank-chapter").isVisible(), true);
  assert.equal(await questionBankFilters.locator("#bank-topic").isVisible(), true);
  assert.equal(await editorToolbar.locator(".question-bank-filters").count(), 0,
    "question-bank filters should not appear inside Question Settings");
  assert.equal(await page.locator("#questions").evaluate((questions) =>
    questions.closest(".editor-pane") !== null), true);
  assert.equal(await page.locator("#exam").evaluate((field) =>
    field.closest(".question-preview-navbar") !== null), true);
  assert.equal(await page.locator("#generator-class").evaluate((field) =>
    field.closest(".editor-pane") !== null), true);
  assert.equal(await page.locator("#generation-workflow").evaluate((field) =>
    field.closest(".editor-pane") !== null), true);
  assert.equal(await page.locator(".question-preview-navbar #paper-settings").count(), 0,
    "Question Settings form should remain on its dedicated route, not in the preview navbar");
  assert.equal(await page.locator(".preview-zoom-level").textContent(), "100%");
  await page.getByRole("button", { name: "জুম বাড়ান" }).click();
  assert.equal(await page.locator(".preview-zoom-level").textContent(), "110%");
  await page.getByRole("button", { name: "জুম কমান" }).click();
  assert.equal(await page.locator(".preview-zoom-level").textContent(), "100%");
  await page.setViewportSize({ width: 375, height: 844 });
  await page.locator(".mobile-pane-tabs:visible").getByRole("tab", { name: "প্রিভিউ" }).click();
  assert.ok(await editorToolbar.locator(".document-format-controls").isVisible(),
    "formatting controls should remain visible on mobile");
  assert.equal(await editorToolbar.locator(".format-control-fields .field input").count(), 4);
  const mobileFormatLayout = await editorToolbar.locator(".document-format-controls").evaluate((element) => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    columns: getComputedStyle(element.querySelector(".format-control-fields")).gridTemplateColumns.split(" ").length,
  }));
  assert.equal(mobileFormatLayout.columns, 2, JSON.stringify(mobileFormatLayout));
  assert.equal(mobileFormatLayout.width, mobileFormatLayout.scrollWidth, JSON.stringify(mobileFormatLayout));
  await page.getByRole("button", { name: "নেভিগেশন খুলুন" }).click();
  const secondaryNavigation = page.getByRole("dialog", { name: "অতিরিক্ত নেভিগেশন" });
  await secondaryNavigation.waitFor();
  assert.equal(await secondaryNavigation.locator("#generator-class").count(), 0);
  assert.equal(await secondaryNavigation.locator("#bank-class").count(), 0);
  assert.equal(await secondaryNavigation.getByRole("link").count(), 3);
  assert.deepEqual(await secondaryNavigation.getByRole("link").evaluateAll((links) =>
    links.map((link) => link.getAttribute("href"))),
  ["#question-bank-controls", "#question-bank", "#paper-settings"]);
  await secondaryNavigation.getByRole("button", { name: "মেনু বন্ধ করুন" }).click();
  await page.locator(".mobile-pane-tabs:visible").getByRole("tab", { name: "প্রশ্ন" }).click();
  await page.locator("#generator-class").waitFor();
  await page.waitForFunction(() => [...document.querySelector("#generator-class").options]
    .some((option) => option.value === "Class 9"));
  const assertResponsiveWidths = async (stage) => {
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 960) {
        await page.locator(".mobile-pane-tabs:visible").getByRole("tab", { name: "প্রিভিউ" }).click();
      }
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
        headerBottom: document.querySelector(".topbar").getBoundingClientRect().bottom,
        leadingBottom: document.querySelector(".topbar-leading").getBoundingClientRect().bottom,
        navigationTop: document.querySelector(".top-navigation").getBoundingClientRect().top,
      }));
      assert.ok(dimensions.content <= dimensions.viewport,
        `${stage} must not overflow horizontally at ${width}px: ${JSON.stringify(dimensions)}`);
      const navDimensions = await editorToolbar.evaluate((element) => ({
        top: element.getBoundingClientRect().top,
        bottom: element.getBoundingClientRect().bottom,
        width: element.getBoundingClientRect().width,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      assert.ok(navDimensions.bottom > navDimensions.top, `${stage} toolbar should remain visible at ${width}px`);
      if (width <= 760) {
        assert.equal(await page.locator(".top-navigation").isVisible(), false,
          `${stage} should collapse the top links into the mobile menu at ${width}px`);
        assert.equal(await page.getByRole("button", { name: "নেভিগেশন খুলুন" }).isVisible(), true,
          `${stage} should show the mobile menu control at ${width}px`);
      } else if (width <= 1000) {
        assert.ok(dimensions.navigationTop >= dimensions.leadingBottom - 1,
          `${stage} navbar links must not overlap the brand/account row at ${width}px`);
        assert.ok(dimensions.headerBottom >= dimensions.navigationTop,
          `${stage} navbar must contain its navigation row at ${width}px`);
      }
      if (width > 1000) {
        assert.ok(navDimensions.scrollWidth <= navDimensions.width,
          `${stage} toolbar must not overflow at ${width}px: ${JSON.stringify(navDimensions)}`);
      } else {
        assert.ok(navDimensions.scrollWidth <= navDimensions.clientWidth,
          `${stage} toolbar content must fit at ${width}px: ${JSON.stringify(navDimensions)}`);
      }
        assert.equal(await page.locator(".question-settings-full-page").isVisible(), false,
          `Question Settings should remain a separate view at ${width}px`);
        if (width <= 960) {
        assert.equal(await page.getByRole("tab", { name: "প্রশ্ন" }).isVisible(), true);
        assert.equal(await page.getByRole("tab", { name: "প্রিভিউ" }).isVisible(), true);
          assert.equal(await page.locator("#editor").isVisible(), false);
          assert.equal(await page.locator("#preview").isVisible(), true);
        }
        if (width <= 760) {
          assert.equal(await page.getByRole("button", { name: "নেভিগেশন খুলুন" }).isVisible(), true);
          assert.equal(await page.getByRole("navigation", { name: "প্রধান নেভিগেশন" }).isVisible(), false);
        }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    assert.ok(dimensions.content <= dimensions.viewport,
      `Generator must not overflow horizontally at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.equal(await page.locator("#generator-class").isVisible(), true);
    assert.equal(await page.locator(".generation-progress li").count(), 3);
    if (width >= 961) {
      const positions = await page.evaluate(() => ({
        preview: document.querySelector("#preview").getBoundingClientRect().left,
        questions: document.querySelector("#editor").getBoundingClientRect().left,
        editorWidth: document.querySelector("#editor").getBoundingClientRect().width,
        workspaceWidth: document.querySelector(".work-area").getBoundingClientRect().width,
      }));
      assert.ok(positions.questions < positions.preview, JSON.stringify(positions));
      assert.ok(positions.editorWidth / positions.workspaceWidth > 0.37
        && positions.editorWidth / positions.workspaceWidth < 0.43,
      `Questions pane should occupy about 40% of the workspace: ${JSON.stringify(positions)}`);
    } else {
      assert.equal(await page.getByRole("tab", { name: "প্রশ্ন" }).isVisible(), true);
      assert.equal(await page.locator("#editor").isVisible(), true);
      assert.equal(await page.locator("#preview").isVisible(), false);
    }
  }
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if (width <= 960) {
      await page.locator(".mobile-pane-tabs:visible").getByRole("tab", { name: "প্রশ্ন" }).click();
      if (width <= 760) {
        await page.getByRole("button", { name: "নেভিগেশন খুলুন" }).click();
        const mobileNavigation = page.getByRole("navigation", { name: "মোবাইল নেভিগেশন" });
        assert.equal(await mobileNavigation.isVisible(), true);
        assert.equal(await mobileNavigation.getByRole("button", { name: "প্রশ্নপত্র তৈরি", exact: true }).getAttribute("aria-current"), "page");
        await page.getByRole("button", { name: "মেনু বন্ধ করুন" }).click();
      }
      await page.getByRole("tab", { name: "প্রিভিউ" }).click();
      assert.equal(await page.locator("#preview").isVisible(), true);
      assert.equal(await page.locator("#editor").isVisible(), false);
      await page.getByRole("tab", { name: "প্রশ্ন" }).click();
      assert.equal(await page.locator("#editor").isVisible(), true);
      assert.equal(await page.locator("#preview").isVisible(), false);
    }
    else {
      const positions = await page.evaluate(() => ({
        preview: document.querySelector("#preview").getBoundingClientRect().left,
        questions: document.querySelector("#editor").getBoundingClientRect().left,
      }));
      assert.ok(positions.questions < positions.preview, JSON.stringify(positions));
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.locator("#generator-class").getAttribute("multiple"), null,
    "Only one class may be selected per paper");
  await page.locator("#generator-class").selectOption("Class 9");
  await page.getByRole("button", { name: "পরবর্তী ধাপ" }).click();
  await assertResponsiveWidths("Subject selection");
  await page.waitForFunction(() => [...document.querySelector("#generator-subject").options]
    .some((option) => option.value === "Physics"));
  assert.deepEqual(await page.locator("#generator-subject option").allTextContents(), ["বিষয় বাছুন", "Biology", "Physics"]);
  await page.locator("#generator-subject").selectOption("Physics");
  await page.getByRole("button", { name: "পরবর্তী ধাপ" }).click();
  assert.equal(await page.locator(".generation-progress li").count(), 3);
  assert.equal(await page.locator("#generator-chapters").count(), 0);
  assert.equal(await page.locator("#generator-topics").count(), 0);
  await page.getByText("আপনার নির্বাচন").waitFor();
  await page.locator(".generation-summary dt").first().waitFor();
  await assertResponsiveWidths("Question configuration");
  await page.locator("#generator-question-count").fill("2");
  await page.getByRole("button", { name: "সম্ভাব্যতা ও খরচ দেখুন" }).click();
  await page.getByText("এই নির্বাচনে ১টি যোগ্য প্রশ্ন আছে; ২টি চাওয়া হয়েছে।").waitFor();
  await page.locator("#generator-question-count").fill("1");
  await page.getByRole("button", { name: "সম্ভাব্যতা ও খরচ দেখুন" }).click();
  await page.getByText(/মোট নম্বর: 5 · আনুমানিক খরচ: 1 টোকেন/).waitFor();
  await page.getByRole("button", { name: /প্রশ্নপত্র তৈরি · 1 টোকেন/ }).click();
  await page.getByText(/প্রশ্নপত্র তৈরি হয়েছে · 1 টোকেন কাটা হয়েছে/).waitFor();
  await page.locator(".paper-page .paper-question").getByText("What is velocity?").waitFor();
  assert.equal(generatedRequests.length, 1);
  assert.equal(generatedRequests[0].questionCount, 1);
  assert.deepEqual(generatedRequests[0].questionIds, [question.id]);
  assert.deepEqual(generatedRequests[0].chapters, []);
  assert.deepEqual(generatedRequests[0].topics, []);

  await page.locator("#generator-mode").selectOption("manual");
  await page.getByRole("button", { name: "প্রশ্নের তালিকা দেখুন" }).click();
  await page.locator(".generator-question input").check();
  await page.getByRole("button", { name: "খরচের প্রিভিউ" }).click();
  await page.getByText(/মোট নম্বর: 5 · আনুমানিক খরচ: 1 টোকেন/).waitFor();
  const secondGenerationRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/papers/generate");
  await page.getByRole("button", { name: /প্রশ্নপত্র তৈরি · 1 টোকেন/ }).click();
  await secondGenerationRequest;
  await page.getByText(/প্রশ্নপত্র তৈরি হয়েছে · 1 টোকেন কাটা হয়েছে/).waitFor();
  assert.equal(generatedRequests.length, 2);
  assert.equal(generatedRequests[1].mode, "manual");
  assert.deepEqual(generatedRequests[1].questionIds, [question.id]);

  for (let step = 0; step < 2; step += 1) {
    await page.getByRole("button", { name: "পেছনে" }).click();
  }
  await page.locator("#generator-class").selectOption("Class 10");
  await page.getByRole("button", { name: "পরবর্তী ধাপ" }).click();
  await page.waitForFunction(() => [...document.querySelector("#generator-subject").options]
    .some((option) => option.value === "Chemistry"));
  assert.deepEqual(await page.locator("#generator-subject option").allTextContents(), ["বিষয় বাছুন", "Chemistry"]);
  assert.equal(await page.locator("#generator-subject").inputValue(), "");
  await page.locator("#generator-subject").selectOption("Chemistry");
  await page.getByRole("button", { name: "পরবর্তী ধাপ" }).click();
  await page.getByText("আপনার নির্বাচন").waitFor();
  await page.getByRole("button", { name: "পেছনে" }).click();
  await page.getByRole("button", { name: "পেছনে" }).click();
  await page.locator("#generator-class").selectOption("Class 9");
  await page.getByRole("button", { name: "পরবর্তী ধাপ" }).click();
  await page.waitForFunction(() => [...document.querySelector("#generator-subject").options]
    .some((option) => option.value === "Biology"));
  await page.locator("#generator-subject").selectOption("Physics");
  await page.getByRole("button", { name: "পরবর্তী ধাপ" }).click();
  await page.getByText("আপনার নির্বাচন").waitFor();
  await page.getByRole("button", { name: "পেছনে" }).click();
  await page.locator("#generator-subject").selectOption("Biology");
  await page.getByRole("button", { name: "পরবর্তী ধাপ" }).click();
  assert.equal(await page.locator(".generation-summary dd").nth(0).textContent(), "Class 9");
  assert.equal(await page.locator(".generation-summary dd").nth(1).textContent(), "Biology");
  assert.equal(await page.locator("#generator-chapters").count(), 0);
  assert.equal(await page.locator("#generator-topics").count(), 0);
  await page.getByRole("button", { name: "CQ প্রশ্নপত্র", exact: true }).click();
  assert.equal(await page.locator(".generation-progress li").count(), 3);
  await page.locator("#generator-mode").selectOption("auto");
  assert.equal(await page.locator("#generator-question-count").getAttribute("max"), "12");
  assert.ok(catalogRequests.some((request) =>
    request.classLevel === "Class 9" && !request.subject && !request.chapter));
  assert.ok(catalogRequests.some((request) =>
    request.classLevel === "Class 10" && !request.subject && !request.chapter));
  assert.equal(catalogRequests.some((request) => Boolean(request.chapter)), false,
    "The 3-step flow must not request chapter or topic catalogs");
});

test("all five question creation methods use the shared editor and real-question API flow", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const previewBodies = [];
  const generationBodies = [];
  let manualQuestionBody;
  const questions = [
    {
      id: "bank-question-1",
      type: "MCQ",
      marks: 1,
      classLevel: "Class 9",
      group: "Science",
      subject: "Physics",
      chapter: "Motion",
      topic: "Speed",
      content: { text: "Bank question one", options: ["A", "B"], difficulty: "easy" },
    },
    {
      id: "bank-question-2",
      type: "MCQ",
      marks: 2,
      classLevel: "Class 9",
      group: "Science",
      subject: "Physics",
      chapter: "Motion",
      topic: "Speed",
      content: { text: "Bank question two", options: ["A", "B"], difficulty: "medium" },
    },
    {
      id: "blueprint-question",
      type: "MCQ",
      marks: 3,
      classLevel: "Class 9",
      group: "Science",
      subject: "Physics",
      chapter: "Motion",
      topic: "Speed",
      content: { text: "Blueprint question", options: ["A", "B"], difficulty: "easy" },
    },
  ];
  const previousPaper = {
    id: "previous-paper",
    title: "Previous Physics Paper",
    settings: { questionType: "MCQ" },
    items: questions.slice(0, 2).map((question) => ({ question })),
  };
  const questionById = new Map(questions.map((question) => [question.id, question]));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: "teacher-1", email: "teacher@example.com", name: "Teacher", role: "TEACHER" } } });
      return;
    }
    if (url.pathname === "/api/tokens" && request.method() === "GET") {
      await route.fulfill({ json: { balance: 100, tokenRates: { MCQ: 1, CQ: 10, SHORT: 5 }, transactions: [] } });
      return;
    }
    if (url.pathname === "/api/papers/settings" && request.method() === "GET") {
      await route.fulfill({ json: { settings: {} } });
      return;
    }
    if (url.pathname === "/api/questions/catalog") {
      const classLevel = url.searchParams.get("classLevel");
      const subject = url.searchParams.get("subject");
      await route.fulfill({
        json: {
          classes: classLevel ? [classLevel] : ["Class 9"],
          groups: ["Science"],
          subjects: subject ? [subject] : ["Physics"],
          chapters: ["Motion"],
          topics: ["Speed"],
        },
      });
      return;
    }
    if (url.pathname === "/api/questions" && request.method() === "GET") {
      await route.fulfill({ json: { questions: [], total: 0 } });
      return;
    }
    if (url.pathname === "/api/papers" && request.method() === "GET") {
      await route.fulfill({
        json: { papers: [{ id: previousPaper.id, title: previousPaper.title, _count: { items: 2 } }] },
      });
      return;
    }
    if (url.pathname === `/api/papers/${previousPaper.id}` && request.method() === "GET") {
      await route.fulfill({ json: { paper: previousPaper } });
      return;
    }
    if (url.pathname === "/api/papers/preview") {
      const body = request.postDataJSON();
      previewBodies.push(body);
      const candidates = body.blueprint
        ? [questions[2]]
        : body.mode === "manual"
          ? questions.slice(0, 2)
          : questions;
      const selected = body.mode === "manual"
        ? body.questionIds.map((id) => questionById.get(id)).filter(Boolean)
        : body.blueprint
          ? [questions[2]]
          : (body.questionIds ?? candidates.slice(0, body.questionCount).map(({ id }) => id))
            .map((id) => questionById.get(id)).filter(Boolean);
      await route.fulfill({
        json: {
          questions: selected,
          candidates,
          availableCount: candidates.length,
          totalMarks: selected.reduce((total, question) => total + question.marks, 0),
          estimatedTokens: selected.length,
          balance: 100,
          affordable: true,
        },
      });
      return;
    }
    if (url.pathname === "/api/papers/generate") {
      const body = request.postDataJSON();
      generationBodies.push(body);
      const generatedQuestions = body.questionIds.map((id) => questionById.get(id)).filter(Boolean);
      await route.fulfill({
        status: 201,
        json: {
          paper: {
            id: `generated-paper-${generationBodies.length}`,
            settings: { className: body.classLevel, subject: body.subject },
            items: generatedQuestions.map((question) => ({ question })),
          },
          totalMarks: generatedQuestions.reduce((total, question) => total + question.marks, 0),
          chargedTokens: generatedQuestions.length,
          balance: 100 - generatedQuestions.length,
          duplicate: false,
        },
      });
      return;
    }
    if (url.pathname === "/api/uploads" && request.method() === "POST") {
      await route.fulfill({ json: { url: "/api/uploads/images/manual-question-image" } });
      return;
    }
    if (url.pathname === "/api/questions/manual-create" && request.method() === "POST") {
      manualQuestionBody = request.postDataJSON();
      await route.fulfill({
        status: 201,
        json: {
          question: { id: "manual-question" },
          chargedTokens: 1,
          balance: 99,
          transaction: { type: "CHARGE", amount: -1, createdAt: new Date().toISOString() },
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  await openQuestionCreator(page);
  await page.locator(".generation-method-picker").waitFor();

  await page.locator("#generator-class").selectOption("Class 9");
  await page.getByRole("button", { name: "পরবর্তী ধাপ" }).click();
  await page.waitForFunction(() => [...document.querySelector("#generator-subject").options]
    .some((option) => option.value === "Physics"));
  await page.locator("#generator-subject").selectOption("Physics");
  await page.getByRole("button", { name: "পরবর্তী ধাপ" }).click();

  await page.getByRole("button", { name: "Quick Generate", exact: true }).click();
  await page.locator("#generator-question-count").fill("1");
  await page.getByRole("button", { name: "সম্ভাব্যতা ও খরচ দেখুন" }).click();
  await page.getByText(/আনুমানিক খরচ: 1 টোকেন/).waitFor();
  await page.getByRole("button", { name: /প্রশ্নপত্র তৈরি · 1 টোকেন/ }).click();
  await page.getByText(/প্রশ্নপত্র তৈরি হয়েছে/).waitFor();
  assert.equal(generationBodies[0].questionCount, 1);
  assert.deepEqual(generationBodies[0].questionIds, [questions[0].id]);

  await page.getByRole("button", { name: "Manual Selection", exact: true }).click();
  await page.getByRole("button", { name: "প্রশ্নের তালিকা দেখুন" }).click();
  await page.locator(".generator-question").nth(0).locator("input").check();
  await page.locator(".generator-question").nth(1).locator("input").check();
  await page.locator(".generator-question").nth(1).getByRole("button", { name: /উপরে নিন/ }).click();
  await page.locator(".generator-question").nth(0).getByRole("button", { name: "বাদ দিন" }).click();
  await page.getByRole("button", { name: "খরচের প্রিভিউ" }).click();
  await page.getByRole("button", { name: /প্রশ্নপত্র তৈরি · 1 টোকেন/ }).click();
  await page.getByText(/প্রশ্নপত্র তৈরি হয়েছে/).waitFor();
  assert.deepEqual(generationBodies[1].questionIds, [questions[1].id]);
  assert.ok(previewBodies.some((body) => body.mode === "manual" && body.questionIds.length === 0));

  await page.getByRole("button", { name: "Manual Creation", exact: true }).click();
  const manualForm = page.locator(".manual-question-form");
  await manualForm.locator("#manual-question-group").fill("Science");
  await manualForm.locator("#manual-question-chapter").fill("Motion");
  await manualForm.locator("#manual-question-topic").fill("Speed");
  await manualForm.locator("#manual-question-marks").fill("2");
  await manualForm.locator("label.field textarea").first().fill("Manually authored question");
  await manualForm.getByLabel("1 নম্বর বিকল্প").fill("Choice A");
  await manualForm.getByLabel("2 নম্বর বিকল্প").fill("Choice B");
  await manualForm.locator("#manual-question-answer").fill("Choice A");
  await manualForm.locator("#manual-question-explanation").fill("Explanation");
  await manualForm.locator('input[type="file"]').setInputFiles({
    name: "question.png",
    mimeType: "image/png",
    buffer: Buffer.from("test image"),
  });
  await manualForm.getByRole("button", { name: "প্রশ্ন তৈরি করে পেপারে যোগ" }).click();
  await page.getByText("প্রশ্নটি সংরক্ষণ করে প্রশ্নপত্রে যোগ করা হয়েছে").waitFor();
  assert.equal(manualQuestionBody.type, "MCQ");
  assert.equal(manualQuestionBody.marks, 2);
  assert.deepEqual(manualQuestionBody.content.options, ["Choice A", "Choice B", "", ""]);
  assert.equal(manualQuestionBody.content.answer, "Choice A");
  assert.equal(manualQuestionBody.content.explanation, "Explanation");
  assert.equal(manualQuestionBody.content.imageUrl, "/api/uploads/images/manual-question-image");

  await page.getByRole("button", { name: "Blueprint Generation", exact: true }).click();
  await page.locator("#blueprint-chapter").selectOption("Motion");
  await page.waitForFunction(() => [...document.querySelector("#blueprint-topic").options]
    .some((option) => option.value === "Speed"));
  await page.locator("#blueprint-topic").selectOption("Speed");
  await page.locator("#blueprint-marks").fill("3");
  await page.getByRole("button", { name: "ব্লুপ্রিন্ট যাচাই ও খরচ দেখুন" }).click();
  await page.getByRole("button", { name: /প্রশ্নপত্র তৈরি · 1 টোকেন/ }).click();
  await page.getByText(/প্রশ্নপত্র তৈরি হয়েছে/).waitFor();
  assert.equal(generationBodies[2].blueprint.marks, 3);
  assert.deepEqual(generationBodies[2].chapters, ["Motion"]);
  assert.deepEqual(generationBodies[2].topics, ["Speed"]);
  assert.deepEqual(generationBodies[2].blueprint.difficultyCounts, { easy: 1, medium: 0, hard: 0 });

  await page.getByRole("button", { name: "Previous Paper Based", exact: true }).click();
  await page.locator("#previous-paper-select").selectOption(previousPaper.id);
  await page.getByRole("button", { name: "পূর্বের প্রশ্নপত্র থেকে বাছুন" }).click();
  await page.locator(".generator-question").nth(0).getByRole("button", { name: "বাদ দিন" }).click();
  await page.getByRole("button", { name: "পূর্বের প্রশ্ন থেকে খরচের প্রিভিউ" }).click();
  await page.getByRole("button", { name: /প্রশ্নপত্র তৈরি · 1 টোকেন/ }).click();
  await page.getByText(/প্রশ্নপত্র তৈরি হয়েছে/).waitFor();
  assert.deepEqual(generationBodies[3].questionIds, [questions[1].id]);
  assert.ok(previewBodies.some((body) => body.blueprint?.marks === 3));
  assert.equal(generationBodies.length, 4);
});

test("CQ Set generation submits per-set configuration and renders sequential labels", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const previewBodies = [];
  const generateBodies = [];
  const savedPaperBodies = [];
  const questions = ["cq-set-1", "cq-set-2", "cq-set-3"].map((id, index) => ({
    id,
    type: "CQ",
    marks: 10,
    classLevel: "Class 9",
    group: "Science",
    subject: "Physics",
    chapter: index === 0 ? "Motion" : "Forces",
    topic: "",
    content: { text: `Prompt ${index + 1}`, subs: ["Part A", "Part B", "Part C", "Part D"] },
  }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: "teacher-1", email: "teacher@example.com", name: "Teacher", role: "TEACHER" } } });
      return;
    }
    if (url.pathname === "/api/papers/settings" && request.method() === "GET") {
      await route.fulfill({ json: { settings: {} } });
      return;
    }
    if (url.pathname === "/api/tokens" && request.method() === "GET") {
      await route.fulfill({ json: { balance: 100, tokenRates: { MCQ: 1, CQ: 10, SHORT: 5 }, transactions: [] } });
      return;
    }
    if (url.pathname === "/api/questions/catalog") {
      const classLevel = url.searchParams.get("classLevel");
      const subject = url.searchParams.get("subject");
      await route.fulfill({
        json: {
          classes: classLevel ? [classLevel] : ["Class 9"],
          groups: ["Science"],
          subjects: subject ? [subject] : ["Physics"],
          chapters: subject ? ["Motion", "Forces"] : [],
          topics: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/questions" && request.method() === "GET") {
      await route.fulfill({ json: { questions: [], total: 0 } });
      return;
    }
    if (url.pathname === "/api/papers/preview") {
      const body = request.postDataJSON();
      previewBodies.push(body);
      await route.fulfill({
        json: {
          questions,
          setAssignments: questions.map((question, index) => ({
            questionId: question.id,
            setNumber: index === 0 ? 1 : 2,
          })),
          availableCount: questions.length,
          totalMarks: 30,
          estimatedTokens: 30,
          balance: 100,
          affordable: true,
        },
      });
      return;
    }
    if (url.pathname === "/api/papers/generate") {
      const body = request.postDataJSON();
      generateBodies.push(body);
      await route.fulfill({
        status: 201,
        json: {
          paper: {
            id: "cq-set-paper",
            settings: {
              className: "Class 9",
              subject: "Physics",
              cqPageLayout: "two",
              cqSetCount: 2,
              cqSetAssignments: { "cq-set-1": 1, "cq-set-2": 2, "cq-set-3": 2 },
            },
            items: questions.map((question) => ({ question })),
          },
          totalMarks: 30,
          chargedTokens: 30,
          balance: 70,
          duplicate: false,
        },
      });
      return;
    }
    if (
      (url.pathname === "/api/papers" && request.method() === "POST") ||
      (url.pathname === "/api/papers/cq-set-paper" && request.method() === "PUT")
    ) {
      savedPaperBodies.push(request.postDataJSON());
      await route.fulfill({ status: 201, json: { paper: { id: "saved-cq-set-paper" } } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  await openQuestionCreator(page);
  await page.getByRole("button", { name: "CQ প্রশ্নপত্র", exact: true }).click();
  await page.locator("#generator-class").selectOption("Class 9");
  await page.getByRole("button", { name: "পরবর্তী ধাপ" }).click();
  await page.locator("#generator-subject").selectOption("Physics");
  await page.getByRole("button", { name: "পরবর্তী ধাপ" }).click();
  assert.deepEqual(await page.locator("#generator-cq-set-count option").allTextContents(), ["Set 0", "Set 2", "Set 3", "Set 4"]);
  await page.locator("#generator-mode").selectOption("manual");
  assert.equal(await page.locator("#generator-cq-set-count").isVisible(), true,
    "Set selection remains accessible when the shared generation mode is manual");
  await page.locator("#generator-cq-set-count").selectOption("4");
  assert.equal(await page.locator(".cq-set").count(), 4);
  await page.locator("#generator-cq-set-count").selectOption("3");
  assert.equal(await page.locator(".cq-set").count(), 3);
  await page.locator("#generator-cq-set-count").selectOption("0");
  assert.equal(await page.locator(".cq-set").count(), 0);
  assert.equal(await page.locator("#generator-question-count").isVisible(), true,
    "Set 0 retains the standard CQ question-count workflow");
  await page.locator("#generator-cq-set-count").selectOption("2");
  assert.equal(await page.locator("#generator-mode").inputValue(), "auto",
    "Selecting a non-zero Set switches to compatible automatic generation");
  await page.locator(".cq-set").nth(0).getByLabel("Motion").check();
  await page.locator(".cq-set").nth(1).getByLabel("Forces").check();
  await page.locator("#generator-cq-set-count-1").fill("2");
  await page.getByRole("button", { name: "সম্ভাব্যতা ও খরচ দেখুন" }).click();
  await page.getByText(/আনুমানিক খরচ: 30 টোকেন/).waitFor();

  assert.equal(previewBodies.length, 1);
  assert.equal(previewBodies[0].cqSetCount, 2);
  assert.equal(previewBodies[0].questionCount, 3);
  assert.deepEqual(previewBodies[0].cqSets, [
    { setNumber: 1, chapters: ["Motion"], questionCount: 1 },
    { setNumber: 2, chapters: ["Forces"], questionCount: 2 },
  ]);
  await page.getByRole("button", { name: /প্রশ্নপত্র তৈরি · 30 টোকেন/ }).click();
  await page.locator(".page-stack .paper-set-label").first().waitFor();
  assert.equal(generateBodies.length, 1);
  assert.deepEqual(generateBodies[0].cqSetAssignments, [
    { questionId: "cq-set-1", setNumber: 1 },
    { questionId: "cq-set-2", setNumber: 2 },
    { questionId: "cq-set-3", setNumber: 2 },
  ]);
  assert.deepEqual(await page.locator(".page-stack .paper-set-label").allTextContents(), ["Set 1", "Set 2", "Set 2"]);
  assert.deepEqual(await page.locator(".page-stack .paper-q-number").allTextContents(), ["1.", "2.", "3."]);
  assert.equal(await page.locator("#cq-division-count").count(), 0);
  await page.getByRole("button", { name: "প্রশ্নপত্র সংরক্ষণ", exact: true }).click();
  await page.getByText("প্রশ্নপত্র অ্যাকাউন্টে সংরক্ষিত হয়েছে").waitFor();
  assert.equal(savedPaperBodies.length, 1);
  assert.equal(savedPaperBodies[0].settings.cqSetCount, 2);
  assert.deepEqual(savedPaperBodies[0].settings.cqSets, previewBodies[0].cqSets);
  assert.deepEqual(savedPaperBodies[0].settings.cqSetAssignments, {
    "cq-set-1": 1,
    "cq-set-2": 2,
    "cq-set-3": 2,
  });
  await page.getByRole("button", { name: "MCQ প্রশ্নপত্র", exact: true }).click();
  await page.locator("#generator-mode").selectOption("manual");
  await page.getByRole("button", { name: "CQ প্রশ্নপত্র", exact: true }).click();
  assert.equal(await page.locator("#generator-mode").inputValue(), "auto");
  assert.equal(await page.locator("#generator-cq-set-count").inputValue(), "2");
  assert.equal(await page.locator(".cq-set").count(), 2);
  await page.getByRole("button", { name: "MCQ প্রশ্নপত্র", exact: true }).click();
  assert.equal(await page.locator("#generator-mode").inputValue(), "manual",
    "CQ Set configuration does not overwrite the MCQ generation mode");
});

function pdfPageBoxes(buffer) {
  const pdf = buffer.toString("latin1");
  return [...pdf.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)]
    .map((match) => ({
      width: Number(match[3]) - Number(match[1]),
      height: Number(match[4]) - Number(match[2]),
    }));
}

test("local drafts save and restore independent MCQ and CQ state", async (t) => {
  const page = await openEditor(t);
  const selectWorkflow = (kind) => page.getByRole("button", {
    name: kind === "MCQ" ? "MCQ প্রশ্নপত্র" : "CQ প্রশ্নপত্র",
    exact: true,
  });

  await page.getByRole("button", { name: "DEMO প্রশ্নপত্র তৈরি / খুলুন" }).click();
  await page.locator("#exam").fill("MCQ draft regression");
  await page.getByRole("button", { name: "প্রশ্নপত্র সংরক্ষণ", exact: true }).click();
  const mcqDraft = await page.evaluate(() => JSON.parse(localStorage.getItem("paper-maker-demo-mcq-v1")));
  assert.equal(mcqDraft.settings.exam, "MCQ draft regression");
  assert.ok(mcqDraft.questions.length > 0);
  assert.ok(mcqDraft.questions.every((question) => question.kind === "MCQ"));

  await selectWorkflow("CQ").click();
  await page.locator("#exam").fill("CQ draft regression");
  await page.getByRole("button", { name: "প্রশ্নপত্র সংরক্ষণ", exact: true }).click();
  const cqDraft = await page.evaluate(() => JSON.parse(localStorage.getItem("paper-maker-demo-cq-v1")));
  assert.equal(cqDraft.settings.exam, "CQ draft regression");
  assert.ok(cqDraft.questions.length > 0);
  assert.ok(cqDraft.questions.every((question) => question.kind === "CQ"));

  await page.reload({ waitUntil: "domcontentloaded" });
  await openQuestionCreator(page);
  await selectWorkflow("CQ").click();
  await page.getByRole("button", { name: "DEMO প্রশ্নপত্র তৈরি / খুলুন" }).click();
  await page.locator("#exam").fill("Discarded change");
  await page.getByRole("button", { name: "খসড়া খুলুন", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#exam")?.value === "CQ draft regression");

  await selectWorkflow("MCQ").click();
  await page.getByRole("button", { name: "DEMO প্রশ্নপত্র তৈরি / খুলুন" }).click();
  await page.locator("#exam").fill("Another discarded change");
  await page.getByRole("button", { name: "খসড়া খুলুন", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#exam")?.value === "MCQ draft regression");
});

test("Question Settings uses an independent full page without navigation", async (t) => {
  const page = await openEditor(t);
  await page.getByRole("button", { name: "ডার্ক মোড" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const shell = page.locator(".app-shell:visible");
  const originalColors = await page.evaluate(() => ({
    primary: getComputedStyle([...document.querySelectorAll(".app-shell")].find((element) => element.getClientRects().length)).getPropertyValue("--primary").trim(),
    navbar: getComputedStyle([...document.querySelectorAll(".topbar")].find((element) => element.getClientRects().length)).backgroundColor,
  }));
  assert.equal(await shell.evaluate((element) => element.classList.contains("settings-theme-active")), false);

  await page.getByRole("button", { name: "পরীক্ষার সেটিংস" }).click();
  await page.waitForURL("**/app/settings");
  await page.locator(".question-settings-full-page").waitFor();
  const settingsColors = await page.evaluate(() => ({
    primary: getComputedStyle(document.querySelector(".app-shell.question-settings-route")).getPropertyValue("--primary").trim(),
  }));
  assert.equal(await shell.evaluate((element) => element.classList.contains("settings-theme-active")), false);
  assert.equal(settingsColors.primary, originalColors.primary);
  assert.equal(await page.locator(".question-settings-full-page").isVisible(), true);
  const settingsTextColors = await page.evaluate(() => ({
    heading: getComputedStyle(document.querySelector(".question-settings-page-header h1")).color,
    fieldLabel: getComputedStyle(document.querySelector(".paper-settings-section .field label")).color,
    previewLabel: getComputedStyle(document.querySelector(".exam-header-preview-label")).color,
    previewText: getComputedStyle(document.querySelector(".exam-header-preview-paper")).color,
    previewBackground: getComputedStyle(document.querySelector(".exam-header-preview-paper")).backgroundColor,
    input: getComputedStyle(document.querySelector(".paper-settings-section #settings-exam")).color,
  }));
  assert.equal(settingsTextColors.heading, "rgb(232, 245, 241)");
  assert.equal(settingsTextColors.fieldLabel, "rgb(232, 245, 241)");
  assert.equal(settingsTextColors.previewLabel, "rgb(232, 245, 241)");
  assert.equal(settingsTextColors.previewText, "rgb(232, 245, 241)");
  assert.equal(settingsTextColors.previewBackground, "rgba(8, 38, 36, 0.88)");
  assert.equal(settingsTextColors.input, "rgb(232, 245, 241)");
  assert.ok(contrastRatio("#e8f5f1", "#082624") >= 7);
  await page.locator(".paper-settings-section #settings-exam").fill("মডেল পরীক্ষা");
  assert.match(await page.locator(".exam-header-preview-title").innerText(), /মডেল পরীক্ষা/);
  for (const selector of [".topbar", ".top-navigation", ".user-mobile-menu", ".editor-toolbar", ".question-preview-navbar", ".work-area", ".page-stack", ".preview-toolbar"]) {
    assert.equal(await page.locator(`${selector}:visible`).count(), 0, `${selector} should not appear on the standalone settings page`);
  }
  assert.equal(await page.getByRole("navigation", { includeHidden: false }).count(), 0,
    "the standalone settings page should not render navigation menus");
  assert.deepEqual(
    (await page.locator(".question-settings-full-page").getByRole("button").allTextContents()).map((label) => label.trim()).filter(Boolean).sort(),
    ["CQ", "MCQ", "এডিটরে ফিরে যান", "সংরক্ষণ করুন (Save)"].sort(),
    "the standalone page should expose only settings selectors and the Save/Back actions",
  );
  assert.equal(await page.locator(".question-settings-full-page #institution").count(), 1);

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      page: document.querySelector(".app-shell.question-settings-route").getBoundingClientRect().toJSON(),
      contentPage: document.querySelector(".question-settings-full-page").getBoundingClientRect().toJSON(),
    }));
    assert.ok(dimensions.content <= dimensions.viewport,
      `The settings page should not overflow at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.ok(Math.abs(dimensions.page.top) <= 1 && Math.abs(dimensions.contentPage.top) <= 1,
      `The standalone settings view should begin at the top of the viewport at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.ok(Math.abs(dimensions.page.height - 900) <= 1 && Math.abs(dimensions.contentPage.height - 900) <= 1,
      `The standalone settings view should fill the viewport at ${width}px: ${JSON.stringify(dimensions)}`);
  }

  await page.getByRole("button", { name: "এডিটরে ফিরে যান" }).click();
  await page.waitForURL("**/app");
  await page.locator(".question-settings-full-page").waitFor({ state: "hidden" });
  assert.equal(await shell.evaluate((element) => element.classList.contains("settings-theme-active")), false);
  assert.equal(await shell.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--primary").trim()), originalColors.primary);
  assert.equal(await page.locator(".topbar").evaluate((element) =>
    getComputedStyle(element).backgroundColor), originalColors.navbar);
  await page.getByRole("button", { name: "ডার্ক মোড" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.getByRole("button", { name: "পরীক্ষার সেটিংস" }).click();
  await page.waitForURL("**/app/settings");
  await page.locator(".question-settings-full-page").waitFor();
  assert.equal(await page.locator(".topbar:visible").count(), 0);
  assert.equal(await shell.evaluate((element) => element.classList.contains("settings-theme-active")), false);
  assert.notEqual(await page.locator(".paper-settings-section").evaluate((element) => getComputedStyle(element).backgroundImage), "none");
  await page.getByRole("button", { name: "এডিটরে ফিরে যান" }).click();
  await page.waitForURL("**/app");
  await page.locator(".question-settings-full-page").waitFor({ state: "hidden" });
  assert.equal(await shell.evaluate((element) => element.classList.contains("settings-theme-active")), false);
  assert.equal(await shell.evaluate((element) => getComputedStyle(element).getPropertyValue("--canvas").trim()), "#e8f8f3");
});

test("exam settings save only on click, prevents duplicates, and reports success or failure", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const settingsRequests = [];
  const savedSettings = new Map();
  let settingsResponseStatus = 201;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: "teacher-1", email: "teacher@example.com", name: "Test Teacher", role: "TEACHER" } } });
      return;
    }
    if (url.pathname === "/api/questions/catalog") {
      await route.fulfill({ json: { classes: [], groups: [], subjects: [], chapters: [], topics: [] } });
      return;
    }
    if (url.pathname === "/api/tokens") {
      await route.fulfill({ json: { balance: 0, tokenRates: { MCQ: 1, CQ: 10, SHORT: 5 }, transactions: [] } });
      return;
    }
    if (url.pathname === "/api/papers/settings" && route.request().method() === "GET") {
      await route.fulfill({ json: { settings: Object.fromEntries(savedSettings) } });
      return;
    }
    if (url.pathname.endsWith("/settings") && ["POST", "PUT"].includes(route.request().method())) {
      const requestBody = JSON.parse(route.request().postData() ?? "{}");
      settingsRequests.push(requestBody);
      await delay(250);
      if (settingsResponseStatus === 201) {
        const paper = { id: "settings-paper", title: requestBody.title, settings: requestBody.settings };
        savedSettings.set(requestBody.settings.questionType, paper);
        await route.fulfill({
          status: route.request().method() === "POST" ? 201 : 200,
          json: { paper },
        });
      } else {
        await route.fulfill({ status: 500, json: { error: "Database unavailable" } });
      }
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  await openQuestionCreator(page);
  await page.locator(".account-menu-name").filter({ hasText: "Test Teacher" }).waitFor();
  assert.equal(await page.locator(".toolbar-actions").getByRole("button", { name: "খসড়া খুলুন", exact: true }).count(), 0);
  assert.equal(await page.locator(".toolbar-actions").getByRole("button", { name: "প্রশ্নপত্র সংরক্ষণ", exact: true }).count(), 0);
  await page.getByRole("button", { name: "পরীক্ষার সেটিংস" }).click();
  await page.waitForURL("**/app/settings");
  await page.locator(".question-settings-full-page").waitFor();
  assert.equal(await page.locator("#paper-settings .settings-save-button").count(), 1);
  await page.locator("#institution").fill("Updated School");
  await page.locator("#settings-exam").fill("Updated Exam");
  await page.locator("#class").fill("Updated Class");
  await page.locator("#subject").fill("Updated Subject");
  await page.locator("#duration").fill("Updated Duration");
  await page.locator("#instructions").fill("Updated instructions");
  await page.locator("#marks").fill("80");
  const saveButton = page.getByRole("button", { name: "সংরক্ষণ করুন (Save)" });
  assert.equal(settingsRequests.length, 0, "editing fields must not send settings to the backend");

  await page.setViewportSize({ width: 375, height: 844 });
  assert.equal(await page.locator(".work-area").isVisible(), false, "mobile settings should not expose editor pane tabs");
  await saveButton.click();
  await page.waitForFunction(() => document.querySelector(".settings-save-button")?.disabled);
  assert.equal(settingsRequests.length, 1, "a save click should issue only one request");
  assert.equal(await page.locator(".question-settings-full-page").isVisible(), true,
    "keep the settings page open while saving is pending");
  await page.waitForURL("**/app");
  await page.locator(".question-settings-full-page").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".work-area").isVisible(), true, "successful save should restore the editor");
  assert.equal(await page.locator("#exam").inputValue(), "Updated Exam",
    "returning after a settings save should reflect the saved exam title in the restored editor");
  assert.equal(settingsRequests[0].title, "Updated Exam");
  assert.equal(settingsRequests[0].settings.institution, "Updated School");
  assert.equal(settingsRequests[0].settings.exam, "Updated Exam");
  assert.equal(settingsRequests[0].settings.className, "Updated Class");
  assert.equal(settingsRequests[0].settings.subject, "Updated Subject");
  assert.equal(settingsRequests[0].settings.duration, "Updated Duration");
  assert.equal(settingsRequests[0].settings.instructions, "Updated instructions");
  assert.equal(settingsRequests[0].settings.marks, 80);
  assert.equal(settingsRequests[0].settings.questionType, "MCQ");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await openQuestionCreator(page);
  await page.locator(".account-menu-name").filter({ hasText: "Test Teacher" }).waitFor();
  await page.getByRole("button", { name: "পরীক্ষার সেটিংস" }).click();
  await page.waitForURL("**/app/settings");
  await page.locator(".question-settings-full-page").waitFor();
  await page.waitForFunction(() => document.querySelector("#institution")?.value === "Updated School");
  assert.equal(await page.locator("#marks").inputValue(), "80", "saved settings should reload from the backend after refresh");
  assert.equal(await page.locator("#settings-exam").inputValue(), "Updated Exam");
  assert.equal(await page.locator("#class").inputValue(), "Updated Class");
  assert.equal(await page.locator("#subject").inputValue(), "Updated Subject");
  assert.equal(await page.locator("#duration").inputValue(), "Updated Duration");
  assert.equal(await page.locator("#instructions").inputValue(), "Updated instructions");

  await page.locator(".question-settings-kind-picker").getByRole("button", { name: "CQ", exact: true }).click();
  await page.locator("#cq-page-layout").selectOption("one");
  await page.locator("#institution").fill("CQ School");
  await page.locator("#answer-key").check();
  await page.getByRole("button", { name: "সংরক্ষণ করুন (Save)" }).click();
  await page.waitForURL("**/app");
  assert.equal(settingsRequests.length, 2);
  assert.equal(settingsRequests[1].settings.questionType, "CQ");
  assert.equal(settingsRequests[1].settings.showAnswers, true);
  assert.equal(settingsRequests[1].settings.cqPageLayout, "one");

  await page.reload({ waitUntil: "domcontentloaded" });
  await openQuestionCreator(page);
  await page.locator(".account-menu-name").filter({ hasText: "Test Teacher" }).waitFor();
  await page.getByRole("button", { name: "পরীক্ষার সেটিংস" }).click();
  await page.waitForURL("**/app/settings");
  await page.locator(".question-settings-full-page").waitFor();
  await page.locator(".question-settings-kind-picker").getByRole("button", { name: "CQ", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#institution")?.value === "CQ School");
  assert.equal(await page.locator("#answer-key").isChecked(), true, "CQ settings should load independently after refresh");
  assert.equal(await page.locator("#cq-page-layout").inputValue(), "one", "the selected CQ layout should load after refresh");
  await page.locator(".question-settings-kind-picker").getByRole("button", { name: "MCQ", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#institution")?.value === "Updated School");
  assert.equal(await page.locator("#answer-key").isChecked(), false, "MCQ answer settings should remain independent");

  settingsResponseStatus = 500;
  await page.locator(".question-settings-kind-picker").getByRole("button", { name: "CQ", exact: true }).click();
  await page.locator("#institution").fill("Failed Save School");
  await page.getByRole("button", { name: "সংরক্ষণ করুন (Save)" }).click();
  await page.locator(".settings-save-status.error").filter({ hasText: "Database unavailable" }).waitFor();
  assert.equal(await page.locator(".question-settings-full-page").isVisible(), true,
    "failed saves should keep the user on the settings page");
  assert.equal(settingsRequests.length, 3);
  assert.equal(settingsRequests[2].settings.institution, "Failed Save School");
  assert.equal(await page.locator(".settings-save-button").isDisabled(), false);
});

test("MCQ output retains two A4 portrait columns and Bengali font loading", async (t) => {
  const page = await openEditor(t);
  await page.locator(".question-preview-navbar").getByRole("button", { name: "DEMO প্রশ্নপত্র তৈরি / খুলুন" }).click();
  await page.waitForFunction(() =>
    document.querySelectorAll(".page-stack .paper-page .paper-question").length === 15,
  );
  await page.waitForFunction(() => {
    const measured = [...document.querySelectorAll(".measure-layer .paper-equation math-field")];
    const preview = [...document.querySelectorAll(".page-stack .paper-equation math-field")];
    return measured.length > 1 && preview.length > 1 &&
      measured.every((field) => field.getBoundingClientRect().height > 0) &&
      preview.every((field) => field.getBoundingClientRect().height > 0);
  });
  await page.evaluate(() => document.fonts.ready);
  const bengaliFonts = await page.evaluate(() => ({
    faces: [...document.fonts]
      .filter((face) => face.family.replace(/["']/g, "") === "Noto Sans Bengali")
      .map((face) => face.status),
    resources: performance.getEntriesByType("resource")
      .filter((entry) => /noto-sans-bengali.*\.woff2(?:$|\?)/i.test(entry.name))
      .map((entry) => ({ bytes: entry.decodedBodySize, durationMs: entry.duration })),
  }));
  assert.ok(bengaliFonts.faces.includes("loaded"), JSON.stringify(bengaliFonts));
  assert.ok(bengaliFonts.resources.length > 0 && bengaliFonts.resources.every(({ bytes }) => bytes > 0),
    JSON.stringify(bengaliFonts));
  const layout = await page.locator(".page-stack .paper-page").evaluateAll((pages) =>
    pages.map((element) => ({
      widthMm: element.getBoundingClientRect().width * 25.4 / 96,
      columns: getComputedStyle(element.querySelector(".paper-flow")).gridTemplateColumns.split(" ").length,
      font: getComputedStyle(element).fontFamily,
      columnQuestionNumbers: [...element.querySelectorAll(".paper-column")].map((column) =>
        [...column.querySelectorAll(".paper-q-number")].map((number) =>
          Number.parseInt(number.textContent, 10))),
    })),
  );
  const firstPage = layout[0];
  const firstPageNumbers = firstPage.columnQuestionNumbers.flat();
  assert.ok(Math.abs(firstPage.widthMm - 210) < 1, `Expected A4 portrait width, got ${firstPage.widthMm}mm`);
  assert.equal(firstPage.columns, 2);
  assert.match(firstPage.font, /Noto Serif Bengali/);
  assert.ok(firstPage.columnQuestionNumbers[0].length > 0);
  assert.ok(firstPage.columnQuestionNumbers[1].length > 0, "MCQs should continue in the right column");
  assert.deepEqual(firstPageNumbers, firstPageNumbers.slice().sort((a, b) => a - b),
    "Questions should flow down the left column before continuing at the top of the right");
  assert.deepEqual(
    layout.flatMap((paperPage) => paperPage.columnQuestionNumbers.flat()),
    Array.from({ length: 15 }, (_, index) => index + 1),
    "Question numbering should remain sequential across columns and pages",
  );

  await page.emulateMedia({ media: "print" });
  const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
  const pages = pdfPageBoxes(pdf);
  assert.ok(pages.length > 0, "MCQ paper should produce at least one PDF page");
  assert.ok(pages.every(({ width, height }) => height > width), "MCQ pages should be portrait");
});

test("CQ output retains exactly two landscape A4 booklet pages and MathLive equations", async (t) => {
  const page = await openEditor(t);
  await page.getByRole("button", { name: "CQ প্রশ্নপত্র", exact: true }).click();
  await page.locator(".question-preview-navbar").getByRole("button", { name: "DEMO প্রশ্নপত্র তৈরি / খুলুন" }).click();
  await page.waitForFunction(() =>
    document.querySelectorAll(".page-stack-print .paper-page-cq").length === 2,
  );
  await page.waitForFunction(() => {
    const measured = [...document.querySelectorAll(".measure-layer .paper-equation math-field")];
    const preview = [...document.querySelectorAll(".page-stack .paper-equation math-field")];
    const print = [...document.querySelectorAll(".page-stack-print .paper-equation math-field")];
    return measured.length > 1 && preview.length > 1 && print.length > 1 &&
      measured.every((field) => field.getBoundingClientRect().height > 0) &&
      preview.every((field) => field.getBoundingClientRect().height > 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: "print" });
  assert.ok(await page.locator(".page-stack-print .paper-equation math-field").evaluateAll((fields) =>
    fields.every((field) => field.getBoundingClientRect().height > 0)),
  "CQ print-preview equations should retain measurable heights");

  const layout = await page.locator(".page-stack-print .paper-page-cq").evaluateAll((pages) =>
    pages.map((element) => ({
      widthMm: element.getBoundingClientRect().width * 25.4 / 96,
      heightMm: element.getBoundingClientRect().height * 25.4 / 96,
      columns: getComputedStyle(element.querySelector(".paper-flow")).gridTemplateColumns.trim().split(/\s+/).length,
      columnQuestionCounts: [...element.querySelectorAll(".paper-column")].map((column) =>
        column.querySelectorAll(".paper-question").length),
      columnQuestionNumbers: [...element.querySelectorAll(".paper-column")].map((column) =>
        [...column.querySelectorAll(".paper-q-number")].map((number) => Number.parseInt(number.textContent, 10))),
      introColumns: [...element.querySelectorAll(".paper-column")].map((column) =>
        Boolean(column.querySelector(".paper-intro"))),
    })),
  );
  assert.equal(layout.length, 2);
  assert.ok(layout.every(({ widthMm, heightMm }) =>
    Math.abs(widthMm - 297) < 1 && Math.abs(heightMm - 210) < 1), JSON.stringify(layout));
  assert.ok(layout.every(({ columns }) => columns === 2));
  assert.deepEqual(layout[0].introColumns, [false, true], "Booklet page 1 heading belongs in its right column");
  assert.equal(await page.locator(".cq-limit-status").evaluate((element) => getComputedStyle(element).display), "none");
  assert.ok(await page.locator(".page-stack-print .paper-equation math-field").count() > 0);
  const bookletSections = [
    layout[0].columnQuestionNumbers[1],
    layout[1].columnQuestionNumbers[0],
    layout[1].columnQuestionNumbers[1],
    layout[0].columnQuestionNumbers[0],
  ];
  const populatedSections = bookletSections.filter((section) => section.length > 0);
  assert.ok(populatedSections.length >= 2, JSON.stringify(bookletSections));
  assert.ok(populatedSections.slice(1).every((section, index) =>
    Math.max(...populatedSections[index]) <= Math.min(...section)), JSON.stringify(bookletSections));

  const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
  const pages = pdfPageBoxes(pdf);
  assert.equal(pages.length, 2, `CQ booklet should export exactly two pages: ${JSON.stringify(pages)}`);
  assert.ok(pages.every(({ width, height }) => width > height), "CQ pages should be landscape");
  assert.ok(pages.every(({ width, height }) =>
    Math.abs(width / height - 297 / 210) < 0.02), "CQ PDF pages should use A4 landscape proportions");
});

test("CQ one-page layout flows sequentially through two columns and prints one landscape A4 page", async (t) => {
  const page = await openEditor(t);
  const duplicateKeyErrors = [];
  page.on("console", (message) => {
    if (/same key.*CQ-one-page/i.test(message.text())) duplicateKeyErrors.push(message.text());
  });
  await page.getByRole("button", { name: "CQ প্রশ্নপত্র", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#cq-page-layout")?.value === "one");
  await page.waitForFunction(() =>
    document.querySelectorAll(".page-stack-cq-preview .paper-page-cq-single").length === 1,
  );
  assert.deepEqual(duplicateKeyErrors, []);
  await page.evaluate(() => document.fonts.ready);
  const layout = await page.locator(".page-stack-cq-preview .paper-page-cq-single").evaluate((element) => {
    const flow = element.querySelector(".cq-single-flow");
    const pageBounds = element.getBoundingClientRect();
    const questionBounds = [...element.querySelectorAll(".paper-question")].map((question) => question.getBoundingClientRect());
    return {
      widthMm: pageBounds.width * 25.4 / 96,
      heightMm: pageBounds.height * 25.4 / 96,
      columns: getComputedStyle(flow).gridTemplateColumns.trim().split(/\s+/).length,
      sectionHeadingCount: element.querySelectorAll(".cq-single-section-title").length,
      questionNumbers: [...element.querySelectorAll(".paper-column")].map((column) =>
        [...column.querySelectorAll(".paper-q-number")].map((number) => Number.parseInt(number.textContent, 10))),
      flowBounds: flow.getBoundingClientRect().toJSON(),
      pageBounds: pageBounds.toJSON(),
      questionBounds: questionBounds.map((bounds) => bounds.toJSON()),
    };
  });
  assert.ok(Math.abs(layout.widthMm - 297) < 1, `Expected A4 landscape width, got ${layout.widthMm}mm`);
  assert.ok(Math.abs(layout.heightMm - 210) < 1, `Expected one A4 landscape page, got ${layout.heightMm}mm`);
  assert.equal(layout.columns, 2);
  assert.equal(layout.sectionHeadingCount, 0, "single-page CQ should not render headings or reserve their space");
  const numbers = layout.questionNumbers.flat();
  assert.ok(numbers.length > 0);
  assert.deepEqual(numbers, numbers.slice().sort((a, b) => a - b));
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, index) => index + 1));
  assert.ok(layout.questionBounds.every((bounds) =>
    bounds.left >= layout.flowBounds.left - 1 &&
    bounds.right <= layout.flowBounds.right + 1 &&
    bounds.top >= layout.flowBounds.top - 1 &&
    bounds.bottom <= layout.flowBounds.bottom + 1),
  "CQ questions must remain inside the fixed printable columns");

  await page.emulateMedia({ media: "print" });
  const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
  const pages = pdfPageBoxes(pdf);
  assert.equal(pages.length, 1, `One-page CQ layout should export exactly one page: ${JSON.stringify(pages)}`);
  assert.ok(pages.every(({ width, height }) => width > height), "CQ output should be landscape");
  assert.ok(pages.every(({ width, height }) => Math.abs(width / height - 297 / 210) < 0.02));
});

test("CQ one-page layout blocks print when content cannot fit instead of clipping it", async (t) => {
  const page = await openEditor(t);
  await page.getByRole("button", { name: "CQ প্রশ্নপত্র", exact: true }).click();
  await page.locator(".question-preview-navbar").getByRole("button", { name: "DEMO প্রশ্নপত্র তৈরি / খুলুন" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".measure-layer [data-measure-id]").length > 20);
  await page.locator("#font-size").fill("16");
  await page.locator("#page-margin").fill("24");
  await page.locator("#cq-page-layout").selectOption("one");
  await page.locator(".cq-limit-status.exceeded").waitFor();
  assert.equal(await page.locator(".page-stack-cq-preview .paper-page-cq-single").count(), 0,
    "an incomplete page should not be shown as a valid preview");
  assert.equal(await page.locator(".toolbar-actions").getByRole("button", { name: "PDF / প্রিন্ট" }).isDisabled(), true);
  assert.match(await page.locator(".cq-limit-status").innerText(), /এক পৃষ্ঠার দুই কলামে ফিট হচ্ছে না/);
});

test("CQ layout switches between one and two pages as measured content fit changes", async (t) => {
  const page = await openEditor(t);
  await page.getByRole("button", { name: "CQ প্রশ্নপত্র", exact: true }).click();
  await page.locator("#font-size").fill("8");
  await page.locator("#line-spacing").fill("1");
  await page.locator("#page-margin").fill("8");
  await page.locator("#column-gap").fill("4");
  await page.waitForFunction(() => document.querySelector("#cq-page-layout")?.value === "one");

  await page.locator("#font-size").fill("16");
  await page.locator("#line-spacing").fill("2.5");
  await page.locator("#page-margin").fill("24");
  await page.locator("#column-gap").fill("18");
  await page.waitForFunction(() => document.querySelector("#cq-page-layout")?.value === "two");

  await page.locator("#font-size").fill("8");
  await page.locator("#line-spacing").fill("1");
  await page.locator("#page-margin").fill("8");
  await page.locator("#column-gap").fill("4");
  await page.waitForFunction(() => document.querySelector("#cq-page-layout")?.value === "one");

  await page.locator("#font-size").fill("16");
  await page.locator("#line-spacing").fill("2.5");
  await page.locator("#page-margin").fill("24");
  await page.locator("#column-gap").fill("18");
  await page.waitForFunction(() => document.querySelector("#cq-page-layout")?.value === "two");
});

test("admin panel searches, filters, creates, edits, and deletes through admin APIs", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  let createdQuestionCount = 0;
  let questions = [{
    id: "question-1",
    type: "MCQ",
    classLevel: "Class 9",
    group: "Science",
    subject: "Physics",
    chapter: "Motion",
    topic: "Speed",
    marks: 1,
    content: { text: "Existing question", options: ["A", "B"] },
  }];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.headers()["content-type"]?.includes("application/json")
      ? request.postDataJSON()
      : undefined;
    requests.push({ path: url.pathname, method, search: url.searchParams.toString(), body });
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: "admin-1", email: "admin@example.com", name: "Admin", role: "ADMIN" } } });
      return;
    }
    if (url.pathname === "/api/admin/questions/catalog") {
      await route.fulfill({ json: { classes: ["Class 9"], groups: ["Science"], subjects: ["Physics"], chapters: ["Motion"], topics: ["Speed"] } });
      return;
    }
    if (url.pathname === "/api/admin/questions/dashboard") {
      await route.fulfill({ json: adminDashboard({ totals: { totalQuestions: 1, mcqQuestions: 1, classes: 1, subjects: 1, chapters: 1, topics: 1, registeredUsers: 1 } }) });
      return;
    }
    if (url.pathname === "/api/admin/questions/academic") {
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    if (url.pathname === "/api/admin/questions" && method === "GET") {
      await route.fulfill({ json: { questions, total: questions.length, limit: 100, offset: 0 } });
      return;
    }
    if (url.pathname === "/api/admin/questions" && method === "POST") {
      createdQuestionCount += 1;
      const question = { id: createdQuestionCount === 1 ? "question-created" : "question-created-cq", ...request.postDataJSON() };
      questions.push(question);
      await route.fulfill({ status: 201, json: { question } });
      return;
    }
    if (/^\/api\/admin\/questions\/question-created(?:-cq)?$/.test(url.pathname) && method === "PATCH") {
      const questionId = url.pathname.split("/").at(-1);
      questions = questions.map((question) => question.id === questionId
        ? { ...question, ...request.postDataJSON() }
        : question);
      await route.fulfill({ json: { question: questions.find(({ id }) => id === questionId) } });
      return;
    }
    if (/^\/api\/admin\/questions\/question-created(?:-cq)?$/.test(url.pathname) && method === "DELETE") {
      const questionId = url.pathname.split("/").at(-1);
      questions = questions.filter(({ id }) => id !== questionId);
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  const authResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/me"));
  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  await authResponsePromise;
  await page.getByRole("button", { name: "অ্যাডমিন প্যানেল" }).waitFor();
  await page.getByRole("button", { name: "অ্যাডমিন প্যানেল" }).click();
  await page.getByText("Existing question").waitFor();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    assert.ok(dimensions.content <= dimensions.viewport,
      `Admin panel must not overflow horizontally at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.equal(await page.locator("#bank-class").isVisible(), true);
    assert.ok(await page.locator("#questions").locator("#bank-class").isVisible());
    assert.equal(await page.getByText("প্রশ্ন রপ্তানি", { exact: true }).isVisible(), true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.locator("#bank-class").selectOption("Class 9");
  await page.locator("#bank-subject").selectOption("Physics");
  await page.locator("#bank-chapter").selectOption("Motion");
  await page.locator("#bank-topic").selectOption("Speed");
  await page.locator("#bank-type").selectOption("MCQ");
  const search = page.getByRole("textbox", { name: "প্রশ্ন খুঁজুন" });
  const searchRequestPromise = page.waitForRequest((request) =>
    request.url().includes("/api/admin/questions?") &&
    new URL(request.url()).searchParams.get("search") === "Existing question");
  await search.fill("Existing question");
  const searchRequest = await searchRequestPromise;
  const searchParams = new URL(searchRequest.url()).searchParams;
  assert.equal(searchParams.get("classLevel"), "Class 9");
  assert.equal(searchParams.get("subject"), "Physics");
  assert.equal(searchParams.get("chapter"), "Motion");
  assert.equal(searchParams.get("topic"), "Speed");
  assert.equal(searchParams.get("type"), "MCQ");

  const resetFiltersRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/admin/questions" &&
      !url.searchParams.has("search") && !url.searchParams.has("type");
  });
  await search.fill("");
  await page.locator("#bank-type").selectOption("");
  assert.equal(await page.locator("#bank-type").inputValue(), "");
  await resetFiltersRequest;
  await page.getByRole("button", { name: "বহুনির্বাচনি যোগ" }).click();
  const createdCard = page.locator(".question-card").last();
  await createdCard.locator('[aria-label="প্রশ্নের বিবরণ"]').fill("New equation question");
  await createdCard.getByLabel("1 নম্বর বিকল্প").fill("Option one");
  await createdCard.getByLabel("2 নম্বর বিকল্প").fill("Option two");
  await createdCard.getByLabel("3 নম্বর বিকল্প").fill("Option three");
  await createdCard.getByLabel("4 নম্বর বিকল্প").fill("Option four");
  await createdCard.locator("input[id^='answer-']").fill("Option one");
  await createdCard.locator("math-field.math-editor").evaluate((field) => {
    field.value = "v=\\\\frac{s}{t}";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const createResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/admin/questions") && response.request().method() === "POST");
  const refreshAfterSavePromise = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/admin/questions" && request.method() === "GET");
  await createdCard.getByRole("button", { name: "প্রশ্ন ব্যাংকে সংরক্ষণ" }).evaluate((button) => {
    button.click();
    button.click();
  });
  await createResponsePromise;
  await refreshAfterSavePromise;
  await page.waitForFunction(() => document.querySelectorAll(".question-card").length >= 2);
  const createRequest = requests.find(({ path, method }) => path === "/api/admin/questions" && method === "POST");
  assert.ok(createRequest);
  assert.equal(createRequest.body.type, "MCQ");
  assert.equal(createRequest.body.content.equation, "v=\\\\frac{s}{t}");
  assert.deepEqual(createRequest.body.content.options, ["Option one", "Option two", "Option three", "Option four"]);
  assert.equal(createRequest.body.content.answer, "Option one");
  assert.equal(requests.filter(({ path, method }) => path === "/api/admin/questions" && method === "POST").length, 1,
    `rapid repeated clicks must submit the manual question only once: ${JSON.stringify(requests.filter(({ path, method }) => path === "/api/admin/questions" && method === "POST"))}`);
  assert.ok(requests.some(({ path, method }) => path === "/api/admin/questions" && method === "GET"),
    "saving should reload the Admin question list");

  const savedCard = page.locator(".question-card").filter({ hasText: "New equation question" });
  await savedCard.locator("select[id^='question-type-']").selectOption("CQ");
  assert.equal(await page.locator("#bank-type").inputValue(), "");
  await savedCard.getByLabel("1 নম্বর উপপ্রশ্ন").fill("First sub-question");
  const updateResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/admin/questions/question-created") && response.request().method() === "PATCH");
  await savedCard.getByRole("button", { name: "প্রশ্ন ব্যাংকে সংরক্ষণ" }).click();
  await updateResponsePromise;
  const updateRequest = requests.find(({ path, method }) => path === "/api/admin/questions/question-created" && method === "PATCH");
  assert.ok(updateRequest);
  assert.equal(updateRequest.body.type, "CQ");
  assert.equal(updateRequest.body.content.subs[0], "First sub-question");

  await savedCard.getByRole("button", { name: "প্রশ্ন মুছুন" }).click();
  assert.ok(requests.some(({ path, method }) => path === "/api/admin/questions/question-created" && method === "DELETE"));
  assert.equal(questions.some(({ id }) => id === "question-created"), false);

  await page.getByRole("button", { name: "সৃজনশীল যোগ" }).click();
  const createdCqCard = page.locator(".question-card").last();
  await createdCqCard.locator('[aria-label="প্রশ্নের বিবরণ"]').fill("CQ stimulus for the manual form");
  await createdCqCard.getByLabel("1 নম্বর উপপ্রশ্ন").fill("Define acceleration");
  const createCqResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/admin/questions") && response.request().method() === "POST");
  await createdCqCard.getByRole("button", { name: "প্রশ্ন ব্যাংকে সংরক্ষণ" }).click();
  await createCqResponsePromise;
  const createCqRequest = requests.filter(({ path, method }) =>
    path === "/api/admin/questions" && method === "POST").at(-1);
  assert.equal(createCqRequest.body.type, "CQ");
  assert.deepEqual(createCqRequest.body.content.subs, ["Define acceleration", "", "", ""]);
});

test("Admin Question Upload extracts editable drafts and refreshes the question bank after saving", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  let listRequests = 0;
  let dashboardRequests = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.headers()["content-type"]?.includes("application/json")
      ? request.postDataJSON()
      : undefined;
    requests.push({ path: url.pathname, method: request.method(), body });
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: "admin-1", email: "admin@example.com", name: "Admin", role: "ADMIN", mustChangePassword: false } } });
      return;
    }
    if (url.pathname === "/api/admin/questions/dashboard") {
      dashboardRequests += 1;
      await route.fulfill({ json: adminDashboard() });
      return;
    }
    if (url.pathname === "/api/admin/questions/academic") {
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    if (url.pathname === "/api/admin/questions/catalog" || url.pathname === "/api/questions/catalog") {
      await route.fulfill({ json: { classes: [], groups: [], subjects: [], chapters: [], topics: [] } });
      return;
    }
    if (url.pathname === "/api/admin/questions" && request.method() === "GET") {
      listRequests += 1;
      await route.fulfill({ json: { questions: [], total: 0, limit: 100, offset: 0 } });
      return;
    }
    if (url.pathname === "/api/admin/questions/upload/extract" && request.method() === "POST") {
      await route.fulfill({ json: {
        totalQuestions: 1,
        pageCount: 1,
        imageCount: 1,
        questions: [{
          id: "draft-1",
          type: "MCQ",
          marks: 1,
          topic: "",
          sourceNumber: "1",
          content: { text: "2 + 2 = ?", options: ["৪", "৫"], imageUrls: ["/api/uploads/images/preview-image"] },
          sourcePages: [1],
          uncertain: false,
          uncertainty: [],
        }],
      } });
      return;
    }
    if (url.pathname === "/api/admin/questions/upload/save" && request.method() === "POST") {
      await route.fulfill({ status: 201, json: { saved: 1, questionIds: ["question-ocr-1"] } });
      return;
    }
    if (url.pathname === "/api/uploads/images/preview-image") {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"),
      });
      return;
    }
    if (url.pathname === "/api/papers/settings") {
      await route.fulfill({ json: { settings: {} } });
      return;
    }
    if (url.pathname === "/api/tokens") {
      await route.fulfill({ json: { balance: 0, tokenRates: { MCQ: 1, CQ: 10, SHORT: 5 }, transactions: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  const dashboard = page.locator("#admin-dashboard");
  await dashboard.waitFor();
  await dashboard.getByRole("button", { name: "Question Upload · MCQ", exact: true }).click();
  const upload = page.locator("#admin-question-upload");
  await upload.getByLabel(/Class/).fill("Class 9");
  await upload.getByLabel("Subject").fill("Mathematics");
  await upload.getByLabel("Chapter").fill("Addition");
  await upload.getByLabel("Topic").fill("Arithmetic");
  await upload.locator('input[type="file"]').setInputFiles({
    name: "questions.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from("PK"),
  });
  await upload.getByRole("button", { name: "প্রশ্ন বের করুন" }).click();
  await upload.getByText("Preview · মোট 1টি প্রশ্ন").waitFor();
  assert.equal(await upload.locator("textarea").first().inputValue(), "2 + 2 = ?");
  await upload.locator(".question-upload-images img").waitFor();
  assert.equal(await upload.locator(".question-upload-warning").count(), 0);
  await upload.locator("textarea").first().fill("2 + 2 = ? (সম্পাদিত)");

  const saveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/admin/questions/upload/save" && response.request().method() === "POST");
  const refreshResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/admin/questions" && response.request().method() === "GET");
  const dashboardRefreshResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/admin/questions/dashboard" && response.request().method() === "GET");
  await upload.getByRole("button", { name: /নিশ্চিত করে সংরক্ষণ করুন/ }).click();
  assert.equal((await saveResponse).status(), 201);
  await refreshResponse;
  await dashboardRefreshResponse;
  await upload.getByRole("status").filter({ hasText: "ডাটাবেজে 1টি প্রশ্ন সংরক্ষিত হয়েছে" }).waitFor();
  assert.ok(listRequests >= 2, "saving must refresh the Admin question list");
  assert.ok(dashboardRequests >= 2, "saving must refresh dashboard statistics");
  const saveRequest = requests.find(({ path, method }) => path === "/api/admin/questions/upload/save" && method === "POST");
  assert.equal(saveRequest.body.type, "MCQ");
  assert.equal(saveRequest.body.classLevel, "Class 9");
  assert.equal(saveRequest.body.subject, "Mathematics");
  assert.equal(saveRequest.body.chapter, "Addition");
  assert.equal(saveRequest.body.questions[0].topic, "Arithmetic");
  assert.equal(saveRequest.body.questions[0].sourceNumber, "1");
  assert.equal(saveRequest.body.questions[0].content.text, "2 + 2 = ? (সম্পাদিত)");
  assert.deepEqual(saveRequest.body.questions[0].content.options, ["৪", "৫"]);
  assert.deepEqual(saveRequest.body.questions[0].content.imageUrls, ["/api/uploads/images/preview-image"]);
});

test("Admin document import keeps large previews responsive, prevents duplicate requests, and allows retries", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  let extractRequests = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: "admin-1", email: "admin@example.com", name: "Admin", role: "ADMIN", mustChangePassword: false } } });
      return;
    }
    if (url.pathname === "/api/admin/questions/dashboard") {
      await route.fulfill({ json: adminDashboard() });
      return;
    }
    if (url.pathname === "/api/admin/questions/academic") {
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    if (url.pathname === "/api/admin/questions/catalog" || url.pathname === "/api/questions/catalog") {
      await route.fulfill({ json: { classes: [], groups: [], subjects: [], chapters: [], topics: [] } });
      return;
    }
    if (url.pathname === "/api/admin/questions" && request.method() === "GET") {
      await route.fulfill({ json: { questions: [], total: 0, limit: 100, offset: 0 } });
      return;
    }
    if (url.pathname === "/api/admin/questions/upload/extract" && request.method() === "POST") {
      extractRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({ json: {
        totalQuestions: 100,
        pageCount: 1,
        imageCount: 0,
        questions: Array.from({ length: 100 }, (_, index) => ({
          id: `draft-${index + 1}`,
          type: "MCQ",
          marks: 1,
          topic: "",
          sourceNumber: String(index + 1),
          content: { text: `প্রশ্ন ${index + 1}`, options: ["উত্তর ১", "উত্তর ২"] },
          sourcePages: [1],
          uncertain: false,
          uncertainty: [],
        })),
      } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  const dashboard = page.locator("#admin-dashboard");
  await dashboard.waitFor();
  await dashboard.getByRole("button", { name: "Question Upload · MCQ", exact: true }).click();
  const upload = page.locator("#admin-question-upload");
  await upload.getByLabel(/Class/).fill("Class 9");
  await upload.getByLabel("Subject").fill("Mathematics");
  await upload.getByLabel("Chapter").fill("Algebra");
  await upload.getByLabel("Topic").fill("Linear equations");
  await upload.locator('input[type="file"]').setInputFiles({
    name: "questions.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from("PK"),
  });

  const extractButton = upload.getByRole("button", { name: "প্রশ্ন বের করুন" });
  await extractButton.dblclick({ delay: 20 });
  await upload.getByRole("status").filter({ hasText: "ডকুমেন্ট থেকে টেক্সট ও ছবি বের করা হচ্ছে" }).waitFor();
  const frameDelay = await page.evaluate(() => new Promise((resolve) => {
    const start = performance.now();
    requestAnimationFrame(() => resolve(performance.now() - start));
  }));
  assert.ok(frameDelay < 1000, `the page should continue rendering during document extraction (frame delay ${frameDelay} ms)`);
  await upload.getByText("Preview · মোট 100টি প্রশ্ন").waitFor();
  assert.equal(await upload.locator(".question-upload-card").count(), 100);
  const editedQuestion = upload.locator(".question-upload-card").last().locator("textarea").first();
  await editedQuestion.fill("সম্পাদিত প্রশ্ন");
  assert.equal(await editedQuestion.inputValue(), "সম্পাদিত প্রশ্ন");
  assert.equal(await upload.locator(".question-upload-card").first().locator("textarea").first().inputValue(), "প্রশ্ন 1");
  assert.equal(extractRequests, 1, "a rapid double click should make only one extract request");

  await extractButton.click();
  await upload.getByText("Preview · মোট 100টি প্রশ্ন").waitFor();
  assert.equal(extractRequests, 2, "a later extraction attempt should work after the first finishes");
});

test("Admin document import clearly rejects scanned PDFs without OCR", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  let extractRequests = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: "admin-1", email: "admin@example.com", name: "Admin", role: "ADMIN", mustChangePassword: false } } });
      return;
    }
    if (url.pathname === "/api/admin/questions/dashboard") {
      await route.fulfill({ json: adminDashboard() });
      return;
    }
    if (url.pathname === "/api/admin/questions/academic") {
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    if (url.pathname === "/api/admin/questions/catalog" || url.pathname === "/api/questions/catalog") {
      await route.fulfill({ json: { classes: [], groups: [], subjects: [], chapters: [], topics: [] } });
      return;
    }
    if (url.pathname === "/api/admin/questions" && request.method() === "GET") {
      await route.fulfill({ json: { questions: [], total: 0, limit: 100, offset: 0 } });
      return;
    }
    if (url.pathname === "/api/admin/questions/upload/extract" && request.method() === "POST") {
      extractRequests += 1;
      await route.fulfill({ status: 422, json: {
        error: "This PDF has no selectable text and appears to be scanned or image-only. OCR is not used.",
      } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  const dashboard = page.locator("#admin-dashboard");
  await dashboard.waitFor();
  await dashboard.getByRole("button", { name: "Question Upload · MCQ", exact: true }).click();
  const upload = page.locator("#admin-question-upload");
  await upload.getByLabel(/Class/).fill("Class 9");
  await upload.getByLabel("Subject").fill("Mathematics");
  await upload.getByLabel("Chapter").fill("Algebra");
  await upload.getByLabel("Topic").fill("Equations");
  await upload.locator('input[type="file"]').setInputFiles({
    name: "scanned.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4"),
  });

  await upload.getByRole("button", { name: "প্রশ্ন বের করুন" }).click();
  await upload.getByRole("alert").filter({ hasText: "OCR is not used" }).waitFor();
  assert.equal(extractRequests, 1);
});

test("password reset dialogs submit generic requests and consume emailed reset links", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ status: 401, json: { error: "Authentication required" } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/auth/forgot-password") {
      requests.push({ path: url.pathname, body: request.postDataJSON() });
      await route.fulfill({
        status: 202,
        json: { message: "If an account exists for that email, password reset instructions will be sent." },
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/auth/reset-password") {
      requests.push({ path: url.pathname, body: request.postDataJSON() });
      await route.fulfill({ json: { message: "Password reset successfully. Please sign in with your new password." } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`${baseUrl}/forgot-password`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("ইমেইল").fill("teacher@example.com");
  await page.getByRole("button", { name: "রিসেট লিংক পাঠান" }).click();
  await page.getByText("এই ইমেইলের জন্য অ্যাকাউন্ট থাকলে, পাসওয়ার্ড রিসেটের নির্দেশনা পাঠানো হবে।").waitFor();
  assert.deepEqual(requests[0], {
    path: "/api/auth/forgot-password",
    body: { email: "teacher@example.com" },
  });

  const token = "d".repeat(64);
  await page.goto(`${baseUrl}/reset-password?token=${token}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "নতুন পাসওয়ার্ড দিন" }).waitFor();
  await page.getByLabel("পাসওয়ার্ড").fill("New-Secure-Password-124");
  await page.getByRole("button", { name: "নতুন পাসওয়ার্ড সংরক্ষণ" }).click();
  await page.getByText("পাসওয়ার্ড রিসেট সম্পন্ন হয়েছে। নতুন পাসওয়ার্ড দিয়ে সাইন ইন করুন।").waitFor();
  assert.deepEqual(requests[1], {
    path: "/api/auth/reset-password",
    body: { token, password: "New-Secure-Password-124" },
  });
  assert.equal(new URL(page.url()).pathname, "/reset-password");
});
