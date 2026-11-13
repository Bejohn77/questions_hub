"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { bn } from "./bn";
import { en } from "./en";

export type Language = "bn" | "en";
const LANGUAGE_STORAGE_KEY = "school-question-paper-language";
export type Theme = "light" | "dark";
const THEME_STORAGE_KEY = "school-question-paper-theme";
const LanguageContext = createContext<{ language: Language; setLanguage: (language: Language) => void } | null>(null);
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null);
let currentLanguage: Language = "bn";
let currentTheme: Theme = "light";
let hasReadSavedLanguage = false;
let localizationActivated = false;
const languageListeners = new Set<() => void>();
const themeListeners = new Set<() => void>();

function subscribeToLanguage(listener: () => void) {
  languageListeners.add(listener);
  return () => {
    languageListeners.delete(listener);
  };
}

function getLanguageSnapshot(): Language {
  return currentLanguage;
}

function getServerLanguageSnapshot(): Language {
  return "bn";
}

function subscribeToTheme(listener: () => void) {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

function getThemeSnapshot(): Theme {
  return currentTheme;
}

function getServerThemeSnapshot(): Theme {
  return "light";
}

function updateLanguage(language: Language) {
  currentLanguage = language;
  hasReadSavedLanguage = true;
  for (const listener of languageListeners) listener();
}

function updateTheme(theme: Theme) {
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;
  for (const listener of themeListeners) listener();
}

function localizeDigits(value: string, language: Language) {
  const bengaliDigits = "০১২৩৪৫৬৭৮৯";
  const englishDigits = "0123456789";
  const sourceDigits = language === "en" ? bengaliDigits : englishDigits;
  const targetDigits = language === "en" ? englishDigits : bengaliDigits;
  return [...value].map((character) => {
    const index = sourceDigits.indexOf(character);
    return index < 0 ? character : targetDigits[index];
  }).join("");
}

const bengaliToKey = new Map<string, keyof typeof bn>(
  Object.entries(bn).map(([key, value]) => [value, key as keyof typeof bn]),
);
const englishToKey = new Map<string, keyof typeof en>(
  Object.entries(en).map(([key, value]) => [value, key as keyof typeof en]),
);
function createDynamicRules(source: typeof bn | typeof en) {
  return (Object.keys(bn) as (keyof typeof bn)[])
    .flatMap((key) => {
      const sourceText = source[key];
      if (!sourceText.includes("{")) return [];
      const placeholders = [...sourceText.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const pattern = new RegExp(`^${sourceText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "(.+?)")}$`);
      return [{ key, pattern, placeholders }];
    });
}
const bengaliDynamicRules = createDynamicRules(bn);
const englishDynamicRules = createDynamicRules(en);

function interpolateUiText(value: string, language: Language) {
  const translations = language === "en" ? en : bn;
  const source = language === "en" ? bengaliToKey : englishToKey;
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const trimmed = value.trim();
  const key = source.get(trimmed);
  if (key) return `${leading}${translations[key]}${trailing}`;

  const dynamicRules = language === "en" ? bengaliDynamicRules : englishDynamicRules;
  for (const rule of dynamicRules) {
    const match = trimmed.match(rule.pattern);
    if (!match) continue;
    const values = new Map(rule.placeholders.map((placeholder, index) => [
      placeholder,
      localizeDigits(match[index + 1] ?? "", language),
    ]));
    const target = translations[rule.key].replace(/\{([^}]+)\}/g, (_, placeholder: string) => values.get(placeholder) ?? "");
    return `${leading}${target}${trailing}`;
  }

  const dynamicPatterns: [RegExp, (match: RegExpMatchArray) => string][] = language === "en"
    ? [
      [/^(\d+)টি প্রশ্ন আমদানি হয়েছে$/, ([, count]) => `${count} questions imported`],
      [/^(\d+)টি প্রশ্ন মুছে ফেলা হয়েছে$/, ([, count]) => `${count} questions deleted`],
      [/^(\d+)টি প্রশ্ন আমদানি করবেন\?$/, ([, count]) => `Import ${count} questions?`],
      [/^(\d+)টি নির্বাচিত প্রশ্ন স্থায়ীভাবে মুছবেন\?$/, ([, count]) => `Permanently delete ${count} selected questions?`],
      [/^অ্যাকাউন্ট: (.+)$/, ([, account]) => `Account: ${account}`],
      [/^প্রশ্ন (\d+) নির্বাচন করুন$/, ([, number]) => `Select question ${number}`],
      [/^(\d+) নম্বর বিকল্প$/, ([, number]) => `Option ${number}`],
      [/^(\d+) নম্বর উপপ্রশ্ন$/, ([, number]) => `Subquestion ${number}`],
      [/^সারণির শিরোনাম (\d+)$/, ([, number]) => `Table column ${number}`],
      [/^সারণির ঘর (\d+), (\d+)$/, ([, row, column]) => `Table cell ${row}, ${column}`],
    ]
    : [
      [/^(\d+) questions imported$/, ([, count]) => `${count}টি প্রশ্ন আমদানি হয়েছে`],
      [/^(\d+) questions deleted$/, ([, count]) => `${count}টি প্রশ্ন মুছে ফেলা হয়েছে`],
      [/^Import (\d+) questions\?$/, ([, count]) => `${count}টি প্রশ্ন আমদানি করবেন?`],
      [/^Permanently delete (\d+) selected questions\?$/, ([, count]) => `${count}টি নির্বাচিত প্রশ্ন স্থায়ীভাবে মুছবেন?`],
      [/^Account: (.+)$/, ([, account]) => `অ্যাকাউন্ট: ${account}`],
      [/^Select question (\d+)$/, ([, number]) => `প্রশ্ন ${number} নির্বাচন করুন`],
      [/^Option (\d+)$/, ([, number]) => `${number} নম্বর বিকল্প`],
      [/^Subquestion (\d+)$/, ([, number]) => `${number} নম্বর উপপ্রশ্ন`],
      [/^Table column (\d+)$/, ([, number]) => `সারণির শিরোনাম ${number}`],
      [/^Table cell (\d+), (\d+)$/, ([, row, column]) => `সারণির ঘর ${row}, ${column}`],
    ];
  for (const [pattern, translate] of dynamicPatterns) {
    const match = trimmed.match(pattern);
    if (match) return `${leading}${translate(match)}${trailing}`;
  }
  if (/^[০-৯0-9][০-৯0-9.,:/%· -]*$/.test(trimmed)) {
    return `${leading}${localizeDigits(trimmed, language)}${trailing}`;
  }
  return value;
}

export function translateUiText(value: string, language: Language) {
  return interpolateUiText(value, language);
}

function isUserContent(node: Node) {
  const parent = node.parentElement;
  return Boolean(parent?.closest(
    "[data-no-translate], script, style, noscript, template, code, pre, .auth-page, .paper-page, .paper-question, .question-readonly, .math-editor-container, math-field, [contenteditable='true'], textarea, input",
  ));
}

function isUserContentElement(element: Element) {
  return Boolean(element.closest(
    "[data-no-translate], script, style, noscript, template, code, pre, .auth-page, .paper-page, .paper-question, .question-readonly, .math-editor-container, math-field, [contenteditable='true']",
  ));
}

function translateElement(element: Element, language: Language) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (!isUserContent(node)) {
      const current = node.nodeValue ?? "";
      const translated = interpolateUiText(current, language);
      if (translated !== current) node.nodeValue = translated;
    }
    node = walker.nextNode();
  }

  const attributeElements = [
    ...(element.matches("[aria-label], [placeholder], [title], [alt]") ? [element] : []),
    ...element.querySelectorAll("[aria-label], [placeholder], [title], [alt]"),
  ];
  for (const attributeElement of attributeElements) {
    if (isUserContentElement(attributeElement)) continue;
    for (const attribute of ["aria-label", "placeholder", "title", "alt"]) {
      const value = attributeElement.getAttribute(attribute);
      if (value) {
        const translated = interpolateUiText(value, language);
        if (translated !== value) attributeElement.setAttribute(attribute, translated);
      }
    }
  }
}

function translateDocument(language: Language) {
  translateElement(document.body, language);
  document.documentElement.lang = language;
  document.title = language === "en" ? en.siteTitle : bn.siteTitle;
  document.querySelector('meta[name="description"]')?.setAttribute(
    "content",
    language === "en" ? en.siteDescription : bn.siteDescription,
  );
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const language = useSyncExternalStore(subscribeToLanguage, getLanguageSnapshot, getServerLanguageSnapshot);
  const setLanguage = useCallback((nextLanguage: Language) => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
    localizationActivated = true;
    updateLanguage(nextLanguage);
  }, []);

  useEffect(() => {
    const readSavedLanguage = () => {
      if (hasReadSavedLanguage) return;
      hasReadSavedLanguage = true;
      const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (saved === "bn" || saved === "en") {
        localizationActivated = saved === "en";
        updateLanguage(saved);
      }
    };
    let savedLanguageTimer: number | undefined;
    const scheduleSavedLanguageRead = () => {
      savedLanguageTimer = window.setTimeout(readSavedLanguage, 0);
    };
    if (document.readyState === "complete") scheduleSavedLanguageRead();
    else window.addEventListener("load", scheduleSavedLanguageRead, { once: true });

    const onStorage = (event: StorageEvent) => {
      if (event.key !== LANGUAGE_STORAGE_KEY) return;
      if (event.newValue === "bn" || event.newValue === "en") {
        localizationActivated = true;
        updateLanguage(event.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      if (savedLanguageTimer !== undefined) window.clearTimeout(savedLanguageTimer);
      window.removeEventListener("load", scheduleSavedLanguageRead);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!localizationActivated) return;
    let observer: MutationObserver | undefined;
    let translationTimer: number | undefined;
    const activateLocalization = () => {
      translationTimer = window.setTimeout(() => {
        if (localizationActivated) translateDocument(language);
        observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === "characterData" && record.target.parentElement && !isUserContent(record.target)) {
              record.target.nodeValue = interpolateUiText(record.target.nodeValue ?? "", language);
            }
            for (const addedNode of record.addedNodes) {
              if (addedNode instanceof Element) translateElement(addedNode, language);
              else if (addedNode.nodeType === Node.TEXT_NODE && !isUserContent(addedNode)) {
                addedNode.nodeValue = interpolateUiText(addedNode.nodeValue ?? "", language);
              }
            }
            if (record.type === "attributes" && record.target instanceof Element) {
              translateElement(record.target, language);
            }
          }
        });
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["aria-label", "placeholder", "title", "alt"],
        });
      }, 750);
    };
    if (document.readyState === "complete") activateLocalization();
    else window.addEventListener("load", activateLocalization, { once: true });
    return () => {
      if (translationTimer !== undefined) window.clearTimeout(translationTimer);
      window.removeEventListener("load", activateLocalization);
      observer?.disconnect();
    };
  }, [language]);

  const contextValue = useMemo(() => ({ language, setLanguage }), [language, setLanguage]);
  return <LanguageContext.Provider value={contextValue}>{children}</LanguageContext.Provider>;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, getServerThemeSnapshot);
  const setTheme = useCallback((nextTheme: Theme) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    updateTheme(nextTheme);
  }, []);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "light" || savedTheme === "dark") updateTheme(savedTheme);

    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY && (event.newValue === "light" || event.newValue === "dark")) {
        updateTheme(event.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const contextValue = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within LanguageProvider");
  return context;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}

export function LanguageSwitcher() {
  const { language, setLanguage } = useLanguage();
  return (
    <div className="language-switcher" role="group" aria-label={language === "en" ? "Language" : "ভাষা"}>
      <button type="button" aria-pressed={language === "bn"} onClick={() => setLanguage("bn")}>বাংলা</button>
      <span aria-hidden="true">|</span>
      <button type="button" aria-pressed={language === "en"} onClick={() => setLanguage("en")}>English</button>
    </div>
  );
}

export function ThemeSwitcher() {
  const { language } = useLanguage();
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-switcher" role="group" aria-label={language === "en" ? "Color theme" : "রঙের থিম"}>
      <button
        type="button"
        aria-label={language === "en" ? "Light Mode" : "লাইট মোড"}
        aria-pressed={theme === "light"}
        onClick={() => setTheme("light")}
      >
        <span className="theme-option-full">{language === "en" ? "Light Mode" : "লাইট মোড"}</span>
        <span className="theme-option-compact">{language === "en" ? "Light" : "লাইট"}</span>
      </button>
      <span aria-hidden="true">|</span>
      <button
        type="button"
        aria-label={language === "en" ? "Dark Mode" : "ডার্ক মোড"}
        aria-pressed={theme === "dark"}
        onClick={() => setTheme("dark")}
      >
        <span className="theme-option-full">{language === "en" ? "Dark Mode" : "ডার্ক মোড"}</span>
        <span className="theme-option-compact">{language === "en" ? "Dark" : "ডার্ক"}</span>
      </button>
    </div>
  );
}
