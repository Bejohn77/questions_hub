"use client";

import {
  ArrowRight,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  CircleHelp,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Home,
  Library,
  Activity,
  BookMarked,
  FilePlus2,
  LogOut,
  GraduationCap,
  LayoutDashboard,
  Menu,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Trash2,
  Upload,
  Users,
  UserRound,
  X,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { CSSProperties, Ref } from "react";
import { createPortal } from "react-dom";
import type { MathfieldElement } from "mathlive";
import { apiFetch, readApiJson } from "./api/api-client";
import { invalidateCurrentSessionRequest, type AuthenticatedUser } from "./api/auth-session";
import AdminQuestionUpload from "./components/admin-question-upload";
import { LanguageSwitcher, ThemeSwitcher, translateUiText, useLanguage } from "./i18n/language-provider";

let mathLiveInitialization: Promise<void> | undefined;

function initializeMathLive() {
  mathLiveInitialization ??= import("mathlive")
    .then(() => customElements.whenDefined("math-field"))
    .then(() => undefined);
  return mathLiveInitialization;
}

type QuestionKind = "MCQ" | "CQ";
type QuestionDifficulty = "easy" | "medium" | "hard";
type QuestionCreationMethod = "quick" | "manual" | "manual-create" | "blueprint" | "previous";
type UserPanelView = "home" | "create" | "papers" | "notifications" | "profile" | "subscription" | "help";
type CqSetConfiguration = { setNumber: number; chapters: string[]; questionCount: number };
type CqGenerationSet = Omit<CqSetConfiguration, "setNumber">;
type SavedPaperSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  _count: { items: number };
};
type AdminDashboard = {
  totals: Record<string, number>;
  classDistribution: { name: string; count: number }[];
  subjectDistribution: { name: string; count: number }[];
  recentMcqQuestions: {
    id: string;
    type: string;
    classLevel: string;
    subject: string;
    chapter: string;
    marks: number;
    createdAt: string;
    content: unknown;
    author: { name: string; email: string };
  }[];
  recentCqQuestions: {
    id: string;
    type: string;
    classLevel: string;
    subject: string;
    chapter: string;
    marks: number;
    createdAt: string;
    content: unknown;
    author: { name: string; email: string };
  }[];
  recentUsers: { id: string; name: string; email: string; role: string; createdAt: string }[];
  registrationTrend: { day: string; count: number }[];
  questionUploadTrend: { day: string; mcqCount: number; cqCount: number }[];
  uploadStats: { attempts: number; importedRows: number; failedRows: number; duplicateRows: number };
  recentImports: {
    id: string;
    filename: string;
    questionType: string;
    status: string;
    totalRows: number;
    importedRows: number;
    failedRows: number;
    createdAt: string;
    admin: { name: string; email: string };
  }[];
  recentManualUploads: {
    id: string;
    action: string;
    entityType: string;
    entityId: string | null;
    createdAt: string;
    details: unknown;
    admin: { name: string; email: string };
  }[];
  recentActivities: {
    id: string;
    action: string;
    entityType: string;
    entityId: string | null;
    createdAt: string;
    details: unknown;
    admin: { name: string; email: string };
  }[];
  capabilities: { activeSessions: boolean; loginAudit: boolean; userManagement: boolean };
};

type Question = {
  id: string;
  kind: QuestionKind;
  text: string;
  marks: number;
  options?: string[];
  subs?: string[];
  answer?: string;
  explanation?: string;
  difficulty?: QuestionDifficulty;
  equation?: string;
  imageUrl?: string;
  imageUrls?: string[];
  table?: { headers: string[]; rows: string[][] };
  diagram?: "plant-cell";
  subMarks?: number[];
  serverId?: string;
  breakAfter?: boolean;
  classLevel?: string;
  group?: string;
  subject?: string;
  chapter?: string;
  topic?: string;
  setNumber?: number;
};

function dashboardQuestionText(content: unknown) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content && typeof content.text === "string") {
    return content.text;
  }
  return "প্রশ্নের বিবরণ নেই";
}

type QuestionCatalog = {
  classes: string[];
  groups: string[];
  subjects: string[];
  chapters: string[];
  topics: string[];
};

type GeneratedQuestionRow = {
  id: string;
  type: string;
  marks: number;
  classLevel: string;
  group: string;
  subject: string;
  chapter: string;
  topic: string;
  setNumber?: number;
  content: Partial<Question>;
};

type PreviousPaper = {
  id: string;
  title: string;
  settings: Partial<PaperSettings> & { questionType?: QuestionKind };
  items: { question: GeneratedQuestionRow }[];
};

function mapGeneratedQuestion(item: GeneratedQuestionRow): Question {
  return {
    ...item.content,
    id: item.id,
    serverId: item.id,
    kind: item.type === "MCQ" ? "MCQ" : "CQ",
    text: item.content.text ?? "",
    marks: item.marks,
    classLevel: item.classLevel,
    group: item.group,
    subject: item.subject,
    chapter: item.chapter,
    topic: item.topic,
    ...(item.setNumber !== undefined ? { setNumber: item.setNumber } : {}),
  };
}

function restoreCqGenerationSets(savedSets?: CqSetConfiguration[]): CqGenerationSet[] {
  return Array.from({ length: 4 }, (_, index) => {
    const savedSet = savedSets?.find((set) => set.setNumber === index + 1);
    return savedSet
      ? { chapters: savedSet.chapters, questionCount: savedSet.questionCount }
      : { chapters: [], questionCount: 1 };
  });
}

function selectedQuestionsMatchSelection(
  questions: Question[],
  selectedIds: string[],
  classLevel: string,
  subject: string,
) {
  if (!classLevel.trim() || !subject.trim()) return false;
  const selected = new Set(selectedIds);
  const selectedQuestions = questions.filter((question) => selected.has(question.serverId ?? question.id));
  return selectedQuestions.length === selected.size &&
    selectedQuestions.every((question) => question.classLevel === classLevel && question.subject === subject);
}

type PaperSettings = {
  institution: string;
  exam: string;
  duration: string;
  marks: number;
  instructions: string;
  className: string;
  group: string;
  subject: string;
  chapter: string;
  topic: string;
  fontSize: number;
  margin: number;
  columnGap: number;
  lineSpacing: number;
  cqSetCount?: 0 | 2 | 3 | 4;
  cqSetAssignments?: Record<string, number>;
  cqSets?: CqSetConfiguration[];
};

type SavedPaperSettings = Partial<PaperSettings> & {
  showAnswers?: boolean;
  questionType?: QuestionKind;
  cqPageLayout?: "one" | "two";
  cqSetCount?: 0 | 2 | 3 | 4;
  cqSetAssignments?: Record<string, number>;
};

type QuestionFragment = {
  id: string;
  question: Question;
  number: number;
  startSubIndex: number;
  endSubIndex: number;
  subquestionIndexes: number[];
  showImage: boolean;
  showDetails: boolean;
};

type PaperPage = {
  kind: QuestionKind;
  columns: QuestionFragment[][];
};

// Logical section order is imposed into booklet page and column positions.
const cqPagePlacement = [
  { pageOffset: 0, columnIndex: 1 },
  { pageOffset: 1, columnIndex: 0 },
  { pageOffset: 1, columnIndex: 1 },
  { pageOffset: 0, columnIndex: 0 },
] as const;

const initialSettings: PaperSettings = {
  institution: "আলোকধারা উচ্চ বিদ্যালয়",
  exam: "ষান্মাসিক মূল্যায়ন — ২০২৬",
  duration: "২ ঘণ্টা ৩০ মিনিট",
  marks: 100,
  instructions: "সব প্রশ্নের উত্তর দাও। প্রতিটি প্রশ্নের ডান পাশে নম্বর দেওয়া আছে।",
  className: "নবম শ্রেণি",
  group: "বিজ্ঞান",
  subject: "পদার্থবিজ্ঞান",
  chapter: "গতি",
  topic: "সরলরৈখিক গতি",
  fontSize: 10,
  margin: 12,
  columnGap: 8,
  lineSpacing: 1.55,
};

const initialQuestions: Question[] = [];

const demoSettings: PaperSettings = {
  ...initialSettings,
  institution: "DEMO · শিক্ষণ অনুশীলন কেন্দ্র",
  exam: "নবম–দশম শ্রেণি · বিজ্ঞান মডেল পরীক্ষা",
  duration: "৩ ঘণ্টা",
  marks: 100,
  instructions: "সব বহুনির্বাচনি প্রশ্নের উত্তর দাও। সৃজনশীল প্রশ্নে উদ্দীপক পড়ে ক, খ, গ ও ঘ-এর উত্তর ধারাবাহিকভাবে লেখ। গণনায় একক উল্লেখ কর।",
  className: "নবম–দশম শ্রেণি",
  group: "বিজ্ঞান বিভাগ",
  subject: "সাধারণ বিজ্ঞান",
  chapter: "পদার্থবিজ্ঞান · রসায়ন · জীববিজ্ঞান",
  topic: "মডেল প্রশ্নপত্র",
  fontSize: 10,
  margin: 12,
  columnGap: 8,
  lineSpacing: 1.55,
};

const demoQuestions: Question[] = [
  { id: "demo-mcq-01", kind: "MCQ", text: "সমবেগে সরলরেখায় চললে ত্বরণের মান কত?", marks: 2, options: ["শূন্য", "১ m/s²", "বেগের সমান", "সময়ের সমান"], answer: "ক", explanation: "বেগ অপরিবর্তিত থাকলে ত্বরণ শূন্য।" },
  { id: "demo-mcq-02", kind: "MCQ", text: "বেগের SI একক কোনটি?", marks: 2, options: ["m/s", "m/s²", "kg·m", "N/s"], answer: "ক", explanation: "একক সময়ে সরণ, তাই m/s।" },
  { id: "demo-mcq-03", kind: "MCQ", text: "বলের SI একক কোনটি?", marks: 2, options: ["জুল", "নিউটন", "ওয়াট", "পাস্কাল"], answer: "খ", explanation: "বলের SI একক নিউটন (N)।" },
  { id: "demo-mcq-04", kind: "MCQ", text: "কাজের পরিমাণ নির্ণয়ের সঠিক সম্পর্ক কোনটি?", marks: 2, options: ["W = Fs", "P = F/s", "v = at", "F = m/v"], answer: "ক", explanation: "বল ও বলের দিকে সরণের গুণফল কাজ।", equation: "W = Fs" },
  { id: "demo-mcq-05", kind: "MCQ", text: "বৈদ্যুতিক প্রবাহের SI একক কী?", marks: 2, options: ["ভোল্ট", "অ্যাম্পিয়ার", "ওহম", "কুলম্ব"], answer: "খ", explanation: "প্রবাহের SI একক অ্যাম্পিয়ার (A)।" },
  { id: "demo-mcq-06", kind: "MCQ", text: "একটি বর্তনীতে V = 12 V এবং R = 4 Ω হলে I কত?", marks: 2, options: ["২ A", "৩ A", "৪ A", "৪৮ A"], answer: "খ", explanation: "I = V/R = 12/4 = 3 A।", equation: "I = \\frac{V}{R}" },
  { id: "demo-mcq-07", kind: "MCQ", text: "পানির রাসায়নিক সংকেত কোনটি?", marks: 2, options: ["H₂O", "HO₂", "H₂O₂", "OH"], answer: "ক", explanation: "পানির প্রতি অণুতে দুটি H ও একটি O পরমাণু থাকে।" },
  { id: "demo-mcq-08", kind: "MCQ", text: "ক্যালসিয়াম কার্বনেটের সংকেত কোনটি?", marks: 2, options: ["CaCO₃", "CaCl₂", "Na₂CO₃", "CaO₂"], answer: "ক", explanation: "ক্যালসিয়াম কার্বনেটের সংকেত CaCO₃।" },
  { id: "demo-mcq-09", kind: "MCQ", text: "অম্লীয় দ্রবণের pH সাধারণত কেমন?", marks: 2, options: ["৭-এর কম", "৭", "৭-এর বেশি", "১৪-এর বেশি"], answer: "ক", explanation: "২৫°C-এ pH ৭-এর কম হলে দ্রবণ অম্লীয়।" },
  { id: "demo-mcq-10", kind: "MCQ", text: "প্রকাশ-সংশ্লেষণে উদ্ভিদ কোন গ্যাস গ্রহণ করে?", marks: 2, options: ["O₂", "CO₂", "N₂", "H₂"], answer: "খ", explanation: "উদ্ভিদ CO₂ গ্রহণ করে এবং O₂ ছাড়ে।" },
  { id: "demo-mcq-11", kind: "MCQ", text: "কোষের শক্তিঘর বলা হয় কোন অঙ্গাণুকে?", marks: 2, options: ["রাইবোজোম", "মাইটোকন্ড্রিয়া", "গলজি বস্তু", "লাইসোজোম"], answer: "খ", explanation: "মাইটোকন্ড্রিয়ায় কোষীয় শ্বসনে ATP তৈরি হয়।" },
  { id: "demo-mcq-12", kind: "MCQ", text: "উদ্ভিদ কোষে কোষপ্রাচীরের প্রধান উপাদান কী?", marks: 2, options: ["সেলুলোজ", "গ্লাইকোজেন", "কাইটিন", "কেরাটিন"], answer: "ক", explanation: "উদ্ভিদ কোষপ্রাচীর প্রধানত সেলুলোজ দিয়ে গঠিত।" },
  { id: "demo-mcq-13", kind: "MCQ", text: "বংশগতির কার্যকরী একক কোনটি?", marks: 2, options: ["জিন", "টিস্যু", "অঙ্গ", "রাইবোজোম"], answer: "ক", explanation: "জিন বংশগত বৈশিষ্ট্যের কার্যকরী একক।" },
  { id: "demo-mcq-14", kind: "MCQ", text: "মানবদেহে রক্ত পাম্প করে কোন অঙ্গ?", marks: 2, options: ["ফুসফুস", "যকৃৎ", "হৃদপিণ্ড", "বৃক্ক"], answer: "গ", explanation: "হৃদপিণ্ড সংকোচন-প্রসারণে রক্ত সঞ্চালন করে।" },
  { id: "demo-mcq-15", kind: "MCQ", text: "মিথেনের রাসায়নিক সংকেত কোনটি?", marks: 2, options: ["CH₄", "C₂H₆", "CO₂", "NH₃"], answer: "ক", explanation: "মিথেনের অণুতে একটি কার্বন ও চারটি হাইড্রোজেন থাকে।" },
  { id: "demo-cq-01", kind: "CQ", chapter: "গতি", text: "উদ্দীপক: একটি খেলনা গাড়ি স্থির অবস্থা থেকে চলা শুরু করে। প্রতি ২ সেকেন্ডে তার বেগ মাপা হলো।", marks: 10, subs: ["সরণ কাকে বলে?", "গাড়িটির ত্বরণ নির্ণয় কর।", "৪ সেকেন্ডে অতিক্রান্ত সরণ হিসাব কর।", "বেগ-সময় লেখচিত্র এঁকে তার ঢাল ব্যাখ্যা কর।"], subMarks: [1, 2, 3, 4], answer: "ত্বরণ ২ m/s²; ৪ সেকেন্ডে সরণ ১৬ m।", explanation: "s = ut + ½at²; প্রারম্ভিক বেগ u = 0।", equation: "v = u + at", table: { headers: ["সময় (s)", "বেগ (m/s)"], rows: [["0", "0"], ["2", "4"], ["4", "8"]] } },
  { id: "demo-cq-02", kind: "CQ", chapter: "গতি", text: "উদ্দীপক: ৫ kg ভরের একটি বাক্সকে মেঝের ওপর ৩ m সরাতে ২০ N বল প্রয়োগ করা হলো।", marks: 10, subs: ["জড়তা কী?", "বাক্সটির ত্বরণ নির্ণয় কর।", "বলটির দ্বারা সম্পন্ন কাজ হিসাব কর।", "একই বল দ্বিগুণ সরণে প্রয়োগ করলে কাজের পরিবর্তন সমীকরণে দেখাও।"], subMarks: [1, 2, 3, 4], answer: "ত্বরণ ৪ m/s²; কাজ ৬০ J।", explanation: "F = ma এবং W = Fs।", equation: "F = ma, \\quad W = Fs" },
  { id: "demo-cq-03", kind: "CQ", chapter: "বিদ্যুৎ", text: "উদ্দীপক: একটি বৈদ্যুতিক হিটারের রোধ ২৪ Ω। ১২ V উৎসে যুক্ত করলে তারের মধ্য দিয়ে প্রবাহ সৃষ্টি হয়।", marks: 10, subs: ["তড়িৎ প্রবাহ কী?", "হিটারের প্রবাহ নির্ণয় কর।", "৫ মিনিটে ব্যবহৃত বৈদ্যুতিক শক্তি নির্ণয় কর।", "একই ভোল্টেজে রোধ বাড়ালে প্রবাহ কীভাবে বদলায়—সূত্রসহ ব্যাখ্যা কর।"], subMarks: [1, 2, 3, 4], answer: "I = 0.5 A; P = 6 W; ৫ মিনিটে শক্তি ১৮০০ J।", explanation: "P = VI এবং E = Pt।", equation: "V = IR, \\quad E = VIt" },
  { id: "demo-cq-04", kind: "CQ", chapter: "রসায়ন", text: "উদ্দীপক: চুনাপাথরের গুঁড়া CaCO₃-এ লঘু হাইড্রোক্লোরিক অ্যাসিড HCl যোগ করলে বুদ্‌বুদসহ গ্যাস নির্গত হয়।", marks: 10, subs: ["মৌল কাকে বলে?", "উদ্দীপকে উৎপন্ন গ্যাসটি শনাক্ত কর।", "বিক্রিয়াটির সমতাকৃত রাসায়নিক সমীকরণ লেখ।", "উৎপন্ন গ্যাস চুনপানিতে প্রবাহিত করলে কী দেখা যায়—কারণসহ লেখ।"], subMarks: [1, 2, 3, 4], answer: "গ্যাসটি CO₂; চুনপানি দুধের মতো সাদা হয়।", explanation: "CaCO₃ + 2HCl → CaCl₂ + CO₂ + H₂O; CaCO₃-এর অধঃক্ষেপ তৈরি হয়।", equation: "CaCO_3 + 2HCl \\rightarrow CaCl_2 + CO_2 + H_2O" },
  { id: "demo-cq-05", kind: "CQ", chapter: "জীববিজ্ঞান", text: "উদ্দীপক: একটি উদ্ভিদ কোষে সবুজ অঙ্গাণু, বড় রসধানী এবং সুস্পষ্ট কোষপ্রাচীর দেখা গেল।", marks: 10, subs: ["কোষ কী?", "কোষপ্রাচীরের একটি কাজ লেখ।", "উদ্ভিদ কোষের চিত্রে পাঁচটি অংশ চিহ্নিত কর।", "ক্লোরোপ্লাস্ট কীভাবে খাদ্য তৈরিতে সহায়তা করে ব্যাখ্যা কর।"], subMarks: [1, 2, 3, 4], answer: "কোষপ্রাচীর, কোষঝিল্লি, কেন্দ্রক, রসধানী ও ক্লোরোপ্লাস্ট চিহ্নিত।", explanation: "ক্লোরোফিল আলোকশক্তি শোষণ করে প্রকাশ-সংশ্লেষণ ঘটায়।", diagram: "plant-cell" },
  { id: "demo-cq-06", kind: "CQ", chapter: "জীববিজ্ঞান", text: "উদ্দীপক: পাতার ক্লোরোফিল সূর্যালোকের উপস্থিতিতে পানি ও কার্বন ডাই-অক্সাইড থেকে শর্করা তৈরি করে।", marks: 10, subs: ["সালোকসংশ্লেষণ কী?", "পাতাকে খাদ্য তৈরির কারখানা বলা হয় কেন?", "প্রক্রিয়াটির সমতাকৃত রাসায়নিক সমীকরণ লেখ।", "বন উজাড় হলে বায়ুমণ্ডলের গ্যাসীয় ভারসাম্যে কী প্রভাব পড়ে ব্যাখ্যা কর।"], subMarks: [1, 2, 3, 4], answer: "6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂।", explanation: "আলো ও ক্লোরোফিলের সাহায্যে রাসায়নিক শক্তি সঞ্চিত হয়।", equation: "6CO_2 + 6H_2O \\xrightarrow{light} C_6H_{12}O_6 + 6O_2" },
  { id: "demo-cq-07", kind: "CQ", text: "উদ্দীপক: একটি জলাশয়ে সার ধুয়ে পড়ার পর শৈবাল বেড়ে গেল; কিছুদিন পর মাছ ভেসে উঠল।", marks: 10, subs: ["বাস্তুতন্ত্র কী?", "জলাশয়ে শৈবাল বৃদ্ধির একটি কারণ লেখ।", "দ্রবীভূত অক্সিজেন কমে যাওয়ার ধাপ ব্যাখ্যা কর।", "জলাশয় রক্ষায় চারটি বাস্তব পদক্ষেপ প্রস্তাব কর।"], subMarks: [1, 2, 3, 4], answer: "সারের নাইট্রেট শৈবাল বাড়ায়; পচনে অক্সিজেন কমে, মাছ মারা যায়।", explanation: "সার ব্যবহারে নিয়ন্ত্রণ, বর্জ্য শোধন, জলাশয়ের তীর রক্ষা ও নিয়মিত পর্যবেক্ষণ জরুরি।" },
];

function newQuestion(kind: QuestionKind): Question {
  return {
    id: crypto.randomUUID(),
    kind,
    text: "",
    marks: kind === "MCQ" ? 1 : 10,
    options: kind === "MCQ" ? ["", "", "", ""] : undefined,
    subs: kind === "CQ" ? ["", "", "", ""] : undefined,
    answer: "",
    explanation: "",
    equation: "",
  };
}

function getQuestionFragments(question: Question, number: number): QuestionFragment[] {
  const subCount = question.kind === "CQ" ? question.subs?.length ?? 0 : 0;
  if (question.kind !== "CQ" || subCount === 0) {
    return [{
      id: `${question.id}:0:0`,
      question,
      number,
      startSubIndex: 0,
      endSubIndex: 0,
      subquestionIndexes: [],
      showImage: true,
      showDetails: true,
    }];
  }

  return Array.from({ length: subCount }, (_, startSubIndex) =>
    Array.from({ length: subCount - startSubIndex }, (_, offset) => {
      const endSubIndex = startSubIndex + offset + 1;
      return {
        id: `${question.id}:${startSubIndex}:${endSubIndex}`,
        question,
        number,
        startSubIndex,
        endSubIndex,
        subquestionIndexes: Array.from(
          { length: endSubIndex - startSubIndex },
          (_, index) => startSubIndex + index,
        ),
        showImage: startSubIndex === 0,
        showDetails: endSubIndex === subCount,
      };
    }),
  ).flat();
}

function formatQuestionText(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\^\{[^}]+\}|_\{[^}]+\})/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("^{") && part.endsWith("}")) {
      return <sup key={index}>{part.slice(2, -1)}</sup>;
    }
    if (part.startsWith("_{") && part.endsWith("}")) {
      return <sub key={index}>{part.slice(2, -1)}</sub>;
    }
    return <Fragment key={index}>{part.split("\n").map((line, lineIndex) => (
      <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{line}</Fragment>
    ))}</Fragment>;
  });
}

function RichTextEditor({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function wrapSelection(before: string, after: string) {
    const input = inputRef.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = value.slice(start, end) || "লেখা";
    const nextValue = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    onChange(nextValue);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }

  return (
    <div className="rich-editor">
      <div className="rich-editor-tools" aria-label="লেখা বিন্যাস">
        <button type="button" title="গাঢ়" onClick={() => wrapSelection("**", "**")}><strong>B</strong></button>
        <button type="button" title="তির্যক" onClick={() => wrapSelection("*", "*")}><em>I</em></button>
        <button type="button" title="ঊর্ধ্বলিখন" onClick={() => wrapSelection("^{", "}")}>xⁿ</button>
        <button type="button" title="নিম্নলিখন" onClick={() => wrapSelection("_{", "}")}>xₙ</button>
        <span>গণিত: ^&#123;2&#125; · রসায়ন: _&#123;2&#125; · সমীকরণ নিচে MathLive দিয়ে</span>
      </div>
      <textarea
        ref={inputRef}
        aria-label={label}
        placeholder="প্রশ্ন লিখুন"
        maxLength={500}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function PaperQuestion({
  question,
  number,
  showAnswers,
  subquestionIndexes,
  showImage,
  showDetails,
  showPrompt,
  onMathFieldReady,
}: {
  question: Question;
  number: number;
  showAnswers: boolean;
  subquestionIndexes: number[];
  showImage: boolean;
  showDetails: boolean;
  showPrompt: boolean;
  onMathFieldReady: () => void;
}) {
  const letters = ["ক", "খ", "গ", "ঘ"];
  const subMarks = question.subMarks ?? [1, 2, 3, 4];

  return (
    <article className="paper-question">
      <div className="paper-question-header">
        <div className="paper-question-title">
          {showPrompt && question.setNumber !== undefined && (
            <span className="paper-set-label">Set {question.setNumber}</span>
          )}
          <span className="paper-q-number">{number}.</span>
          {showPrompt && <p>{question.text ? formatQuestionText(question.text) : "প্রশ্নের বিবরণ লিখুন"}</p>}
          <span className="paper-marks">[{question.marks}]</span>
        </div>
        {showImage && (question.imageUrls?.length ? question.imageUrls : question.imageUrl ? [question.imageUrl] : []).map((imageUrl, index) => (
          <Image className="paper-diagram" key={`${question.id}-image-${index}`} src={imageUrl} alt={`প্রশ্নের সঙ্গে যুক্ত চিত্র ${index + 1}`} width={600} height={400} unoptimized />
        ))}
      </div>
      {question.kind === "MCQ" && (
        <div className="paper-options">
          {(question.options ?? []).map((option, optionIndex) => (
            <div className="paper-option" key={`${question.id}-option-${optionIndex}`}>
              <span>({letters[optionIndex]})</span>
              <span>{option ? formatQuestionText(option) : "—"}</span>
            </div>
          ))}
        </div>
      )}
      {question.kind === "CQ" && (
        <div className="paper-subquestions">
          {subquestionIndexes.map((subIndex) => (
            <div className="paper-subquestion" key={`${question.id}-sub-${subIndex}`}>
              <span>({letters[subIndex]})</span>
              <span>{question.subs?.[subIndex] ? formatQuestionText(question.subs[subIndex]) : "উপপ্রশ্ন লিখুন"}</span>
              <span className="paper-marks">[{subMarks[subIndex]}]</span>
            </div>
          ))}
        </div>
      )}
      {showDetails && (
        <>
          {question.table && (
            <table className="paper-table">
              <thead><tr>{question.table.headers.map((header, headerIndex) => <th key={`${question.id}-head-${headerIndex}`}>{header}</th>)}</tr></thead>
              <tbody>{question.table.rows.map((row, rowIndex) => <tr key={`${question.id}-row-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${question.id}-${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody>
            </table>
          )}
          {question.diagram === "plant-cell" && <PlantCellDiagram />}
          {question.equation && (
            <div className="paper-equation">
              <MathField value={question.equation} readOnly onReady={onMathFieldReady} />
            </div>
          )}
          {showAnswers && (question.answer || question.explanation) && (
            <div className="paper-answer">
              <strong>উত্তর:</strong> {question.answer} {question.explanation}
            </div>
          )}
        </>
      )}
    </article>
  );
}

function MathField({
  value,
  readOnly = false,
  className,
  ariaLabel,
  onChange,
  onReady,
}: {
  value: string;
  readOnly?: boolean;
  className?: string;
  ariaLabel?: string;
  onChange?: (value: string) => void;
  onReady?: () => void;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const fieldRef = useRef<MathfieldElement | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    onReadyRef.current = onReady;
  }, [onChange, onReady, value]);

  useEffect(() => {
    let cancelled = false;
    let readyFrame: number | undefined;
    let field: MathfieldElement | null = null;
    const handleInput = () => {
      if (field) onChangeRef.current?.(field.value);
    };

    void initializeMathLive().then(() => {
      if (cancelled || !hostRef.current) return;
      field = document.createElement("math-field") as MathfieldElement;
      field.className = className ?? "";
      if (ariaLabel) field.setAttribute("aria-label", ariaLabel);
      field.readOnly = readOnly;
      field.mathVirtualKeyboardPolicy = "manual";
      field.value = valueRef.current;
      if (!readOnly) field.addEventListener("input", handleInput);
      hostRef.current.replaceChildren(field);
      fieldRef.current = field;
      if (readOnly) {
        readyFrame = requestAnimationFrame(() => {
          if (!cancelled && field?.isConnected) onReadyRef.current?.();
        });
      }
    }, (error: unknown) => {
      console.error("Failed to initialize MathLive", error);
    });

    return () => {
      cancelled = true;
      if (readyFrame !== undefined) cancelAnimationFrame(readyFrame);
      if (field) {
        field.removeEventListener("input", handleInput);
        field.remove();
      }
      fieldRef.current = null;
    };
  }, [ariaLabel, className, readOnly]);

  useEffect(() => {
    const field = fieldRef.current;
    if (field && field.value !== value) field.value = value;
  }, [value]);

  return <span className="math-field-host" ref={hostRef} />;
}

function MathEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="math-editor-container">
      <MathField value={value} className="math-editor" ariaLabel="সমীকরণ লিখুন" onChange={onChange} />
    </div>
  );
}

export default function PaperMaker({ initialPanel = "user", initialUser, initialView = "editor" }: {
  initialPanel?: "user" | "admin";
  initialUser: AuthenticatedUser;
  initialView?: "editor" | "question-settings";
}) {
  const router = useRouter();
  const { language } = useLanguage();
  const [secondaryMenuOpen, setSecondaryMenuOpen] = useState(false);
  const [editorToolbarTarget, setEditorToolbarTarget] = useState<HTMLElement | null>(null);
  const [paperSettingsOpen, setPaperSettingsOpen] = useState(false);
  const setEditorToolbarElement = useCallback((element: HTMLDivElement | null) => {
    setEditorToolbarTarget(element);
  }, []);
  const [activeMobilePane, setActiveMobilePane] = useState<"questions" | "preview">("questions");
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPageIndex, setPreviewPageIndex] = useState(0);
  const [activeSection, setActiveSection] = useState<QuestionKind>("MCQ");
  const [sectionSettings, setSectionSettings] = useState<Record<QuestionKind, PaperSettings>>({
    MCQ: { ...initialSettings },
    CQ: { ...initialSettings },
  });
  const [loadedSettingsUserId, setLoadedSettingsUserId] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const settingsSaveInFlightRef = useRef(false);
  const settings = sectionSettings[activeSection];
  const [questions, setQuestions] = useState(initialQuestions);
  const [adminQuestions, setAdminQuestions] = useState<Question[]>([]);
  const [pages, setPages] = useState<PaperPage[]>([]);
  const [printCqPages, setPrintCqPages] = useState<PaperPage[]>([]);
  const [printCqOnePagePages, setPrintCqOnePagePages] = useState<PaperPage[]>([]);
  const [cqLayoutFits, setCqLayoutFits] = useState(true);
  const [cqPageLayout, setCqPageLayout] = useState<"one" | "two">("two");
  const [sectionShowAnswers, setSectionShowAnswers] = useState<Record<QuestionKind, boolean>>({ MCQ: false, CQ: false });
  const showAnswers = sectionShowAnswers[activeSection];
  function setShowAnswers(value: boolean) {
    setSectionShowAnswers((current) => ({ ...current, [activeSection]: value }));
  }
  const [isDemo, setIsDemo] = useState(false);
  const [user, setUser] = useState<AuthenticatedUser | null>(initialUser);
  const isLoadingSavedSettings = Boolean(user && loadedSettingsUserId !== user.id);
  const [paperIds, setPaperIds] = useState<Record<QuestionKind, string | null>>({ MCQ: null, CQ: null });
  const paperId = paperIds[activeSection];
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<"user" | "admin">(initialPanel);
  const isAdminPanel = user?.role === "ADMIN" && panel === "admin";
  const [userPanelView, setUserPanelView] = useState<UserPanelView>(initialPanel === "admin" ? "create" : "home");
  function navigateUserPanel(view: UserPanelView) {
    setUserPanelView(view);
    setPaperSettingsOpen(false);
  }
  const [savedPapers, setSavedPapers] = useState<SavedPaperSummary[] | null>(null);
  const [savedPapersError, setSavedPapersError] = useState("");
  const [savedPapersRefresh, setSavedPapersRefresh] = useState(0);
  const [subscription, setSubscription] = useState<{
    status?: string;
    plan?: { name?: string; code?: string };
  } | null>();
  const [subscriptionError, setSubscriptionError] = useState("");
  const [classFilter, setClassFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [chapterFilter, setChapterFilter] = useState("");
  const [topicFilter, setTopicFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<QuestionKind | "">("");
  const [adminOffset, setAdminOffset] = useState(0);
  const [adminQuestionTotal, setAdminQuestionTotal] = useState(0);
  const [savingAdminQuestionIds, setSavingAdminQuestionIds] = useState<string[]>([]);
  const savingAdminQuestionIdsRef = useRef(new Set<string>());
  const [bankQuestions, setBankQuestions] = useState<Question[]>([]);
  const [bankRefresh, setBankRefresh] = useState(0);
  const [catalog, setCatalog] = useState<QuestionCatalog>({
    classes: [],
    groups: [],
    subjects: [],
    chapters: [],
    topics: [],
  });
  const [questionUploadType, setQuestionUploadType] = useState<QuestionKind>("MCQ");
  const [adminDashboard, setAdminDashboard] = useState<AdminDashboard | null>(null);
  const [adminDashboardError, setAdminDashboardError] = useState("");
  const [dashboardRefresh, setDashboardRefresh] = useState(0);
  const [dashboardQuestionType, setDashboardQuestionType] = useState<QuestionKind>("MCQ");
  const [academicRefresh, setAcademicRefresh] = useState(0);
  const [academicDataError, setAcademicDataError] = useState("");
  const [adminQuestionError, setAdminQuestionError] = useState("");
  const [isLoadingAdminDashboard, setIsLoadingAdminDashboard] = useState(false);
  const [isLoadingAdminQuestions, setIsLoadingAdminQuestions] = useState(false);
  const [academicEntries, setAcademicEntries] = useState<{ id: string; type: string; name: string; parentId: string | null }[]>([]);
  const [academicType, setAcademicType] = useState("CLASS");
  const [academicName, setAcademicName] = useState("");
  const [academicParentId, setAcademicParentId] = useState("");
  const [selectedAdminQuestionIds, setSelectedAdminQuestionIds] = useState<string[]>([]);
  const [isDeletingAdminQuestions, setIsDeletingAdminQuestions] = useState(false);
  const [generationCatalog, setGenerationCatalog] = useState<QuestionCatalog>({
    classes: [],
    groups: [],
    subjects: [],
    chapters: [],
    topics: [],
  });
  const [generationSubjects, setGenerationSubjects] = useState<string[]>([]);
  const [generationChapters, setGenerationChapters] = useState<string[]>([]);
  const [generationStep, setGenerationStep] = useState(0);
  const [isLoadingGenerationClasses, setIsLoadingGenerationClasses] = useState(true);
  const [isLoadingGenerationSubjects, setIsLoadingGenerationSubjects] = useState(false);
  const [isLoadingGenerationChapters, setIsLoadingGenerationChapters] = useState(false);
  const [generationCatalogError, setGenerationCatalogError] = useState("");
  const generationSteps = ["শ্রেণি নির্বাচন", "বিষয় নির্বাচন", "প্রশ্ন কনফিগার ও তৈরি"];
  const [generationClass, setGenerationClass] = useState("");
  const [generationSubject, setGenerationSubject] = useState("");
  const [creationMethod, setCreationMethod] = useState<QuestionCreationMethod>("quick");
  const [generationModes, setGenerationModes] = useState<Record<QuestionKind, "auto" | "manual">>({
    MCQ: "auto",
    CQ: "auto",
  });
  const generationMode = generationModes[activeSection];
  const [generationQuestionCount, setGenerationQuestionCount] = useState(10);
  const [blueprintCatalog, setBlueprintCatalog] = useState<QuestionCatalog>({
    classes: [],
    groups: [],
    subjects: [],
    chapters: [],
    topics: [],
  });
  const [blueprintChapter, setBlueprintChapter] = useState("");
  const [blueprintTopic, setBlueprintTopic] = useState("");
  const [blueprintMarks, setBlueprintMarks] = useState(1);
  const [blueprintDifficultyCounts, setBlueprintDifficultyCounts] = useState<Record<QuestionDifficulty, number>>({
    easy: 1,
    medium: 0,
    hard: 0,
  });
  const [isLoadingBlueprintCatalog, setIsLoadingBlueprintCatalog] = useState(false);
  const [blueprintCatalogError, setBlueprintCatalogError] = useState("");
  const [previousPapers, setPreviousPapers] = useState<SavedPaperSummary[] | null>(null);
  const [previousPaperError, setPreviousPaperError] = useState("");
  const [previousPaperId, setPreviousPaperId] = useState("");
  const [previousPaperQuestions, setPreviousPaperQuestions] = useState<Question[]>([]);
  const [isLoadingPreviousPaper, setIsLoadingPreviousPaper] = useState(false);
  const [manualDraft, setManualDraft] = useState<Question>(() => newQuestion("MCQ"));
  const [manualImage, setManualImage] = useState<File | null>(null);
  const [isSavingManualQuestion, setIsSavingManualQuestion] = useState(false);
  const [manualQuestionError, setManualQuestionError] = useState("");
  const [generationCqSetCount, setGenerationCqSetCount] = useState<0 | 2 | 3 | 4>(0);
  const [generationCqSets, setGenerationCqSets] = useState<CqGenerationSet[]>(restoreCqGenerationSets());
  const [generationCandidates, setGenerationCandidates] = useState<Question[]>([]);
  const [generationSelectedIds, setGenerationSelectedIds] = useState<string[]>([]);
  const [generationPreview, setGenerationPreview] = useState<{
    totalMarks: number;
    estimatedTokens: number;
    balance: number;
    questionIds: string[];
    setAssignments?: { questionId: string; setNumber: number }[];
  } | null>(null);
  const [generationError, setGenerationError] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const generationKeyRef = useRef("");
  const manualQuestionRequestRef = useRef<{ key: string; body: string } | null>(null);
  const manualImageUploadRef = useRef<{ file: File; url: string } | null>(null);
  const [tokenBalance, setTokenBalance] = useState(0);
  const [tokenRates, setTokenRates] = useState({ MCQ: 1, CQ: 10, SHORT: 5 });
  const [tokenTransactions, setTokenTransactions] = useState<{ type: string; amount: number; createdAt: string; paper?: { title: string } | null }[]>([]);
  const [grantEmail, setGrantEmail] = useState("");
  const [grantAmount, setGrantAmount] = useState(100);
  const [toast, setToast] = useState("");
  const [mathFieldLayoutVersion, setMathFieldLayoutVersion] = useState(0);
  const mathFieldLayoutFrameRef = useRef<number | null>(null);
  const handleReadOnlyMathFieldReady = useCallback(() => {
    if (mathFieldLayoutFrameRef.current !== null) return;
    mathFieldLayoutFrameRef.current = requestAnimationFrame(() => {
      mathFieldLayoutFrameRef.current = null;
      setMathFieldLayoutVersion((version) => version + 1);
    });
  }, []);
  useEffect(() => () => {
    if (mathFieldLayoutFrameRef.current !== null) cancelAnimationFrame(mathFieldLayoutFrameRef.current);
  }, []);
  const measureRef = useRef<HTMLDivElement>(null);
  const paperHeadingRef = useRef<HTMLDivElement>(null);
  const cqOnePageHeadingRef = useRef<HTMLElement>(null);
  const previewPagesRef = useRef<HTMLDivElement>(null);
  const cqQuestionCountRef = useRef(0);
  const cqLayoutFitsRef = useRef(true);
  const cqOnePageLayoutFitsRef = useRef(true);
  const cqLayoutAutoSwitchedRef = useRef(false);
  const pixelsPerMillimeter = 96 / 25.4;
  const [paperHeaderHeight, setPaperHeaderHeight] = useState(39 * pixelsPerMillimeter);
  const [cqOnePageHeaderHeight, setCqOnePageHeaderHeight] = useState(39 * pixelsPerMillimeter);
  const mcqWidth = ((210 - settings.margin * 2 - settings.columnGap) / 2) * pixelsPerMillimeter;
  const cqWidth = ((297 - settings.margin * 2 - settings.columnGap) / 2) * pixelsPerMillimeter;
  const cqFlowHeight = 210 - settings.margin * 2 - 12;
  const cqOnePageFlowHeight = Math.max(0, 210 - settings.margin * 2 - 12 - cqOnePageHeaderHeight / pixelsPerMillimeter);
  const mcqQuestions = useMemo(
    () => questions.filter((question) => question.kind === "MCQ"),
    [questions],
  );
  const cqQuestions = useMemo(
    () => questions.filter((question) => question.kind === "CQ"),
    [questions],
  );
  const cqSetQuestionGroups = useMemo(() => {
    const setNumbers = [...new Set(cqQuestions.flatMap((question) =>
      question.setNumber === undefined ? [] : [question.setNumber],
    ))].sort((a, b) => a - b);
    if (setNumbers.length === 0) return [cqQuestions];
    return [
      ...setNumbers.map((setNumber) => cqQuestions.filter((question) => question.setNumber === setNumber)),
      cqQuestions.filter((question) => question.setNumber === undefined),
    ].filter((group) => group.length > 0);
  }, [cqQuestions]);
  const cqPrintQuestionCount = cqQuestions.length;
  const mcqFlowHeight = 297 - settings.margin * 2 - 12;
  const mcqFragments = useMemo(
    () => mcqQuestions.flatMap((question, index) => getQuestionFragments(question, index + 1)),
    [mcqQuestions],
  );
  const cqFragments = useMemo(
    () => cqQuestions.flatMap((question, index) => getQuestionFragments(question, index + 1)),
    [cqQuestions],
  );
  const questionFragments = useMemo(
    () => [...mcqFragments, ...cqFragments],
    [mcqFragments, cqFragments],
  );

  useEffect(() => {
    if (!user) return;
    let active = true;
    apiFetch("/api/papers/settings", { credentials: "same-origin" })
      .then(async (response) => {
        const data = await readApiJson<{ error?: string; settings?: Partial<Record<QuestionKind, { id: string; settings: SavedPaperSettings } | null>> }>(response);
        if (!response.ok) throw new Error(data.error ?? "পরীক্ষার সেটিংস খোলা যায়নি");
        return data as {
          settings?: Partial<Record<QuestionKind, { id: string; settings: SavedPaperSettings } | null>>;
        };
      })
      .then((data) => {
        if (!active) return;
        const saved = data.settings ?? {};
        setPaperIds({
          MCQ: saved.MCQ?.id ?? null,
          CQ: saved.CQ?.id ?? null,
        });
        setSectionSettings({
          MCQ: { ...initialSettings, ...saved.MCQ?.settings },
          CQ: { ...initialSettings, ...saved.CQ?.settings },
        });
        setSectionShowAnswers({
          MCQ: typeof saved.MCQ?.settings.showAnswers === "boolean" ? saved.MCQ.settings.showAnswers : false,
          CQ: typeof saved.CQ?.settings.showAnswers === "boolean" ? saved.CQ.settings.showAnswers : false,
        });
        setCqPageLayout(saved.CQ?.settings.cqPageLayout === "one" ? "one" : "two");
        setGenerationCqSetCount(
          saved.CQ?.settings.cqSetCount === 2 || saved.CQ?.settings.cqSetCount === 3 || saved.CQ?.settings.cqSetCount === 4
            ? saved.CQ.settings.cqSetCount
            : 0,
        );
        setGenerationCqSets(restoreCqGenerationSets(saved.CQ?.settings.cqSets));
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "পরীক্ষার সেটিংস খোলা যায়নি";
        setSettingsSaveStatus({ type: "error", message });
        notify(message);
      })
      .finally(() => {
        if (active) setLoadedSettingsUserId(user.id);
      });
    return () => { active = false; };
  }, [user]);

  useEffect(() => {
    if (!user || isAdminPanel) {
      if (isAdminPanel) setIsLoadingGenerationClasses(false);
      return;
    }
    let active = true;
    setIsLoadingGenerationClasses(true);
    Promise.all([
      apiFetch("/api/questions/catalog", { credentials: "same-origin" }).then(async (response) => {
        const data = await readApiJson<QuestionCatalog & { error?: string }>(response);
        if (!response.ok) throw new Error(data.error ?? "প্রশ্নের তালিকা খোলা যায়নি");
        return data as QuestionCatalog;
      }),
      apiFetch("/api/tokens", { credentials: "same-origin" }).then(async (response) => {
        const data = await readApiJson<{
          balance: number;
          tokenRates: { MCQ: number; CQ: number; SHORT: number };
          transactions: { type: string; amount: number; createdAt: string; paper?: { title: string } | null }[];
          error?: string;
        }>(response);
        if (!response.ok) throw new Error(data.error ?? "টোকেনের তথ্য খোলা যায়নি");
        return data;
      }),
    ]).then(([options, account]) => {
      if (!active) return;
      setGenerationCatalog(options);
      setTokenBalance(account.balance);
      setTokenRates(account.tokenRates);
      setTokenTransactions(account.transactions);
    }).catch((error: unknown) => {
      if (active) {
        const message = error instanceof Error ? error.message : "অ্যাকাউন্টের তথ্য খোলা যায়নি";
        setGenerationCatalogError(message);
        notify(message);
      }
    }).finally(() => {
      if (active) setIsLoadingGenerationClasses(false);
    });
    return () => { active = false; };
  }, [user, isAdminPanel, bankRefresh]);

  useEffect(() => {
    if (!user || isAdminPanel || !generationClass) return;
    let active = true;
    const params = new URLSearchParams({ classLevel: generationClass });
    apiFetch(`/api/questions/catalog?${params}`, { credentials: "same-origin" })
      .then(async (response) => {
        const data = await readApiJson<QuestionCatalog & { error?: string }>(response);
        if (!response.ok) throw new Error(data.error ?? "বিষয়ের তালিকা খোলা যায়নি");
        return data as QuestionCatalog;
      })
      .then((data) => {
        if (!active) return;
        setGenerationSubjects(data.subjects.filter((subject) => subject.trim().length > 0));
      })
      .catch((error: unknown) => {
        if (active) {
          const message = error instanceof Error ? error.message : "বিষয়ের তালিকা খোলা যায়নি";
          setGenerationCatalogError(message);
          notify(message);
        }
      })
      .finally(() => {
        if (active) setIsLoadingGenerationSubjects(false);
      });
    return () => { active = false; };
  }, [user, isAdminPanel, generationClass, bankRefresh]);

  useEffect(() => {
    if (activeSection !== "CQ" || !generationClass || !generationSubject) {
      setGenerationChapters([]);
      return;
    }
    let active = true;
    setIsLoadingGenerationChapters(true);
    const params = new URLSearchParams({ classLevel: generationClass, subject: generationSubject });
    apiFetch(`/api/questions/catalog?${params}`, { credentials: "same-origin" })
      .then(async (response) => {
        const data = await readApiJson<QuestionCatalog & { error?: string }>(response);
        if (!response.ok) throw new Error(data.error ?? "অধ্যায়ের তালিকা খোলা যায়নি");
        return data as QuestionCatalog;
      })
      .then((data) => {
        if (active) setGenerationChapters(data.chapters.filter((chapter) => chapter.trim().length > 0));
      })
      .catch((error: unknown) => {
        if (active) {
          const message = error instanceof Error ? error.message : "অধ্যায়ের তালিকা খোলা যায়নি";
          setGenerationCatalogError(message);
          notify(message);
        }
      })
      .finally(() => {
        if (active) setIsLoadingGenerationChapters(false);
      });
    return () => { active = false; };
  }, [activeSection, generationClass, generationSubject, bankRefresh]);

  useEffect(() => {
    if (!user || isAdminPanel || creationMethod !== "blueprint" || !generationClass || !generationSubject) return;
    let active = true;
    const params = new URLSearchParams({ classLevel: generationClass, subject: generationSubject });
    if (blueprintChapter) params.set("chapter", blueprintChapter);
    setIsLoadingBlueprintCatalog(true);
    setBlueprintCatalogError("");
    apiFetch(`/api/questions/catalog?${params}`, { credentials: "same-origin" })
      .then(async (response) => {
        const data = await readApiJson<QuestionCatalog & { error?: string }>(response);
        if (!response.ok) throw new Error(data.error ?? "ব্লুপ্রিন্টের অধ্যায় ও টপিক খোলা যায়নি");
        return data as QuestionCatalog;
      })
      .then((data) => {
        if (active) setBlueprintCatalog(data);
      })
      .catch((error: unknown) => {
        if (active) setBlueprintCatalogError(error instanceof Error ? error.message : "ব্লুপ্রিন্টের তথ্য খোলা যায়নি");
      })
      .finally(() => {
        if (active) setIsLoadingBlueprintCatalog(false);
      });
    return () => { active = false; };
  }, [user, isAdminPanel, creationMethod, generationClass, generationSubject, blueprintChapter, bankRefresh]);

  useEffect(() => {
    if (!user || isAdminPanel || creationMethod !== "previous") return;
    let active = true;
    setPreviousPapers(null);
    setPreviousPaperError("");
    apiFetch("/api/papers", { credentials: "same-origin" })
      .then(async (response) => {
        const data = await readApiJson<{ error?: string; papers?: SavedPaperSummary[] }>(response);
        if (!response.ok) throw new Error(data.error ?? "পূর্বের প্রশ্নপত্র খোলা যায়নি");
        return data.papers ?? [];
      })
      .then((papers) => {
        if (active) setPreviousPapers(papers);
      })
      .catch((error: unknown) => {
        if (active) setPreviousPaperError(error instanceof Error ? error.message : "পূর্বের প্রশ্নপত্র খোলা যায়নি");
      });
    return () => { active = false; };
  }, [user, isAdminPanel, creationMethod, savedPapersRefresh]);

  useEffect(() => {
    if (!secondaryMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSecondaryMenuOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [secondaryMenuOpen]);

  const editedQuestions = isAdminPanel ? adminQuestions : questions;
  const setEditedQuestions = isAdminPanel ? setAdminQuestions : setQuestions;

  useEffect(() => {
    if (!user || isAdminPanel || (userPanelView !== "home" && userPanelView !== "papers")) return;
    let active = true;
    apiFetch("/api/papers", { credentials: "same-origin" })
      .then(async (response) => {
        const data = await readApiJson<{ error?: string; papers?: SavedPaperSummary[] }>(response);
        if (!response.ok) throw new Error(data.error ?? "সংরক্ষিত প্রশ্নপত্র খোলা যায়নি");
        if (active) {
          setSavedPapers(data.papers ?? []);
          setSavedPapersError("");
        }
      })
      .catch((error: unknown) => {
        if (active) setSavedPapersError(error instanceof Error ? error.message : "সংরক্ষিত প্রশ্নপত্র খোলা যায়নি");
      });
    return () => { active = false; };
  }, [user, isAdminPanel, userPanelView, savedPapersRefresh]);

  useEffect(() => {
    if (!user || isAdminPanel || userPanelView !== "subscription") return;
    let active = true;
    apiFetch("/api/plans/subscription", { credentials: "same-origin" })
      .then(async (response) => {
        const data = await readApiJson<{
          error?: string;
          subscription?: { status?: string; plan?: { name?: string; code?: string } } | null;
        }>(response);
        if (!response.ok) throw new Error(data.error ?? "সাবস্ক্রিপশনের তথ্য খোলা যায়নি");
        if (active) {
          setSubscription(data.subscription ?? null);
          setSubscriptionError("");
        }
      })
      .catch((error: unknown) => {
        if (active) setSubscriptionError(error instanceof Error ? error.message : "সাবস্ক্রিপশনের তথ্য খোলা যায়নি");
      });
    return () => { active = false; };
  }, [user, isAdminPanel, userPanelView]);

  useEffect(() => {
    if (!isAdminPanel) return;
    let active = true;
    setAdminDashboardError("");
    setIsLoadingAdminDashboard(true);

    async function loadDashboard() {
      try {
        const response = await apiFetch("/api/admin/questions/dashboard", { credentials: "same-origin" });
        const data = await readApiJson<NonNullable<typeof adminDashboard> & { error?: string }>(response);
        if (!response.ok) throw new Error(data.error ?? "অ্যাডমিন ড্যাশবোর্ড খোলা যায়নি");
        if (active) setAdminDashboard(data);
      } catch (error) {
        if (active) setAdminDashboardError(error instanceof Error ? error.message : "অ্যাডমিন ড্যাশবোর্ড খোলা যায়নি");
      } finally {
        if (active) setIsLoadingAdminDashboard(false);
      }
    }

    void loadDashboard();
    return () => { active = false; };
  }, [isAdminPanel, dashboardRefresh]);

  useEffect(() => {
    if (!isAdminPanel) return;
    let active = true;
    setAcademicDataError("");

    async function loadAcademicEntries() {
      try {
        const response = await apiFetch("/api/admin/questions/academic", { credentials: "same-origin" });
        const data = await readApiJson<{ error?: string; entries: typeof academicEntries }>(response);
        if (!response.ok) throw new Error(data.error ?? "একাডেমিক তথ্য খোলা যায়নি");
        if (active) setAcademicEntries(data.entries);
      } catch (error) {
        if (active) setAcademicDataError(error instanceof Error ? error.message : "একাডেমিক তথ্য খোলা যায়নি");
      }
    }

    void loadAcademicEntries();
    return () => { active = false; };
  }, [isAdminPanel, academicRefresh]);

  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams();
    if (classFilter) params.set("classLevel", classFilter);
    if (groupFilter) params.set("group", groupFilter);
    if (subjectFilter) params.set("subject", subjectFilter);
    if (chapterFilter) params.set("chapter", chapterFilter);
    const suffix = params.size ? `?${params}` : "";
    apiFetch(`${isAdminPanel ? "/api/admin/questions" : "/api/questions"}/catalog${suffix}`, { credentials: "same-origin" })
      .then(async (response) => {
        const data = await readApiJson<QuestionCatalog & { error?: string }>(response);
        if (!response.ok) throw new Error(data.error ?? "প্রশ্নের তালিকা খোলা যায়নি");
        setCatalog(data);
      })
      .catch((error: unknown) => {
        notify(error instanceof Error ? error.message : "প্রশ্নের তালিকা খোলা যায়নি");
      });
  }, [user, isAdminPanel, classFilter, groupFilter, subjectFilter, chapterFilter, bankRefresh]);

  useEffect(() => {
    if (!user) return;
    if (isAdminPanel) {
      setAdminQuestionError("");
      setIsLoadingAdminQuestions(true);
    }
    const params = new URLSearchParams({ limit: isAdminPanel ? "100" : "500" });
    if (isAdminPanel) {
      params.set("offset", String(adminOffset));
      if (search.trim()) params.set("search", search.trim());
      if (typeFilter) params.set("type", typeFilter);
    }
    if (classFilter) params.set("classLevel", classFilter);
    if (groupFilter) params.set("group", groupFilter);
    if (subjectFilter) params.set("subject", subjectFilter);
    if (chapterFilter) params.set("chapter", chapterFilter);
    if (topicFilter) params.set("topic", topicFilter);
    apiFetch(`${isAdminPanel ? "/api/admin/questions" : "/api/questions"}?${params}`, { credentials: "same-origin" })
      .then(async (response) => {
        const data = await readApiJson<{ error?: string; total: number; questions: {
          id: string; type: string; marks: number; classLevel: string; group: string;
          subject: string; chapter: string; topic: string; content: Partial<Question>;
        }[] }>(response);
        if (!response.ok) throw new Error(data.error ?? "প্রশ্নের তালিকা খোলা যায়নি");
        if (isAdminPanel) setAdminQuestionTotal(data.total);
        const mapped = (data.questions as {
          id: string;
          type: string;
          marks: number;
          classLevel: string;
          group: string;
          subject: string;
          chapter: string;
          topic: string;
          content: Partial<Question>;
        }[]).map((item) => ({
          ...item.content,
          id: item.id,
          serverId: item.id,
          kind: item.type === "MCQ" ? "MCQ" as const : "CQ" as const,
          text: item.content.text ?? "",
          marks: item.marks,
          classLevel: item.classLevel,
          group: item.group,
          subject: item.subject,
          chapter: item.chapter,
          topic: item.topic,
        }));
        setBankQuestions(mapped);
        if (user?.role === "ADMIN" && panel === "admin") {
          setAdminQuestions((current) => {
            const existingByServerId = new Map(
              current.filter((item) => item.serverId).map((item) => [item.serverId!, item]),
            );
            const drafts = current.filter((item) =>
              !item.serverId &&
              (!classFilter || item.classLevel === classFilter) &&
              (!groupFilter || item.group === groupFilter) &&
              (!subjectFilter || item.subject === subjectFilter) &&
              (!chapterFilter || item.chapter === chapterFilter) &&
              (!topicFilter || item.topic === topicFilter),
            );
            return [
              ...mapped.map((item) => existingByServerId.get(item.serverId!) ?? item),
              ...drafts,
            ];
          });
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "প্রশ্নের তালিকা খোলা যায়নি";
        if (isAdminPanel) setAdminQuestionError(message);
        else notify(message);
      })
      .finally(() => {
        if (isAdminPanel) setIsLoadingAdminQuestions(false);
      });
  }, [user, panel, isAdminPanel, classFilter, groupFilter, subjectFilter, chapterFilter, topicFilter, search, typeFilter, adminOffset, bankRefresh]);

  useLayoutEffect(() => {
    const measured = measureRef.current?.querySelectorAll<HTMLElement>("[data-measure-id]");
    if (!measured) return;

    const questionHeights = new Map<string, number>();
    measured.forEach((element) => {
      const questionElement = element.querySelector<HTMLElement>(".paper-question");
      if (!questionElement) return;
      const styles = window.getComputedStyle(questionElement);
      questionHeights.set(
        element.dataset.measureId ?? "",
        questionElement.getBoundingClientRect().height + Number.parseFloat(styles.marginBottom),
      );
    });

    const paginateMcq = (): PaperPage[] => {
      if (mcqQuestions.length === 0) return [];
      const capacity = mcqFlowHeight * pixelsPerMillimeter;
      const perPageColumns: QuestionFragment[][][] = [];
      let pageIndex = 0;
      let columnIndex = 0;
      let usedHeight = 0;

      mcqQuestions.forEach((question, index) => {
        const fragment = mcqFragments.find((item) => item.question.id === question.id);
        if (!fragment) return;
        const height = questionHeights.get(fragment.id) ?? 58;
        const pageCapacity = capacity - (pageIndex === 0 && columnIndex === 0 ? paperHeaderHeight : 0);

        if (usedHeight > 0 && usedHeight + height > pageCapacity) {
          if (columnIndex === 0) {
            columnIndex = 1;
          } else {
            pageIndex += 1;
            columnIndex = 0;
          }
          usedHeight = 0;
        }
        while (perPageColumns.length <= pageIndex) perPageColumns.push([[], []]);
        perPageColumns[pageIndex][columnIndex].push(fragment);
        usedHeight += height;

        if (question.breakAfter && index < mcqQuestions.length - 1) {
          pageIndex += 1;
          columnIndex = 0;
          usedHeight = 0;
        }
      });

      return perPageColumns.map((columns) => ({
        kind: "MCQ" as const,
        columns,
      }));
    };

    const paginateCq = (): { pages: PaperPage[]; fits: boolean } => {
      if (cqPrintQuestionCount === 0) return { pages: [], fits: true };

      const pages: PaperPage[] = [
        { kind: "CQ", columns: [[], []] },
        { kind: "CQ", columns: [[], []] },
      ];
      const capacity = cqFlowHeight * pixelsPerMillimeter;
      const sectionHeights = [0, 0, 0, 0];
      const questionsToPlace = cqSetQuestionGroups.flat();
      let sectionIndex = 0;
      let fits = true;

      for (const [questionIndex, question] of questionsToPlace.entries()) {
        const subCount = question.subs?.length ?? 0;
        const questionFragments = cqFragments.filter((item) => item.question.id === question.id);
        let startSubIndex = 0;
        let questionPlaced = false;

        while (subCount > 0 ? startSubIndex < subCount : !questionPlaced) {
          const currentFragments = subCount > 0
            ? questionFragments.filter((item) =>
              item.startSubIndex === startSubIndex && item.endSubIndex > startSubIndex,
            )
            : questionFragments;
          if (currentFragments.length === 0) {
            fits = false;
            break;
          }

          let selectedFragment: QuestionFragment | undefined;
          let selectedHeight = 0;
          while (sectionIndex < cqPagePlacement.length) {
            const placement = cqPagePlacement[sectionIndex];
            const page = pages[placement.pageOffset];
            const headingSpace = sectionIndex === 0 ? paperHeaderHeight : 0;
            const sectionCapacity = capacity - headingSpace;
            const remaining = sectionCapacity - sectionHeights[sectionIndex];

            const fitting = currentFragments
              .map((fragment) => ({
                fragment,
                height: questionHeights.get(fragment.id) ?? 58,
              }))
              .filter((item) => item.height <= remaining)
              .sort((a, b) => b.fragment.endSubIndex - a.fragment.endSubIndex);

            if (fitting.length > 0) {
              selectedFragment = fitting[0].fragment;
              selectedHeight = fitting[0].height;
              page.columns[placement.columnIndex].push({
                ...selectedFragment,
                number: questionIndex + 1,
              });
              sectionHeights[sectionIndex] += selectedHeight;
              questionPlaced = true;
              if (subCount > 0) startSubIndex = selectedFragment.endSubIndex;
              break;
            }

            sectionIndex += 1;
          }

          if (!selectedFragment) {
            fits = false;
            break;
          }
        }

        if (!fits) break;
      }

      return { pages, fits };
    };

    const paginateCqOnePage = (): { pages: PaperPage[]; fits: boolean } => {
      if (cqPrintQuestionCount === 0) return { pages: [], fits: true };

      const page: PaperPage = { kind: "CQ", columns: [[], []] };
      const capacity = cqOnePageFlowHeight * pixelsPerMillimeter;
      const sectionHeights = [0, 0];
      const questionsToPlace = cqSetQuestionGroups.flat();
      let columnIndex = 0;
      let fits = true;

      for (const [questionIndex, question] of questionsToPlace.entries()) {
        const subCount = question.subs?.length ?? 0;
        const questionFragments = cqFragments.filter((item) => item.question.id === question.id);
        let startSubIndex = 0;
        let questionPlaced = false;

        while (subCount > 0 ? startSubIndex < subCount : !questionPlaced) {
          const currentFragments = subCount > 0
            ? questionFragments.filter((item) =>
              item.startSubIndex === startSubIndex && item.endSubIndex > startSubIndex,
            )
            : questionFragments;
          let selectedFragment: QuestionFragment | undefined;
          let selectedHeight = 0;

          while (columnIndex < page.columns.length) {
            const remaining = capacity - sectionHeights[columnIndex];
            const fitting = currentFragments
              .map((fragment) => ({
                fragment,
                height: questionHeights.get(fragment.id) ?? 58,
              }))
              .filter((item) => item.height <= remaining)
              .sort((a, b) => b.fragment.endSubIndex - a.fragment.endSubIndex);

            if (fitting.length > 0) {
              selectedFragment = fitting[0].fragment;
              selectedHeight = fitting[0].height;
              break;
            }
            columnIndex += 1;
          }

          if (!selectedFragment) {
            fits = false;
            break;
          }

          page.columns[columnIndex].push({
            ...selectedFragment,
            number: questionIndex + 1,
          });
          sectionHeights[columnIndex] += selectedHeight;
          questionPlaced = true;
          if (subCount > 0) startSubIndex = selectedFragment.endSubIndex;
        }

        if (!fits) break;
      }

      return { pages: [page], fits };
    };

    const cqPagination = paginateCq();
    const cqOnePagePagination = paginateCqOnePage();
    cqOnePageLayoutFitsRef.current = cqOnePagePagination.fits;
    const selectedCqPages = cqPageLayout === "one" ? cqOnePagePagination.pages : cqPagination.pages;
    const selectedCqFits = cqPageLayout === "one" ? cqOnePagePagination.fits : cqPagination.fits;
    const nextPages = [...paginateMcq(), ...selectedCqPages];
    setPages(nextPages.length
      ? nextPages
      : [{ kind: "MCQ", columns: [[]] }]);
    setPrintCqPages(cqPagination.pages);
    setPrintCqOnePagePages(cqOnePagePagination.pages);
    setCqLayoutFits(selectedCqFits);
    if (cqPageLayout === "two" && cqOnePagePagination.fits && cqQuestionCountRef.current > 0) {
      cqLayoutAutoSwitchedRef.current = true;
      setCqPageLayout("one");
      setPreviewPageIndex(0);
    } else if (cqPageLayout === "one" && !cqOnePagePagination.fits && cqLayoutAutoSwitchedRef.current) {
      cqLayoutAutoSwitchedRef.current = false;
      setCqPageLayout("two");
      setPreviewPageIndex(0);
    } else if (cqPageLayout === "one" && cqOnePagePagination.fits) {
      cqLayoutAutoSwitchedRef.current = true;
    }
  }, [questions, showAnswers, settings.fontSize, settings.lineSpacing, settings.margin, settings.columnGap, paperHeaderHeight, mcqFlowHeight, cqFlowHeight, cqOnePageFlowHeight, cqPageLayout, pixelsPerMillimeter, mcqFragments, cqFragments, mcqQuestions, cqSetQuestionGroups, mathFieldLayoutVersion]);

  const sectionPages = pages.filter((page) =>
    page.kind === activeSection &&
    (activeSection === "CQ" || page.columns.some((column) => column.length > 0)),
  );
  const currentPreviewPageIndex = Math.min(previewPageIndex, Math.max(0, sectionPages.length - 1));
  cqQuestionCountRef.current = cqQuestions.length;
  cqLayoutFitsRef.current = cqLayoutFits;

  useLayoutEffect(() => {
    const measuredHeight = paperHeadingRef.current?.offsetHeight;
    if (measuredHeight && Math.abs(measuredHeight - paperHeaderHeight) > 1) {
      setPaperHeaderHeight(measuredHeight);
    }
    const onePageMeasuredHeight = cqOnePageHeadingRef.current?.offsetHeight;
    if (onePageMeasuredHeight && Math.abs(onePageMeasuredHeight - cqOnePageHeaderHeight) > 1) {
      setCqOnePageHeaderHeight(onePageMeasuredHeight);
    }
  }, [pages, paperHeaderHeight, cqOnePageHeaderHeight, settings.duration, settings.exam, settings.institution, settings.instructions, settings.marks, settings.className, settings.subject, settings.margin, settings.fontSize, settings.lineSpacing]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  function resetGenerationSelection() {
    setGenerationPreview(null);
    setGenerationCandidates([]);
    setGenerationSelectedIds([]);
    setGenerationError("");
    generationKeyRef.current = crypto.randomUUID();
  }

  async function requestGenerationPreview(selectedIds = generationSelectedIds) {
    if (!user) {
      router.push("/login");
      return;
    }
    if (!generationClass.trim() || !generationSubject.trim() ||
      (creationMethod !== "previous" && !generationSubjects.includes(generationSubject))) {
      setGenerationError("শ্রেণি এবং বিষয় নির্বাচন করুন।");
      return;
    }
    const blueprintQuestionCount = Object.values(blueprintDifficultyCounts)
      .reduce((total, count) => total + count, 0);
    if (creationMethod === "blueprint" && (
      !blueprintChapter || !blueprintCatalog.chapters.includes(blueprintChapter) ||
      !Number.isInteger(blueprintMarks) || blueprintMarks < 1 || blueprintMarks > 1000 ||
      blueprintQuestionCount < 1 || blueprintQuestionCount > (activeSection === "CQ" ? 12 : 500) ||
      Object.values(blueprintDifficultyCounts).some((count) => !Number.isInteger(count) || count < 0)
    )) {
      setGenerationError("ব্লুপ্রিন্টে অধ্যায়, প্রশ্নের নম্বর এবং Easy/Medium/Hard-এর বৈধ সংখ্যা নির্বাচন করুন।");
      return;
    }
    const configuredCqSets = generationCqSets.slice(0, generationCqSetCount).map((set, index) => ({
      setNumber: index + 1,
      chapters: set.chapters,
      questionCount: set.questionCount,
    }));
    const cqSetQuestionCount = configuredCqSets.reduce((total, set) => total + set.questionCount, 0);
    if (creationMethod === "quick" && activeSection === "CQ" && generationMode === "auto" && generationCqSetCount > 0) {
      if (configuredCqSets.some((set) =>
        set.chapters.length === 0 || !Number.isInteger(set.questionCount) || set.questionCount < 1,
      )) {
        setGenerationError("প্রতিটি CQ সেটের জন্য অন্তত একটি অধ্যায় এবং প্রশ্নসংখ্যা নির্বাচন করুন।");
        return;
      }
      if (cqSetQuestionCount > 12) {
        setGenerationError("সব CQ সেট মিলিয়ে সর্বোচ্চ ১২টি প্রশ্ন নির্বাচন করা যাবে।");
        return;
      }
      if (configuredCqSets.some((set) => set.chapters.some((chapter) => !generationChapters.includes(chapter)))) {
        setGenerationError("নির্বাচিত শ্রেণি ও বিষয়ের অধ্যায় থেকে নির্বাচন করুন।");
        return;
      }
    }
    if (generationMode === "auto" &&
      !(creationMethod === "quick" && activeSection === "CQ" && generationCqSetCount > 0) &&
      (creationMethod === "blueprint"
        ? blueprintQuestionCount < 1 || blueprintQuestionCount > (activeSection === "CQ" ? 12 : 500)
        : !Number.isInteger(generationQuestionCount) || generationQuestionCount < 1 ||
          generationQuestionCount > (activeSection === "CQ" ? 12 : 500))) {
      setGenerationError(activeSection === "CQ"
        ? "CQ পেপারে ১ থেকে ১২টি প্রশ্ন নির্বাচন করুন।"
        : "১ থেকে ৫০০টি প্রশ্ন নির্বাচন করুন।");
      return;
    }
    if (selectedIds.length > 0 &&
      !selectedQuestionsMatchSelection(generationCandidates, selectedIds, generationClass, generationSubject)) {
      setGenerationError("একটি প্রশ্নপত্রে শুধু নির্বাচিত একই শ্রেণি ও বিষয়ের প্রশ্ন রাখা যাবে।");
      return;
    }
    if (generationMode === "manual" && selectedIds.length > 500) {
      setGenerationError("একটি পেপারে সর্বোচ্চ ৫০০টি প্রশ্ন নির্বাচন করা যাবে।");
      return;
    }
    if (generationMode === "manual" && activeSection === "CQ" && selectedIds.length > 12) {
      setGenerationError("একটি CQ পেপারে সর্বোচ্চ ১২টি প্রশ্ন নির্বাচন করা যাবে।");
      return;
    }
    const body = {
      title: settings.exam || "নতুন প্রশ্নপত্র",
      settings: {
        ...settings,
        ...(activeSection === "CQ" ? { cqPageLayout } : {}),
      },
      classLevel: generationClass,
      subject: generationSubject,
      chapters: creationMethod === "blueprint" ? [blueprintChapter] : [],
      topics: creationMethod === "blueprint" && blueprintTopic ? [blueprintTopic] : [],
      type: activeSection,
      mode: generationMode,
      ...(creationMethod === "blueprint" ? {
        blueprint: { marks: blueprintMarks, difficultyCounts: blueprintDifficultyCounts },
      } : {}),
      ...(generationMode === "auto"
        ? creationMethod === "quick" && activeSection === "CQ" && generationCqSetCount > 0
          ? {
            questionCount: cqSetQuestionCount,
            cqSetCount: generationCqSetCount,
            cqSets: configuredCqSets,
          }
          : { questionCount: creationMethod === "blueprint" ? blueprintQuestionCount : generationQuestionCount }
        : { questionIds: selectedIds }),
      idempotencyKey: generationKeyRef.current || crypto.randomUUID(),
    };
    setGenerationError("");
    try {
      const response = await apiFetch("/api/papers/preview", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readApiJson<{
        error?: string;
        availableCount?: number;
        candidates?: GeneratedQuestionRow[];
        questions: GeneratedQuestionRow[];
        totalMarks: number;
        estimatedTokens: number;
        balance: number;
        setNumber?: number;
        requestedCount?: number;
        setAssignments?: { questionId: string; setNumber: number }[];
      }>(response);
      if (!response.ok) {
        const formatCount = (value: number) => new Intl.NumberFormat(language === "bn" ? "bn-BD" : "en-US").format(value);
        const errorMessage = typeof data.setNumber === "number" &&
          typeof data.availableCount === "number" &&
          typeof data.requestedCount === "number"
          ? `Set ${data.setNumber}: ${formatCount(data.availableCount)}টি প্রশ্ন পাওয়া গেছে; ${formatCount(data.requestedCount)}টি প্রয়োজন।`
          : typeof data.availableCount === "number"
          ? `এই নির্বাচনে ${formatCount(data.availableCount)}টি যোগ্য প্রশ্ন আছে; ${formatCount(generationMode === "auto" ? generationQuestionCount : selectedIds.length)}টি চাওয়া হয়েছে।`
          : data.error ?? "প্রিভিউ তৈরি করা যায়নি";
        throw new Error(errorMessage);
      }
      const candidates = (data.candidates ?? data.questions) as GeneratedQuestionRow[];
      const questions = data.questions as GeneratedQuestionRow[];
      if (![...candidates, ...questions].every((question) =>
        question.classLevel === generationClass && question.subject === generationSubject)) {
        throw new Error("সার্ভার নির্বাচিত শ্রেণি বা বিষয়ের বাইরের প্রশ্ন ফেরত দিয়েছে।");
      }
      setGenerationCandidates(candidates.map(mapGeneratedQuestion));
      const questionIds = questions.map((question) => question.id);
      setGenerationSelectedIds(questionIds);
      if (generationMode === "manual" && questionIds.length === 0) {
        setGenerationPreview(null);
      } else {
        setGenerationPreview({
          totalMarks: data.totalMarks,
          estimatedTokens: data.estimatedTokens,
          balance: data.balance,
          questionIds,
          ...(data.setAssignments ? { setAssignments: data.setAssignments } : {}),
        });
      }
    } catch (error) {
      setGenerationPreview(null);
      setGenerationError(error instanceof Error ? error.message : "প্রিভিউ তৈরি করা যায়নি");
    }
  }

  async function generatePaper() {
    if (!generationPreview || generationPreview.questionIds.length === 0) return;
    if (!selectedQuestionsMatchSelection(generationCandidates, generationSelectedIds, generationClass, generationSubject)) {
      setGenerationError("একটি প্রশ্নপত্রে শুধু নির্বাচিত একই শ্রেণি ও বিষয়ের প্রশ্ন রাখা যাবে।");
      return;
    }
    if (generationPreview.questionIds.join("|") !== generationSelectedIds.join("|")) {
      setGenerationError("প্রশ্ন নির্বাচন বদলেছে। আগে খরচের প্রিভিউ আবার দেখুন।");
      return;
    }
    if (generationPreview.estimatedTokens > generationPreview.balance) {
      setGenerationError(`পর্যাপ্ত টোকেন নেই: ${generationPreview.estimatedTokens} টোকেন প্রয়োজন, ব্যালেন্স ${generationPreview.balance}।`);
      return;
    }

    const kind = activeSection;
    const configuredCqSets = generationCqSets.slice(0, generationCqSetCount).map((set, index) => ({
      setNumber: index + 1,
      chapters: set.chapters,
      questionCount: set.questionCount,
    }));
    const cqSetQuestionCount = configuredCqSets.reduce((total, set) => total + set.questionCount, 0);
    setIsGenerating(true);
    setGenerationError("");
    try {
      const response = await apiFetch("/api/papers/generate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: settings.exam || "নতুন প্রশ্নপত্র",
          settings: {
            ...settings,
            ...(kind === "CQ" ? {
              cqPageLayout,
              cqSetCount: creationMethod === "quick" && generationMode === "auto" ? generationCqSetCount : 0,
            } : {}),
          },
          classLevel: generationClass,
          subject: generationSubject,
          chapters: creationMethod === "blueprint" ? [blueprintChapter] : [],
          topics: creationMethod === "blueprint" && blueprintTopic ? [blueprintTopic] : [],
          type: kind,
          mode: generationMode,
          ...(creationMethod === "blueprint" ? {
            blueprint: { marks: blueprintMarks, difficultyCounts: blueprintDifficultyCounts },
          } : {}),
          ...(generationMode === "auto"
            ? {
                questionCount: creationMethod === "quick" && kind === "CQ" && generationCqSetCount > 0
                  ? cqSetQuestionCount
                  : creationMethod === "blueprint"
                    ? Object.values(blueprintDifficultyCounts).reduce((total, count) => total + count, 0)
                    : generationQuestionCount,
              questionIds: generationSelectedIds,
                ...(creationMethod === "quick" && kind === "CQ" && generationCqSetCount > 0 ? {
                cqSetCount: generationCqSetCount,
                cqSets: configuredCqSets,
                cqSetAssignments: generationPreview.setAssignments,
              } : {}),
            }
            : { questionIds: generationSelectedIds }),
          idempotencyKey: generationKeyRef.current,
        }),
      });
      const data = await readApiJson<{
        error?: string;
        balance?: number;
        paper: { id: string; settings: Partial<PaperSettings>; items: { question: GeneratedQuestionRow }[] };
        totalMarks: number;
        chargedTokens: number;
      }>(response);
      if (!response.ok) {
        if (typeof data.balance === "number") setTokenBalance(data.balance);
        throw new Error(data.error ?? "প্রশ্নপত্র তৈরি করা যায়নি");
      }
      if (typeof data.balance !== "number") {
        throw new Error("সার্ভার টোকেন ব্যালেন্স ফেরত দেয়নি");
      }
      const savedSetAssignments = data.paper.settings.cqSetAssignments ?? {};
      const generatedQuestions = (data.paper.items as { question: GeneratedQuestionRow }[])
        .map(({ question }) => ({
          ...mapGeneratedQuestion(question),
          ...(savedSetAssignments[question.id] !== undefined
            ? { setNumber: savedSetAssignments[question.id] }
            : {}),
        }));
      if (!generatedQuestions.every((question) =>
        question.classLevel === generationClass && question.subject === generationSubject)) {
        throw new Error("সার্ভার নির্বাচিত শ্রেণি বা বিষয়ের বাইরের প্রশ্ন ফেরত দিয়েছে।");
      }
      const savedSettings = data.paper.settings as Partial<PaperSettings>;
      setSectionSettings((current) => ({
        ...current,
        [kind]: { ...current[kind], ...savedSettings, marks: data.totalMarks },
      }));
      setQuestions((current) => [
        ...current.filter((question) => question.kind !== kind),
        ...generatedQuestions,
      ]);
      setPaperIds((current) => ({ ...current, [kind]: data.paper.id }));
      setSavedPapersRefresh((value) => value + 1);
      setTokenBalance(data.balance);
      setGenerationPreview(null);
      generationKeyRef.current = crypto.randomUUID();
      notify(`${data.totalMarks} নম্বরের প্রশ্নপত্র তৈরি হয়েছে · ${data.chargedTokens} টোকেন কাটা হয়েছে`);
      const accountResponse = await apiFetch("/api/tokens", { credentials: "same-origin" });
      const account = await readApiJson<{ transactions: { type: string; amount: number; createdAt: string; paper?: { title: string } | null }[] }>(accountResponse);
      setTokenTransactions(account.transactions);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "প্রশ্নপত্র তৈরি করা যায়নি");
    } finally {
      setIsGenerating(false);
    }
  }

  async function grantTokens(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const response = await apiFetch("/api/tokens/grant", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: grantEmail,
          amount: Number(grantAmount),
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const data = await readApiJson<{ error?: string; balance: number }>(response);
      if (!response.ok) throw new Error(data.error ?? "টোকেন দেওয়া যায়নি");
      if (grantEmail.trim().toLowerCase() === user?.email.toLowerCase()) {
        setTokenBalance(data.balance);
        const accountResponse = await apiFetch("/api/tokens", { credentials: "same-origin" });
        const account = await readApiJson<{ transactions: { type: string; amount: number; createdAt: string; paper?: { title: string } | null }[] }>(accountResponse);
        setTokenTransactions(account.transactions);
      }
      setGrantEmail("");
      notify(`${grantAmount} টোকেন অ্যাকাউন্টে যোগ হয়েছে`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "টোকেন দেওয়া যায়নি");
    }
  }

  function setSettings(next: PaperSettings | ((current: PaperSettings) => PaperSettings)) {
    setSectionSettings((current) => ({
      ...current,
      [activeSection]: typeof next === "function" ? next(current[activeSection]) : next,
    }));
  }

  function setPaperId(id: string | null) {
    setPaperIds((current) => ({ ...current, [activeSection]: id }));
  }

  function updateSettings<Key extends keyof PaperSettings>(key: Key, value: PaperSettings[Key]) {
    setSettingsSaveStatus(null);
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function updateShowAnswers(value: boolean) {
    setSettingsSaveStatus(null);
    setShowAnswers(value);
  }

  async function saveExamSettings() {
    if (settingsSaveInFlightRef.current) return;
    if (!user) {
      setSettingsSaveStatus({ type: "error", message: "সেটিংস সংরক্ষণ করতে অ্যাকাউন্টে সাইন ইন করুন।" });
      router.push("/login");
      return;
    }

    const kind = activeSection;
    const currentPaperId = paperIds[kind];
    settingsSaveInFlightRef.current = true;
    setIsSavingSettings(true);
    setSettingsSaveStatus(null);
    try {
      const response = await apiFetch(
        currentPaperId ? `/api/papers/${currentPaperId}/settings` : "/api/papers/settings",
        {
          method: currentPaperId ? "PUT" : "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: settings.exam || "নতুন প্রশ্নপত্র",
            settings: {
              ...settings,
              showAnswers,
              questionType: kind,
              ...(kind === "CQ" ? {
                cqPageLayout,
                cqSetCount: generationCqSetCount,
                cqSets: generationCqSets.slice(0, generationCqSetCount).map((set, index) => ({
                  setNumber: index + 1,
                  chapters: set.chapters,
                  questionCount: set.questionCount,
                })),
                cqSetAssignments: Object.fromEntries(questions.flatMap((question) =>
                  question.kind === "CQ" && question.setNumber !== undefined && question.serverId
                    ? [[question.serverId, question.setNumber]]
                    : [],
                )),
              } : {}),
            },
          }),
        },
      );
      const data = await readApiJson<{ error?: string; paper?: { id?: string } }>(response);
      if (!response.ok) throw new Error(data.error ?? "পরীক্ষার সেটিংস সংরক্ষণ করা যায়নি");
      const savedPaperId = data.paper?.id;
      if (typeof savedPaperId !== "string") {
        throw new Error("সার্ভার সংরক্ষিত প্রশ্নপত্রের তথ্য ফেরত দেয়নি");
      }
      setPaperIds((current) => ({ ...current, [kind]: savedPaperId }));
      setSavedPapersRefresh((value) => value + 1);
      setSettingsSaveStatus({ type: "success", message: "পরীক্ষার সেটিংস সংরক্ষণ হয়েছে।" });
      notify("পরীক্ষার সেটিংস সফলভাবে সংরক্ষণ হয়েছে।");
      setPaperSettingsOpen(false);
      setActiveMobilePane("questions");
      if (initialView === "question-settings") {
        router.replace("/app");
      }
    } catch (error) {
      setSettingsSaveStatus({
        type: "error",
        message: error instanceof Error ? error.message : "পরীক্ষার সেটিংস সংরক্ষণ করা যায়নি",
      });
    } finally {
      settingsSaveInFlightRef.current = false;
      setIsSavingSettings(false);
    }
  }

  function updateGenerationCqSetCount(value: string) {
    const count = Number(value);
    if (count !== 0 && count !== 2 && count !== 3 && count !== 4) return;
    resetGenerationSelection();
    if (count > 0) {
      setGenerationModes((current) => ({ ...current, CQ: "auto" }));
    }
    setGenerationCqSetCount(count);
  }

  function updateGenerationMode(value: string) {
    if (value !== "auto" && value !== "manual") return;
    resetGenerationSelection();
    if (value === "manual" && activeSection === "CQ" && generationCqSetCount > 0) {
      setGenerationCqSetCount(0);
    }
    setCreationMethod(value === "auto" ? "quick" : "manual");
    setGenerationModes((current) => ({ ...current, [activeSection]: value }));
  }

  function selectCreationMethod(method: QuestionCreationMethod) {
    setCreationMethod(method);
    setGenerationModes((current) => ({
      ...current,
      [activeSection]: method === "manual" || method === "previous" ? "manual" : "auto",
    }));
    if (method !== "quick") setGenerationCqSetCount(0);
    setBlueprintChapter("");
    setBlueprintTopic("");
    setBlueprintCatalogError("");
    setPreviousPaperId("");
    setPreviousPaperQuestions([]);
    resetGenerationSelection();
    if (method === "manual-create") {
      setManualDraft(newQuestion(activeSection));
      setManualImage(null);
      setManualQuestionError("");
    }
  }

  function updateCqPageLayout(value: string) {
    if (value !== "one" && value !== "two") return;
    cqLayoutAutoSwitchedRef.current = value === "one" && cqOnePageLayoutFitsRef.current;
    setCqPageLayout(value);
    setPreviewPageIndex(0);
    setSettingsSaveStatus(null);
  }

  function updateGenerationCqSet(setIndex: number, patch: Partial<{ chapters: string[]; questionCount: number }>) {
    resetGenerationSelection();
    setGenerationCqSets((current) => current.map((set, index) =>
      index === setIndex ? { ...set, ...patch } : set,
    ));
  }

  function toggleGenerationCqChapter(setIndex: number, chapter: string, checked: boolean) {
    const currentChapters = generationCqSets[setIndex]?.chapters ?? [];
    updateGenerationCqSet(setIndex, {
      chapters: checked
        ? [...currentChapters, chapter]
        : currentChapters.filter((item) => item !== chapter),
    });
  }

  function updateQuestion(id: string, patch: Partial<Question>) {
    setEditedQuestions((current) => current.map((question) => (question.id === id
      ? { ...question, ...patch, ...(isAdminPanel ? {} : { serverId: undefined }) }
      : question)));
  }

  function addBankQuestion(question: Question) {
    if (!isAdminPanel && question.kind === "CQ" && questions.filter((item) => item.kind === "CQ").length >= 12) {
      notify("একটি CQ পেপারে সর্বোচ্চ ১২টি প্রশ্ন যোগ করা যাবে");
      return;
    }
    setQuestions((current) => current.some((item) => item.serverId === question.serverId)
      ? current
      : [...current, { ...question, id: crypto.randomUUID() }]);
  }

  async function loadPreviousPaper(paperId: string) {
    setPreviousPaperId(paperId);
    setPreviousPaperQuestions([]);
    resetGenerationSelection();
    if (!paperId) return;
    setIsLoadingPreviousPaper(true);
    setPreviousPaperError("");
    try {
      const response = await apiFetch(`/api/papers/${paperId}`, { credentials: "same-origin" });
      const data = await readApiJson<{ error?: string; paper: PreviousPaper }>(response);
      if (!response.ok) throw new Error(data.error ?? "পূর্বের প্রশ্নপত্র খোলা যায়নি");
      const sourceQuestions = data.paper.items.map(({ question }) => mapGeneratedQuestion(question));
      if (!sourceQuestions.length) throw new Error("এই প্রশ্নপত্রে কোনো সংরক্ষিত প্রশ্ন নেই।");
      if (!sourceQuestions.every((question) =>
        question.kind === activeSection &&
        question.classLevel === sourceQuestions[0].classLevel &&
        question.subject === sourceQuestions[0].subject)) {
        throw new Error("পূর্বের প্রশ্নপত্রে সক্রিয় MCQ/CQ ধরন, শ্রেণি ও বিষয়ের সঙ্গে মেলে এমন প্রশ্ন নেই।");
      }
      const firstQuestion = sourceQuestions[0];
      setGenerationClass(firstQuestion.classLevel ?? "");
      setGenerationSubject(firstQuestion.subject ?? "");
      setGenerationCandidates(sourceQuestions);
      setPreviousPaperQuestions(sourceQuestions);
      setGenerationSelectedIds(sourceQuestions.map((question) => question.serverId ?? question.id));
      setSettings((current) => ({
        ...current,
        className: firstQuestion.classLevel ?? current.className,
        group: firstQuestion.group ?? current.group,
        subject: firstQuestion.subject ?? current.subject,
        chapter: firstQuestion.chapter ?? current.chapter,
        topic: firstQuestion.topic ?? current.topic,
      }));
      setGenerationError("");
    } catch (error) {
      setPreviousPaperError(error instanceof Error ? error.message : "পূর্বের প্রশ্নপত্র খোলা যায়নি");
    } finally {
      setIsLoadingPreviousPaper(false);
    }
  }

  function moveSelectedGenerationQuestion(questionId: string, direction: -1 | 1) {
    setGenerationSelectedIds((current) => {
      const index = current.indexOf(questionId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const reordered = [...current];
      [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
      return reordered;
    });
    setGenerationPreview(null);
  }

  async function createManualQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) {
      router.push("/login");
      return;
    }
    const classLevel = generationClass.trim();
    const subject = generationSubject.trim();
    const group = settings.group.trim();
    const chapter = manualDraft.chapter?.trim() || settings.chapter.trim();
    const topic = manualDraft.topic?.trim() ?? "";
    if (!classLevel || !subject || !group || !chapter || !manualDraft.text.trim()) {
      setManualQuestionError("শ্রেণি, বিভাগ, বিষয়, অধ্যায় ও প্রশ্নের বিবরণ পূরণ করুন।");
      return;
    }
    if (!Number.isInteger(manualDraft.marks) || manualDraft.marks < 1 || manualDraft.marks > 1000) {
      setManualQuestionError("নম্বর ১ থেকে ১০০০-এর মধ্যে পূর্ণসংখ্যা হতে হবে।");
      return;
    }
    if (activeSection === "MCQ" && (manualDraft.options?.filter((option) => option.trim()).length ?? 0) < 2) {
      setManualQuestionError("MCQ-এর জন্য অন্তত দুটি বিকল্প লিখুন।");
      return;
    }
    if (activeSection === "CQ" && (manualDraft.subs?.filter((sub) => sub.trim()).length ?? 0) < 1) {
      setManualQuestionError("CQ-এর জন্য অন্তত একটি উপপ্রশ্ন লিখুন।");
      return;
    }
    setIsSavingManualQuestion(true);
    setManualQuestionError("");
    try {
      let imageUrl: string | undefined;
      if (manualImage) {
        if (manualImageUploadRef.current?.file === manualImage) {
          imageUrl = manualImageUploadRef.current.url;
        } else {
          const formData = new FormData();
          formData.append("image", manualImage);
          const imageResponse = await apiFetch("/api/uploads", {
            method: "POST",
            credentials: "same-origin",
            body: formData,
          });
          const imageData = await readApiJson<{ error?: string; url: string }>(imageResponse);
          if (!imageResponse.ok) throw new Error(imageData.error ?? "ছবি আপলোড করা যায়নি");
          imageUrl = imageData.url;
          manualImageUploadRef.current = { file: manualImage, url: imageUrl };
        }
      }
      const content = {
        text: manualDraft.text,
        ...(activeSection === "MCQ" ? { options: manualDraft.options } : { subs: manualDraft.subs }),
        answer: manualDraft.answer,
        explanation: manualDraft.explanation,
        difficulty: manualDraft.difficulty,
        ...(imageUrl ? { imageUrl } : {}),
      };
      const questionInput = {
        type: activeSection,
        classLevel,
        group,
        subject,
        chapter,
        topic,
        marks: manualDraft.marks,
        content,
      };
      const serializedBody = JSON.stringify(questionInput);
      if (manualQuestionRequestRef.current?.body !== serializedBody) {
        manualQuestionRequestRef.current = { key: crypto.randomUUID(), body: serializedBody };
      }
      const response = await apiFetch("/api/questions/manual-create", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...questionInput,
          idempotencyKey: manualQuestionRequestRef.current.key,
        }),
      });
      const data = await readApiJson<{
        error?: string;
        balance?: number;
        question: { id: string };
        transaction: { type: string; amount: number; createdAt: string };
      }>(response);
      if (typeof data.balance === "number") setTokenBalance(data.balance);
      if (!response.ok) throw new Error(data.error ?? "প্রশ্ন সংরক্ষণ করা যায়নি");
      if (typeof data.balance !== "number" || !data.transaction) {
        throw new Error("সার্ভার টোকেন লেনদেনের তথ্য ফেরত দেয়নি");
      }
      const question: Question = {
        ...manualDraft,
        ...content,
        id: crypto.randomUUID(),
        serverId: data.question.id,
        kind: activeSection,
        classLevel,
        group,
        subject,
        chapter,
        topic,
      };
      setSettings((current) => ({ ...current, className: classLevel, group, subject, chapter, topic }));
      setQuestions((current) => [...current, question]);
      setBankRefresh((value) => value + 1);
      manualQuestionRequestRef.current = null;
      manualImageUploadRef.current = null;
      setManualDraft(newQuestion(activeSection));
      setManualImage(null);
      setGenerationError("");
      const manualTransaction = data.transaction;
      setTokenTransactions((current) => [{
        ...manualTransaction,
        paper: { title: "প্রশ্ন হাতে তৈরি" },
      }, ...current].slice(0, 50));
      notify("প্রশ্নটি সংরক্ষণ করে প্রশ্নপত্রে যোগ করা হয়েছে");
    } catch (error) {
      setManualQuestionError(error instanceof Error ? error.message : "প্রশ্ন তৈরি করা যায়নি");
    } finally {
      setIsSavingManualQuestion(false);
    }
  }

  async function saveAdminQuestion(question: Question) {
    if (user?.role !== "ADMIN") {
      router.push("/login");
      return;
    }
    if (savingAdminQuestionIdsRef.current.has(question.id)) return;
    const body = {
      type: question.kind,
      classLevel: question.classLevel || classFilter || settings.className,
      group: question.group || groupFilter || settings.group,
      subject: question.subject || subjectFilter || settings.subject,
      chapter: question.chapter || chapterFilter || settings.chapter,
      topic: question.topic || topicFilter || settings.topic,
      marks: Number(question.marks),
      content: {
        text: question.text,
        options: question.options,
        subs: question.subs,
        answer: question.answer,
        explanation: question.explanation,
        difficulty: question.difficulty,
        equation: question.equation,
        imageUrl: question.imageUrl,
        imageUrls: question.imageUrls,
        diagram: question.diagram,
        table: question.table,
        subMarks: question.subMarks,
        breakAfter: question.breakAfter,
      },
    };
    const requiredFields = [
      ["শ্রেণি", body.classLevel],
      ["বিভাগ", body.group],
      ["বিষয়", body.subject],
      ["অধ্যায়", body.chapter],
      ["প্রশ্নের বিবরণ", question.text],
    ] as const;
    const missingField = requiredFields.find(([, value]) => !value.trim());
    if (missingField) {
      notify(`${missingField[0]} আবশ্যক`);
      return;
    }
    if (!Number.isSafeInteger(body.marks) || body.marks < 1 || body.marks > 1000) {
      notify("নম্বর ১ থেকে ১০০০-এর মধ্যে পূর্ণসংখ্যা হতে হবে");
      return;
    }
    const nonEmptyAnswers = question.kind === "MCQ"
      ? question.options?.filter((option) => option.trim()) ?? []
      : question.subs?.filter((sub) => sub.trim()) ?? [];
    if (question.kind === "MCQ" && nonEmptyAnswers.length < 2) {
      notify("MCQ-এর জন্য অন্তত দুটি বিকল্প লিখুন");
      return;
    }
    if (question.kind === "CQ" && nonEmptyAnswers.length < 1) {
      notify("CQ-এর জন্য অন্তত একটি উপপ্রশ্ন লিখুন");
      return;
    }
    savingAdminQuestionIdsRef.current.add(question.id);
    setSavingAdminQuestionIds((current) => [...current, question.id]);
    try {
      const questionsEndpoint = isAdminPanel ? "/api/admin/questions" : "/api/questions";
      const response = await apiFetch(question.serverId
        ? `${questionsEndpoint}/${question.serverId}`
        : questionsEndpoint, {
        method: question.serverId ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readApiJson<{
        error?: string;
        issues?: { path: (string | number)[]; message: string }[];
        question: { id: string };
      }>(response);
      if (!response.ok) {
        const details = data.issues?.map((entry) => `${entry.path.join(".") || "প্রশ্ন"}: ${entry.message}`).join("; ");
        throw new Error(details ? `${data.error ?? "প্রশ্ন সংরক্ষণ করা যায়নি"} — ${details}` : data.error ?? "প্রশ্ন সংরক্ষণ করা যায়নি");
      }
      const savedQuestion = data.question as { id: string };
      setAdminQuestions((current) => current.map((item) => item.id === question.id
        ? { ...item, ...body, ...body.content, kind: body.type, serverId: savedQuestion.id }
        : item));
      setBankRefresh((value) => value + 1);
      setDashboardRefresh((value) => value + 1);
      notify("প্রশ্ন ব্যাংকে সংরক্ষিত হয়েছে");
    } catch (error) {
      notify(error instanceof Error ? error.message : "প্রশ্ন সংরক্ষণ করা যায়নি");
    } finally {
      savingAdminQuestionIdsRef.current.delete(question.id);
      setSavingAdminQuestionIds((current) => current.filter((id) => id !== question.id));
    }
  }

  async function deleteAdminQuestion(question: Question) {
    if (!question.serverId) {
      setAdminQuestions((current) => current.filter((item) => item.id !== question.id));
      return;
    }
    try {
      const response = await apiFetch(`/api/admin/questions/${question.serverId}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) {
        const data = await readApiJson<{ error?: string }>(response);
        throw new Error(data.error ?? "প্রশ্ন মুছে ফেলা যায়নি");
      }
      setAdminQuestions((current) => current.filter((item) => item.id !== question.id));
      setBankQuestions((current) => current.filter((item) => item.serverId !== question.serverId));
      setBankRefresh((value) => value + 1);
      setDashboardRefresh((value) => value + 1);
      notify("প্রশ্ন ব্যাংক থেকে মুছে ফেলা হয়েছে");
    } catch (error) {
      notify(error instanceof Error ? error.message : "প্রশ্ন মুছে ফেলা যায়নি");
    }
  }

  function saveDraft() {
    if (isDemo) {
      saveDemoDraft();
      return;
    }
    if (user) {
      void savePaperToAccount();
      return;
    }
    window.localStorage.setItem(`paper-maker-draft-${activeSection.toLowerCase()}-v1`, JSON.stringify({
      settings,
      questions: questions.filter((question) => question.kind === activeSection),
    }));
    notify("এই ব্রাউজারে খসড়াটি সংরক্ষিত হয়েছে");
  }

  function loadDraft() {
    if (isDemo) {
      loadDemoDraft();
      return;
    }
    if (user) {
      void loadAccountPaper();
      return;
    }
    const stored = window.localStorage.getItem(`paper-maker-draft-${activeSection.toLowerCase()}-v1`)
      ?? window.localStorage.getItem("paper-maker-draft-v1");
    if (!stored) return;
    try {
      const draft = JSON.parse(stored) as { settings?: PaperSettings; questions?: Question[] };
      if (draft.settings) setSettings({ ...initialSettings, ...draft.settings });
      if (draft.questions) {
        const selected = draft.questions.filter((question) => question.kind === activeSection);
        setQuestions((current) => [...current.filter((question) => question.kind !== activeSection), ...selected]);
      }
      notify("সংরক্ষিত খসড়া খোলা হয়েছে");
    } catch {
      notify("খসড়াটি পড়া যায়নি");
    }
  }

  function loadDemo() {
    const stored = window.localStorage.getItem(`paper-maker-demo-${activeSection.toLowerCase()}-v1`)
      ?? window.localStorage.getItem("paper-maker-demo-v1");
    if (stored) {
      loadDemoDraft();
      return;
    }
    setSettings({ ...demoSettings });
    const selected = demoQuestions.filter((question) => question.kind === activeSection);
    setQuestions((current) => [...current.filter((question) => question.kind !== activeSection), ...selected.map((question) => ({ ...question }))]);
    setPaperId(null);
    setIsDemo(true);
    setShowAnswers(false);
    notify("DEMO খোলা হয়েছে · পরিবর্তন শুধু এই ব্রাউজারে থাকবে");
  }

  function saveDemoDraft() {
    window.localStorage.setItem(`paper-maker-demo-${activeSection.toLowerCase()}-v1`, JSON.stringify({
      settings,
      questions: questions.filter((question) => question.kind === activeSection),
    }));
    notify("DEMO খসড়া এই ব্রাউজারে সংরক্ষিত হয়েছে");
  }

  function loadDemoDraft() {
    const stored = window.localStorage.getItem(`paper-maker-demo-${activeSection.toLowerCase()}-v1`)
      ?? window.localStorage.getItem("paper-maker-demo-v1");
    if (!stored) {
      loadDemo();
      return;
    }
    try {
      const draft = JSON.parse(stored) as { settings?: PaperSettings; questions?: Question[] };
      if (draft.settings) setSettings({ ...demoSettings, ...draft.settings });
      if (draft.questions) {
        const selected = draft.questions.filter((question) => question.kind === activeSection);
        setQuestions((current) => [...current.filter((question) => question.kind !== activeSection), ...selected]);
      }
      setPaperId(null);
      setIsDemo(true);
      notify("সংরক্ষিত DEMO খসড়া খোলা হয়েছে");
    } catch {
      notify("DEMO খসড়াটি পড়া যায়নি");
    }
  }

  async function savePaperToAccount() {
    if (isDemo) {
      saveDemoDraft();
      return;
    }
    if (!user) {
      router.push("/login");
      return;
    }
    const sectionQuestions = questions.filter((question) => question.kind === activeSection);
    if (sectionQuestions.length === 0) {
      notify(`${activeSection} প্রশ্ন যোগ করে তারপর সংরক্ষণ করুন`);
      return;
    }
    try {
      const questionIds = await Promise.all(sectionQuestions.map(async (question) => {
        if (question.serverId) return question.serverId;
        const content = {
          text: question.text,
          options: question.options,
          subs: question.subs,
          answer: question.answer,
          explanation: question.explanation,
          difficulty: question.difficulty,
          equation: question.equation,
          imageUrl: question.imageUrl,
          imageUrls: question.imageUrls,
          table: question.table,
          diagram: question.diagram,
          subMarks: question.subMarks,
          breakAfter: question.breakAfter,
        };
        const response = await apiFetch("/api/questions", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: question.kind,
            classLevel: settings.className,
            group: settings.group,
            subject: settings.subject,
            chapter: settings.chapter,
            topic: settings.topic,
            marks: question.marks,
            content,
          }),
        });
        const data = await readApiJson<{ error?: string; question: { id: string } }>(response);
        if (!response.ok) throw new Error(data.error ?? "প্রশ্ন সংরক্ষণ করা যায়নি");
        const serverId = data.question.id as string;
        setQuestions((current) => current.map((item) =>
          item.id === question.id ? { ...item, serverId } : item,
        ));
        return serverId;
      }));

      const response = await apiFetch(paperId ? `/api/papers/${paperId}` : "/api/papers", {
        method: paperId ? "PUT" : "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: settings.exam || "নতুন প্রশ্নপত্র",
          settings: {
            ...settings,
            showAnswers,
            questionType: activeSection,
            ...(activeSection === "CQ" ? {
              cqPageLayout,
              cqSetCount: generationCqSetCount,
              cqSets: generationCqSets.slice(0, generationCqSetCount).map((set, index) => ({
                setNumber: index + 1,
                chapters: set.chapters,
                questionCount: set.questionCount,
              })),
              cqSetAssignments: Object.fromEntries(sectionQuestions.flatMap((question) =>
                question.setNumber !== undefined && question.serverId
                  ? [[question.serverId, question.setNumber]]
                  : [],
              )),
            } : {}),
          },
          questionIds,
        }),
      });
      const data = await readApiJson<{ error?: string; paper: { id: string } }>(response);
      if (!response.ok) throw new Error(data.error ?? "প্রশ্নপত্র সংরক্ষণ করা যায়নি");
      setPaperId(data.paper.id);
      setSavedPapersRefresh((value) => value + 1);
      notify("প্রশ্নপত্র অ্যাকাউন্টে সংরক্ষিত হয়েছে");
    } catch (error) {
      notify(error instanceof Error ? error.message : "প্রশ্নপত্র সংরক্ষণ করা যায়নি");
    }
  }

  async function loadAccountPaper(preferredPaperId?: string) {
    try {
      const listResponse = await apiFetch("/api/papers", { credentials: "same-origin" });
      const listData = await readApiJson<{ error?: string; papers?: SavedPaperSummary[] }>(listResponse);
      if (!listResponse.ok) throw new Error(listData.error ?? "খসড়া খোলা যায়নি");
      type SavedPaper = {
        id: string;
        settings: Partial<PaperSettings> & { showAnswers?: boolean; questionType?: QuestionKind; cqPageLayout?: "one" | "two" };
        items: { question: { id: string; type: string; marks: number; content: Partial<Question> } }[];
      };
      let latest: SavedPaper | null = null;
      let targetSection = activeSection;
      const candidates = (listData.papers ?? []).filter((paper) => !preferredPaperId || paper.id === preferredPaperId);
      for (const candidate of candidates) {
        const response = await apiFetch(`/api/papers/${candidate.id}`, { credentials: "same-origin" });
        const data = await readApiJson<{ error?: string; paper: SavedPaper }>(response);
        if (!response.ok) throw new Error(data.error ?? "খসড়া খোলা যায়নি");
        const paper = data.paper as SavedPaper;
        const paperSection = paper.settings.questionType === "MCQ" || paper.settings.questionType === "CQ"
          ? paper.settings.questionType
          : paper.items[0]?.question.type === "MCQ" ? "MCQ" : paper.items[0]?.question.type === "CQ" ? "CQ" : activeSection;
        const matchesSection = preferredPaperId
          ? true
          : paper.items.length
            ? paper.items.every(({ question }) => question.type === activeSection)
            : paperSection === activeSection;
        if (matchesSection) {
          latest = paper;
          targetSection = paperSection;
          break;
        }
      }
      if (!latest) {
        notify(preferredPaperId ? "প্রশ্নপত্রটি খুঁজে পাওয়া যায়নি" : `${activeSection} এর কোনো সংরক্ষিত প্রশ্নপত্র নেই`);
        return;
      }
      setActiveSection(targetSection);
      setPaperIds((current) => ({ ...current, [targetSection]: latest.id }));
      setIsDemo(false);
      const paperSettings = { ...latest.settings };
      delete paperSettings.showAnswers;
      delete paperSettings.questionType;
      if (targetSection === "CQ") setCqPageLayout(paperSettings.cqPageLayout === "one" ? "one" : "two");
      if (targetSection === "CQ") {
        setGenerationCqSetCount(
          paperSettings.cqSetCount === 2 || paperSettings.cqSetCount === 3 || paperSettings.cqSetCount === 4
            ? paperSettings.cqSetCount
            : 0,
        );
        setGenerationCqSets(restoreCqGenerationSets(paperSettings.cqSets));
      }
      delete paperSettings.cqPageLayout;
      setSectionSettings((current) => ({
        ...current,
        [targetSection]: { ...initialSettings, ...paperSettings },
      }));
      const savedShowAnswers = latest.settings.showAnswers;
      if (typeof savedShowAnswers === "boolean") {
        setSectionShowAnswers((current) => ({ ...current, [targetSection]: savedShowAnswers }));
      }
      if (latest.items.length) {
        const loadedQuestions = latest.items.map(({ question }) => ({
          ...question.content,
          id: crypto.randomUUID(),
          serverId: question.id,
          kind: targetSection,
          text: question.content.text ?? "",
          marks: question.marks,
          ...(latest.settings.cqSetAssignments?.[question.id] !== undefined
            ? { setNumber: latest.settings.cqSetAssignments[question.id] }
            : {}),
        }));
        setQuestions((current) => [...current.filter((question) => question.kind !== targetSection), ...loadedQuestions]);
      }
      notify(`${targetSection} খসড়া খোলা হয়েছে`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "খসড়া খোলা যায়নি");
    }
  }

  async function uploadImage(questionId: string, file: File) {
    if (!user) {
      router.push("/login");
      return;
    }
    const formData = new FormData();
    formData.append("image", file);
    try {
      const response = await apiFetch("/api/uploads", { method: "POST", credentials: "same-origin", body: formData });
        const data = await readApiJson<{ error?: string; url: string }>(response);
      if (!response.ok) throw new Error(data.error ?? "ছবি আপলোড করা যায়নি");
      updateQuestion(questionId, { imageUrl: data.url });
      notify("চিত্রটি প্রশ্নে যুক্ত হয়েছে");
    } catch (error) {
      notify(error instanceof Error ? error.message : "ছবি আপলোড করা যায়নি");
    }
  }

  async function exportCsv() {
    if (!user) {
      router.push("/login");
      return;
    }
    try {
      const response = await apiFetch("/api/admin/questions/export.csv", { credentials: "same-origin" });
      if (!response.ok) {
        await readApiJson(response);
        throw new Error("CSV রপ্তানি করা যায়নি");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "questions.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      notify(error instanceof Error ? error.message : "CSV রপ্তানি করা যায়নি");
    }
  }

  async function deleteSelectedAdminQuestions() {
    if (!selectedAdminQuestionIds.length || isDeletingAdminQuestions) return;
    if (!window.confirm(translateUiText(`${selectedAdminQuestionIds.length}টি নির্বাচিত প্রশ্ন স্থায়ীভাবে মুছবেন?`, language))) return;
    setIsDeletingAdminQuestions(true);
    try {
      const response = await apiFetch("/api/admin/questions/bulk", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedAdminQuestionIds }),
      });
      const data = await readApiJson<{ error?: string; deleted?: number }>(response);
      if (!response.ok) throw new Error(data.error ?? "প্রশ্ন মুছতে ব্যর্থ হয়েছে");
      notify(`${data.deleted ?? 0}টি প্রশ্ন মুছে ফেলা হয়েছে`);
      setSelectedAdminQuestionIds([]);
      setBankRefresh((value) => value + 1);
      setDashboardRefresh((value) => value + 1);
    } catch (error) {
      notify(error instanceof Error ? error.message : "প্রশ্ন মুছতে ব্যর্থ হয়েছে");
    } finally {
      setIsDeletingAdminQuestions(false);
    }
  }

  async function createAcademicEntry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const response = await apiFetch("/api/admin/questions/academic", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: academicType, name: academicName, parentId: academicParentId || null }),
      });
      const data = await readApiJson<{ error?: string; entry: { id: string; type: string; name: string; parentId: string | null } }>(response);
      if (!response.ok) throw new Error(data.error ?? "একাডেমিক তথ্য সংরক্ষণ করা যায়নি");
      setAcademicEntries((entries) => [...entries, data.entry]);
      setAcademicName("");
      setAcademicParentId("");
      notify("একাডেমিক তথ্য যোগ হয়েছে");
    } catch (error) {
      notify(error instanceof Error ? error.message : "একাডেমিক তথ্য সংরক্ষণ করা যায়নি");
    }
  }

  async function deleteAcademicEntry(id: string) {
    if (!window.confirm(translateUiText("এই একাডেমিক তথ্য মুছে ফেলবেন?", language))) return;
    try {
      const response = await apiFetch(`/api/admin/questions/academic/${id}`, { method: "DELETE", credentials: "same-origin" });
      const data = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(data.error ?? "একাডেমিক তথ্য মুছতে ব্যর্থ হয়েছে");
      setAcademicEntries((entries) => entries.filter((entry) => entry.id !== id && entry.parentId !== id));
      notify("একাডেমিক তথ্য মুছে ফেলা হয়েছে");
    } catch (error) {
      notify(error instanceof Error ? error.message : "একাডেমিক তথ্য মুছতে ব্যর্থ হয়েছে");
    }
  }

  async function exportXlsx() {
    if (!user) {
      router.push("/login");
      return;
    }
    try {
      const response = await apiFetch("/api/admin/questions/export.xlsx", { credentials: "same-origin" });
      if (!response.ok) {
        await readApiJson(response);
        throw new Error("Excel রপ্তানি করা যায়নি");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "questions.xlsx";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Excel রপ্তানি করা যায়নি");
    }
  }

  async function logout() {
    try {
      const response = await apiFetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) {
        await readApiJson(response);
        throw new Error("সাইন আউট করা যায়নি। আবার চেষ্টা করুন।");
      }
      invalidateCurrentSessionRequest();
      setUser(null);
      setLoadedSettingsUserId(null);
      setPaperIds({ MCQ: null, CQ: null });
      setSectionSettings({ MCQ: { ...initialSettings }, CQ: { ...initialSettings } });
      setSectionShowAnswers({ MCQ: false, CQ: false });
      setCqPageLayout("two");
      setSettingsSaveStatus(null);
      router.replace("/");
    } catch (error) {
      notify(error instanceof Error ? error.message : "সাইন আউট করা যায়নি। আবার চেষ্টা করুন।");
    }
  }

  function addAdminQuestion(kind: QuestionKind) {
    setAdminOffset(0);
    setTypeFilter(kind);
    setSearch("");
    setAdminQuestions((current) => [...current, {
      ...newQuestion(kind),
      classLevel: classFilter,
      group: groupFilter,
      subject: subjectFilter,
      chapter: chapterFilter,
      topic: topicFilter,
    }]);
  }

  function openQuestionUpload(type?: QuestionKind) {
    if (type) setQuestionUploadType(type);
    document.getElementById("admin-question-upload")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function printPaper() {
    if (activeSection === "CQ" && (cqQuestionCountRef.current > 12 || !cqLayoutFitsRef.current)) {
      notify(cqQuestionCountRef.current > 12
        ? "CQ পেপারে ১২টির বেশি প্রশ্ন আছে; PDF তৈরি করা যাবে না"
      : cqPageLayout === "one"
        ? "সব CQ প্রশ্ন এক পৃষ্ঠার দুই কলামে ফিট হচ্ছে না; PDF তৈরি করা যাবে না"
        : "সব CQ প্রশ্ন নির্ধারিত দুই পৃষ্ঠায় ফিট হচ্ছে না; PDF তৈরি করা যাবে না");
      return;
    }
    document.fonts.ready.then(() => window.print());
  }

  function printPaperVersion(answerKey: boolean) {
    setShowAnswers(answerKey);
    window.setTimeout(() => {
      if (activeSection === "CQ" && (cqQuestionCountRef.current > 12 || !cqLayoutFitsRef.current)) {
        notify(cqQuestionCountRef.current > 12
          ? "CQ পেপারে ১২টির বেশি প্রশ্ন আছে; PDF তৈরি করা যাবে না"
          : cqPageLayout === "one"
            ? "সব CQ প্রশ্ন এক পৃষ্ঠার দুই কলামে ফিট হচ্ছে না; PDF তৈরি করা যাবে না"
            : "সব CQ প্রশ্ন নির্ধারিত দুই পৃষ্ঠায় ফিট হচ্ছে না; PDF তৈরি করা যাবে না");
        return;
      }
      document.fonts.ready.then(() => window.print());
    }, 80);
  }

  const activeQuestions = questions.filter((question) => question.kind === activeSection);
  const cqQuestionLimitExceeded = activeSection === "CQ" && activeQuestions.length > 12;
  const cqPageLimitExceeded = activeSection === "CQ" && !cqLayoutFits;
  const cqGenerationBlocked = cqQuestionLimitExceeded || cqPageLimitExceeded;
  const totalMarks = activeQuestions.reduce((sum, question) => sum + Number(question.marks || 0), 0);
  const visibleQuestions = editedQuestions.filter((question) =>
    (isAdminPanel || question.kind === activeSection) &&
    (!isAdminPanel || !typeFilter || question.kind === typeFilter) &&
    `${question.text} ${question.answer ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const paperStyle = {
    "--page-margin": `${settings.margin}mm`,
    "--column-gap": `${settings.columnGap}mm`,
    "--paper-size": `${settings.fontSize}pt`,
    "--paper-leading": settings.lineSpacing,
    "--paper-font": '"Paper Times New Roman", "Noto Serif Bengali", serif',
  } as CSSProperties;
  const measureStyle = paperStyle;
  const renderPaperHeading = (headingRef?: Ref<HTMLElement>) => (
    <header className="paper-heading" ref={headingRef}>
      <h2 className="paper-institution">{settings.institution || "প্রতিষ্ঠানের নাম"}</h2>
      <p className="paper-exam">{settings.exam || "পরীক্ষার শিরোনাম"}</p>
      <div className="paper-meta">
        <span>{settings.className}</span>
        <span>{settings.subject}</span>
        <span>সময়: <span>{settings.duration}</span></span>
        <span>পূর্ণমান: <span>{settings.marks}</span></span>
      </div>
      {settings.instructions && <p className="paper-instructions">নির্দেশনা: <span>{settings.instructions}</span></p>}
    </header>
  );
  const renderPaperPage = (page: PaperPage, pageIndex: number, keyPrefix: string, printOnly = false) => (
    <article
      className={`paper-page${page.kind === "CQ" ? " paper-page-cq" : ""}`}
      style={{ ...paperStyle, "--paper-columns": page.columns.length } as CSSProperties}
      key={`${keyPrefix}-page-${pageIndex}`}
    >
      <div className="paper-flow" style={{ gridTemplateColumns: `repeat(${page.columns.length}, minmax(0, 1fr))`, gap: `0 ${settings.columnGap}mm`, height: `${page.kind === "CQ" ? cqFlowHeight : mcqFlowHeight}mm` }}>
        {page.columns.map((column, columnIndex) => (
          <div className="paper-column" key={`column-${keyPrefix}-${pageIndex}-${columnIndex}`}>
            {((page.kind === "CQ" && pageIndex === 0 && columnIndex === 1) ||
              (page.kind === "MCQ" && pageIndex === 0 && columnIndex === 0)) && (
              <div className="paper-intro" ref={printOnly ? undefined : paperHeadingRef}>
                {renderPaperHeading()}
              </div>
            )}
            {column.map((fragment) => (
              <PaperQuestion
                question={fragment.question}
                number={fragment.number}
                subquestionIndexes={fragment.subquestionIndexes}
                showImage={fragment.showImage}
                showDetails={fragment.showDetails}
                showAnswers={showAnswers}
                showPrompt={fragment.startSubIndex === 0}
                onMathFieldReady={handleReadOnlyMathFieldReady}
                key={`${keyPrefix}-${fragment.id}`}
              />
            ))}
          </div>
        ))}
      </div>
      <footer className="paper-page-footer"><span>{settings.subject} · {settings.className}</span><span>{pageIndex + 1}</span></footer>
    </article>
  );

  const renderCqOnePage = (page: PaperPage, pageIndex: number, printOnly = false) => (
    <article
      className="paper-page paper-page-cq paper-page-cq-single"
      style={paperStyle}
      key={`CQ-one-page-${printOnly ? "print" : "preview"}-${pageIndex}`}
    >
      <div className="paper-intro cq-single-intro" ref={printOnly ? undefined : paperHeadingRef}>
        {renderPaperHeading()}
      </div>
      <div
        className="paper-flow cq-single-flow"
        style={{
          gridTemplateColumns: `repeat(2, minmax(0, 1fr))`,
          gap: `0 ${settings.columnGap}mm`,
          height: `${cqOnePageFlowHeight}mm`,
        }}
      >
        {page.columns.map((column, columnIndex) => (
          <div className="paper-column" key={`CQ-one-column-${columnIndex}`}>
            {column.map((fragment) => (
              <PaperQuestion
                question={fragment.question}
                number={fragment.number}
                subquestionIndexes={fragment.subquestionIndexes}
                showImage={fragment.showImage}
                showDetails={fragment.showDetails}
                showAnswers={showAnswers}
                showPrompt={fragment.startSubIndex === 0}
                onMathFieldReady={handleReadOnlyMathFieldReady}
                key={`CQ-one-${fragment.id}`}
              />
            ))}
          </div>
        ))}
      </div>
      <footer className="paper-page-footer"><span>{settings.subject} · {settings.className}</span><span>1</span></footer>
    </article>
  );

  const questionBankFilters = (
    <div className="question-bank-filters" id="question-bank-controls" aria-label="প্রশ্ন ব্যাংক ফিল্টার">
      <h3 className="section-title">প্রশ্ন ব্যাংক ফিল্টার</h3>
      <div className="form-grid">
        <div className="field"><label htmlFor="bank-class">শ্রেণি</label><select id="bank-class" value={classFilter} onChange={(event) => { setAdminOffset(0); setClassFilter(event.target.value); setGroupFilter(""); setSubjectFilter(""); setChapterFilter(""); setTopicFilter(""); }}><option value="">সব শ্রেণি</option>{catalog.classes.map((item) => <option key={item} data-no-translate>{item}</option>)}</select></div>
        <div className="field"><label htmlFor="bank-subject">বিষয়</label><select id="bank-subject" value={subjectFilter} onChange={(event) => { setAdminOffset(0); setSubjectFilter(event.target.value); setChapterFilter(""); setTopicFilter(""); }}><option value="">সব বিষয়</option>{catalog.subjects.map((item) => <option key={item} data-no-translate>{item}</option>)}</select></div>
        <div className="field"><label htmlFor="bank-chapter">অধ্যায়</label><select id="bank-chapter" value={chapterFilter} onChange={(event) => { setAdminOffset(0); setChapterFilter(event.target.value); setTopicFilter(""); }}><option value="">সব অধ্যায়</option>{catalog.chapters.map((item) => <option key={item} data-no-translate>{item}</option>)}</select></div>
        <div className="field"><label htmlFor="bank-topic">টপিক <span className="optional-label">(ঐচ্ছিক)</span></label><select id="bank-topic" value={topicFilter} onChange={(event) => { setAdminOffset(0); setTopicFilter(event.target.value); }}><option value="">সব টপিক</option>{catalog.topics.map((item) => <option key={item} data-no-translate>{item}</option>)}</select></div>
        <div className="field"><label htmlFor="bank-group">বিভাগ</label><select id="bank-group" value={groupFilter} onChange={(event) => { setAdminOffset(0); setGroupFilter(event.target.value); setSubjectFilter(""); setChapterFilter(""); setTopicFilter(""); }}><option value="">সব বিভাগ</option>{catalog.groups.map((item) => <option key={item} data-no-translate>{item}</option>)}</select></div>
        {isAdminPanel && <div className="field"><label htmlFor="bank-type">প্রশ্নের ধরন</label><select id="bank-type" value={typeFilter} onChange={(event) => { setAdminOffset(0); setTypeFilter(event.target.value as QuestionKind | ""); }}><option value="">সব ধরন</option><option value="MCQ">MCQ</option><option value="CQ">CQ</option></select></div>}
      </div>
    </div>
  );

  const isLoadingSavedPapers = savedPapers === null && !savedPapersError;
  const isLoadingSubscription = subscription === undefined && !subscriptionError;
  const copy = language === "en" ? {
    home: "Home",
    create: "Create Question Paper",
    papers: "My Question Papers",
    notifications: "Notifications",
    profile: "My Profile",
    accountSettings: "Account Settings",
    subscription: "Subscription",
    help: "Help & Support",
    logout: "Logout",
    welcome: "Welcome",
    welcomeDetail: "Create and organize your next question paper with ease.",
    chooseType: "Choose a paper type to get started",
    mcqTitle: "MCQ Question Paper",
    mcqDetail: "Build a multiple-choice paper from your question bank.",
    cqTitle: "CQ Question Paper",
    cqDetail: "Create a creative question paper with your preferred layout.",
    startCreating: "Start creating",
    recentPapers: "Recent question papers",
    viewAll: "View all papers",
    savedPapers: "My question papers",
    savedPapersDetail: "Your saved question papers, available to reopen and continue editing.",
    loadingPapers: "Loading your question papers…",
    retry: "Try again",
    noPapers: "No saved question papers yet.",
    openPaper: "Open paper",
    updated: "Updated",
    questions: "questions",
    recentActivity: "Recent account activity",
    loadingActivity: "Loading account activity…",
    noActivity: "No recent account activity.",
    tokenUpdated: "Token balance updated",
    profileDetail: "Your account information",
    name: "Name",
    email: "Email",
    role: "Account type",
    teacher: "Teacher",
    admin: "Administrator",
    subscriptionDetail: "Your current subscription information",
    loadingSubscription: "Loading subscription…",
    noSubscription: "No active subscription is associated with this account.",
    helpDetail: "A quick guide to the existing paper-creation workflow.",
    helpStepOne: "Choose MCQ or CQ from the creation page.",
    helpStepTwo: "Select a class and subject, then choose automatic generation or manual question selection.",
    helpStepThree: "Review exam settings and preview before saving or exporting your paper.",
    backHome: "Back to home",
    menu: "Open navigation",
  } : {
    home: "হোম",
    create: "প্রশ্নপত্র তৈরি",
    papers: "আমার প্রশ্নপত্র",
    notifications: "নোটিফিকেশন",
    profile: "আমার প্রোফাইল",
    accountSettings: "অ্যাকাউন্ট সেটিংস",
    subscription: "সাবস্ক্রিপশন",
    help: "সাহায্য ও সহায়তা",
    logout: "লগআউট",
    welcome: "স্বাগতম",
    welcomeDetail: "সহজেই আপনার পরবর্তী প্রশ্নপত্রটি তৈরি ও সাজান।",
    chooseType: "শুরু করতে প্রশ্নপত্রের ধরন বেছে নিন",
    mcqTitle: "MCQ Question Paper",
    mcqDetail: "প্রশ্ন ব্যাংক থেকে বহুনির্বাচনী প্রশ্নপত্র তৈরি করুন।",
    cqTitle: "CQ Question Paper",
    cqDetail: "পছন্দের বিন্যাসে সৃজনশীল প্রশ্নপত্র তৈরি করুন।",
    startCreating: "তৈরি শুরু করুন",
    recentPapers: "সাম্প্রতিক প্রশ্নপত্র",
    viewAll: "সব প্রশ্নপত্র দেখুন",
    savedPapers: "আমার প্রশ্নপত্র",
    savedPapersDetail: "আপনার সংরক্ষিত প্রশ্নপত্র খুলে সম্পাদনা চালিয়ে যান।",
    loadingPapers: "প্রশ্নপত্র লোড হচ্ছে…",
    retry: "আবার চেষ্টা করুন",
    noPapers: "এখনো কোনো প্রশ্নপত্র সংরক্ষিত নেই।",
    openPaper: "প্রশ্নপত্র খুলুন",
    updated: "সর্বশেষ পরিবর্তন",
    questions: "টি প্রশ্ন",
    recentActivity: "সাম্প্রতিক অ্যাকাউন্ট কার্যক্রম",
    loadingActivity: "অ্যাকাউন্টের কার্যক্রম লোড হচ্ছে…",
    noActivity: "সাম্প্রতিক কোনো অ্যাকাউন্ট কার্যক্রম নেই।",
    tokenUpdated: "টোকেন ব্যালেন্স আপডেট",
    profileDetail: "আপনার অ্যাকাউন্টের তথ্য",
    name: "নাম",
    email: "ইমেইল",
    role: "অ্যাকাউন্টের ধরন",
    teacher: "শিক্ষক",
    admin: "অ্যাডমিন",
    subscriptionDetail: "আপনার বর্তমান সাবস্ক্রিপশনের তথ্য",
    loadingSubscription: "সাবস্ক্রিপশন লোড হচ্ছে…",
    noSubscription: "এই অ্যাকাউন্টে কোনো সক্রিয় সাবস্ক্রিপশন নেই।",
    helpDetail: "বিদ্যমান প্রশ্নপত্র তৈরির কাজের একটি সংক্ষিপ্ত নির্দেশিকা।",
    helpStepOne: "তৈরি পৃষ্ঠা থেকে MCQ অথবা CQ বেছে নিন।",
    helpStepTwo: "শ্রেণি ও বিষয় নির্বাচন করে স্বয়ংক্রিয় তৈরি অথবা হাতে প্রশ্ন বাছাই করুন।",
    helpStepThree: "সংরক্ষণ বা রপ্তানির আগে পরীক্ষার সেটিংস ও প্রিভিউ দেখে নিন।",
    backHome: "হোমে ফিরুন",
    menu: "নেভিগেশন খুলুন",
  };
  const renderSavedPapers = (compact: boolean) => (
    <div className={`user-saved-paper-list${compact ? " compact" : ""}`}>
      {savedPapersError && <p className="user-panel-error" role="alert">{savedPapersError}</p>}
      {isLoadingSavedPapers && <p className="user-panel-empty" role="status">{copy.loadingPapers}</p>}
      {!isLoadingSavedPapers && !savedPapersError && savedPapers?.length === 0 && (
        <p className="user-panel-empty">{copy.noPapers}</p>
      )}
      {!isLoadingSavedPapers && savedPapers?.slice(0, compact ? 5 : undefined).map((paper) => (
        <article className="user-saved-paper" key={paper.id}>
          <span className="user-saved-paper-icon"><FileText size={18} /></span>
          <span className="user-saved-paper-copy">
            <strong>{paper.title}</strong>
            <small>{copy.updated} {new Date(paper.updatedAt).toLocaleDateString(language === "en" ? "en-US" : "bn-BD")} · {paper._count.items} {copy.questions}</small>
          </span>
          <button
            className="user-panel-link-button"
            type="button"
            onClick={() => {
              navigateUserPanel("create");
              void loadAccountPaper(paper.id);
            }}
          >{copy.openPaper}<ArrowRight size={15} /></button>
        </article>
      ))}
      {savedPapersError && (
        <button className="button" type="button" onClick={() => setSavedPapersRefresh((value) => value + 1)}>
          <RefreshCw size={15} />{copy.retry}
        </button>
      )}
    </div>
  );

  const questionSettingsForm = (
    <section className="paper-settings-section" id="paper-settings" aria-label="পরীক্ষার সেটিংস">
      {(paperSettingsOpen || initialView === "question-settings") && <>
        {initialView === "question-settings" && (
          <div className="workflow-picker question-settings-kind-picker" role="group" aria-label="প্রশ্নপত্রের ধরন">
            <button type="button" className={`workflow-option${activeSection === "MCQ" ? " selected" : ""}`} aria-pressed={activeSection === "MCQ"} onClick={() => setActiveSection("MCQ")}><FileText size={14} />MCQ</button>
            <button type="button" className={`workflow-option${activeSection === "CQ" ? " selected" : ""}`} aria-pressed={activeSection === "CQ"} onClick={() => setActiveSection("CQ")}><ClipboardList size={14} />CQ</button>
          </div>
        )}
        {initialView === "question-settings" && activeSection === "CQ" && (
          <div className="field cq-page-layout-field">
            <label htmlFor="cq-page-layout">CQ পৃষ্ঠা বিন্যাস</label>
            <select id="cq-page-layout" value={cqPageLayout} onChange={(event) => updateCqPageLayout(event.target.value)}>
              <option value="one">১ পৃষ্ঠা</option>
              <option value="two">২ পৃষ্ঠা</option>
            </select>
          </div>
        )}
        <div className="form-grid">
          <div className="field wide"><label htmlFor="institution">প্রতিষ্ঠানের নাম</label><input id="institution" value={settings.institution} onChange={(event) => updateSettings("institution", event.target.value)} /></div>
          <div className="field wide"><label htmlFor="settings-exam">পরীক্ষার নাম</label><input id="settings-exam" value={settings.exam} onChange={(event) => updateSettings("exam", event.target.value)} /></div>
          <div className="field"><label htmlFor="class">শ্রেণি</label><input id="class" value={settings.className} onChange={(event) => updateSettings("className", event.target.value)} /></div>
          <div className="field"><label htmlFor="group">বিভাগ</label><select id="group" value={settings.group} onChange={(event) => updateSettings("group", event.target.value)}><option>বিজ্ঞান</option><option>মানবিক</option><option>ব্যবসায় শিক্ষা</option></select></div>
          <div className="field"><label htmlFor="subject">বিষয়</label><input id="subject" value={settings.subject} onChange={(event) => updateSettings("subject", event.target.value)} /></div>
          <div className="field"><label htmlFor="chapter">অধ্যায়</label><input id="chapter" value={settings.chapter} onChange={(event) => updateSettings("chapter", event.target.value)} /></div>
          <div className="field"><label htmlFor="topic">টপিক</label><input id="topic" value={settings.topic} onChange={(event) => updateSettings("topic", event.target.value)} /></div>
          <div className="field"><label htmlFor="duration">সময়</label><input id="duration" value={settings.duration} onChange={(event) => updateSettings("duration", event.target.value)} /></div>
          <div className="field"><label htmlFor="marks">পূর্ণমান</label><input id="marks" type="number" min="1" value={settings.marks} onChange={(event) => updateSettings("marks", Number(event.target.value))} /></div>
          <div className="field wide"><label htmlFor="instructions">নির্দেশনা</label><textarea id="instructions" value={settings.instructions} onChange={(event) => updateSettings("instructions", event.target.value)} /></div>
        </div>
        <section className="exam-header-live-preview" aria-label="পরীক্ষার শিরোনামের লাইভ প্রিভিউ" aria-live="polite">
          <p className="exam-header-preview-label">শিরোনামের লাইভ প্রিভিউ</p>
          <div className="exam-header-preview-paper">
            <strong>{settings.institution || "প্রতিষ্ঠানের নাম"}</strong>
            <p className="exam-header-preview-title">{settings.className || "শ্রেণি"} · {settings.exam || "পরীক্ষার নাম"}</p>
            <p>{settings.className || "শ্রেণি"} | {settings.subject || "বিষয়"} | সময়: {settings.duration || "সময় নির্ধারণ করুন"} | পূর্ণমান: {new Intl.NumberFormat("bn-BD").format(settings.marks)}</p>
            <p><b>নির্দেশনা:</b> {settings.instructions || "নির্দেশনা যোগ করুন"}</p>
          </div>
        </section>
        <div className="toolbar-page-settings">
          <div className="toggle-line"><label htmlFor="answer-key">উত্তরপত্রের প্রিভিউ</label><input id="answer-key" type="checkbox" checked={showAnswers} onChange={(event) => updateShowAnswers(event.target.checked)} /></div>
        </div>
      </>}
      {initialView === "question-settings" && (
        <div className="settings-save-actions">
          {settingsSaveStatus && (
            <p className={`settings-save-status ${settingsSaveStatus.type}`} role={settingsSaveStatus.type === "error" ? "alert" : "status"}>
              {translateUiText(settingsSaveStatus.message, language)}
            </p>
          )}
          <button className="button primary settings-save-button" type="button" onClick={() => void saveExamSettings()} disabled={isSavingSettings || isLoadingSavedSettings}>
            <Save size={15} />
            <span>{isSavingSettings ? "সংরক্ষণ হচ্ছে…" : "সংরক্ষণ করুন (Save)"}</span>
          </button>
        </div>
      )}
    </section>
  );

  if (initialView === "question-settings") {
    return (
      <main className="app-shell question-settings-route">
        <section className="question-settings-full-page" aria-labelledby="question-settings-page-title">
          <header className="question-settings-page-header">
            <h1 id="question-settings-page-title">পরীক্ষার সেটিংস</h1>
            <button className="button question-settings-back" type="button" onClick={() => router.replace("/app")}><ChevronLeft size={16} />এডিটরে ফিরে যান</button>
          </header>
          <div className="question-settings-page-content">{questionSettingsForm}</div>
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell${paperSettingsOpen ? " settings-theme-active" : ""}${!isAdminPanel ? " user-panel-shell" : ""}${!isAdminPanel && userPanelView === "create" ? " user-panel-creating" : ""}`}>
      <section className="workspace">
        <header className="topbar">
          <div className="topbar-leading">
            <button
              className="menu-toggle"
              type="button"
              aria-label={secondaryMenuOpen ? "নেভিগেশন বন্ধ করুন" : copy.menu}
              aria-expanded={secondaryMenuOpen}
              aria-controls="secondary-navigation"
              onClick={() => setSecondaryMenuOpen((open) => !open)}
            ><Menu size={21} /></button>
            <div className="topbar-brand">
              <span className="topbar-brand-mark"><BookOpen size={18} /></span>
              <span className="topbar-brand-copy"><strong>প্রশ্নপত্র নির্মাতা</strong><span>প্রশ্নপত্র তৈরি ও সাজান</span></span>
            </div>
          </div>
          <nav className="top-navigation" aria-label="প্রধান নেভিগেশন">
            {isAdminPanel ? <>
              <a href="#editor" aria-current={activeMobilePane === "questions" ? "page" : undefined} onClick={() => setActiveMobilePane("questions")}>প্রশ্ন তৈরি</a>
              <a href="#questions" onClick={() => setActiveMobilePane("questions")}>প্রশ্নসমূহ</a>
              <a href="#preview" aria-current={activeMobilePane === "preview" ? "page" : undefined} onClick={() => setActiveMobilePane("preview")}>প্রিভিউ</a>
            </> : <>
              {([
                ["home", copy.home, Home],
                ["create", copy.create, FilePlus2],
                ["papers", copy.papers, FileText],
                ["notifications", copy.notifications, Bell],
              ] as const).map(([view, label, Icon]) => (
                <button
                  type="button"
                  className={userPanelView === view ? "active" : ""}
                  aria-current={userPanelView === view ? "page" : undefined}
                  key={view}
                  onClick={() => { navigateUserPanel(view); setSecondaryMenuOpen(false); }}
                ><Icon size={15} /><span>{label}</span></button>
              ))}
            </>}
          </nav>
          {secondaryMenuOpen && !isAdminPanel && (
            <div className="user-mobile-menu" role="dialog" aria-modal="false" aria-label="অতিরিক্ত নেভিগেশন">
              <div className="user-mobile-menu-heading">
                <strong>{copy.menu}</strong>
                <button type="button" aria-label="মেনু বন্ধ করুন" onClick={() => setSecondaryMenuOpen(false)}><X size={17} /></button>
              </div>
              <nav id="secondary-navigation" aria-label="মোবাইল নেভিগেশন">
                {([
                  ["home", copy.home, Home],
                  ["create", copy.create, FilePlus2],
                  ["papers", copy.papers, FileText],
                  ["notifications", copy.notifications, Bell],
                ] as const).map(([view, label, Icon]) => (
                  <button
                    type="button"
                    className={userPanelView === view ? "active" : ""}
                    aria-current={userPanelView === view ? "page" : undefined}
                    key={view}
                    onClick={() => { navigateUserPanel(view); setSecondaryMenuOpen(false); }}
                  ><Icon size={17} />{label}</button>
                ))}
              </nav>
              {userPanelView === "create" && (
                <div className="user-mobile-shortcuts">
                  <a href="#question-bank-controls" onClick={() => setSecondaryMenuOpen(false)}>প্রশ্ন বাছাইয়ের ফিল্টার</a>
                  <a href="#question-bank" onClick={() => setSecondaryMenuOpen(false)}>প্রশ্ন ব্যাংক</a>
                  <a href="#paper-settings" onClick={() => setSecondaryMenuOpen(false)}>পরীক্ষা ও পৃষ্ঠার সেটিংস</a>
                </div>
              )}
            </div>
          )}
          <div className="topbar-account">
            <LanguageSwitcher />
            <ThemeSwitcher />
            <div className="topbar-panel">
              {user?.role === "ADMIN" ? (
                <div className="segmented" role="group" aria-label="প্যানেল নির্বাচন">
                  <button className={panel === "user" ? "selected" : ""} onClick={() => { setPanel("user"); navigateUserPanel("home"); }}>ইউজার প্যানেল</button>
                  <button className={panel === "admin" ? "selected" : ""} onClick={() => setPanel("admin")}>অ্যাডমিন প্যানেল</button>
                </div>
              ) : null}
            </div>
            <details className="account-menu">
              <summary aria-label={user ? `অ্যাকাউন্ট: ${user.name}` : "অ্যাকাউন্ট মেনু"}>
                <span className="account-avatar">{user?.name.trim().charAt(0).toUpperCase() || <UserRound size={16} />}</span>
                <span className="account-menu-name" data-no-translate>{user?.name ?? "অতিথি"}</span>
                <ChevronDown size={14} />
              </summary>
              <div className="account-menu-content">
                <span className="account-menu-status"><span className="save-dot" />{user ? user.email : "স্থানীয় খসড়া"}</span>
                {user && !isAdminPanel && <>
                  <button className="account-menu-action" type="button" onClick={(event) => {
                    navigateUserPanel("profile");
                    const menu = event.currentTarget.closest("details");
                    if (menu instanceof HTMLDetailsElement) menu.open = false;
                  }}><UserRound size={16} />{copy.profile}</button>
                  <button className="account-menu-action" type="button" onClick={() => router.push("/change-password")}><Settings2 size={16} />{copy.accountSettings}</button>
                  <button className="account-menu-action" type="button" onClick={(event) => {
                    navigateUserPanel("subscription");
                    setSubscription(undefined);
                    setSubscriptionError("");
                    const menu = event.currentTarget.closest("details");
                    if (menu instanceof HTMLDetailsElement) menu.open = false;
                  }}><CreditCard size={16} />{copy.subscription}</button>
                  <button className="account-menu-action" type="button" onClick={(event) => {
                    navigateUserPanel("help");
                    const menu = event.currentTarget.closest("details");
                    if (menu instanceof HTMLDetailsElement) menu.open = false;
                  }}><CircleHelp size={16} />{copy.help}</button>
                  <button className="button account-menu-logout" type="button" onClick={() => void logout()}><LogOut size={16} />{copy.logout}</button>
                </>}
                {user && isAdminPanel && <button className="button" type="button" onClick={() => void logout()}>সাইন আউট</button>}
                {!user && <button className="button" type="button" onClick={() => router.push("/login")}>সাইন ইন</button>}
              </div>
            </details>
          </div>
        </header>

        {isAdminPanel && (
          <section className="editor-toolbar" aria-label="প্রশ্নপত্রের টুলবার">
            <div className="editor-toolbar-content" ref={setEditorToolbarElement} />
          </section>
        )}

        <div className={`work-area${isAdminPanel ? " admin-work-area" : ""}`} data-active-pane={activeMobilePane}>
          {!isAdminPanel && userPanelView !== "create" ? (
            <section className="user-panel-page">
              {userPanelView === "home" && <>
                <header className="user-panel-hero">
                  <div>
                    <p className="user-panel-eyebrow"><span className="user-panel-online-dot" />{copy.home}</p>
                    <h1>{copy.welcome}, <span data-no-translate>{user?.name}</span></h1>
                    <p>{copy.welcomeDetail}</p>
                  </div>
                  <div className="user-panel-hero-mark" aria-hidden="true"><BookOpen size={42} /></div>
                </header>
                <section className="user-creation-section" aria-labelledby="create-question-paper-heading">
                  <div className="user-section-heading">
                    <div><p className="user-panel-eyebrow">01 · {copy.create}</p><h2 id="create-question-paper-heading">{copy.chooseType}</h2></div>
                  </div>
                  <div className="user-creation-grid">
                    <button className="user-creation-card mcq" type="button" onClick={() => {
                      resetGenerationSelection();
                      setPreviewPageIndex(0);
                      setActiveSection("MCQ");
                      navigateUserPanel("create");
                    }}>
                      <span className="user-creation-icon"><FileText size={22} /></span>
                      <span className="user-creation-card-copy"><strong>{copy.mcqTitle}</strong><small>{copy.mcqDetail}</small></span>
                      <span className="user-creation-card-action">{copy.startCreating}<ArrowRight size={16} /></span>
                    </button>
                    <button className="user-creation-card cq" type="button" onClick={() => {
                      resetGenerationSelection();
                      setPreviewPageIndex(0);
                      setActiveSection("CQ");
                      navigateUserPanel("create");
                    }}>
                      <span className="user-creation-icon"><ClipboardList size={22} /></span>
                      <span className="user-creation-card-copy"><strong>{copy.cqTitle}</strong><small>{copy.cqDetail}</small></span>
                      <span className="user-creation-card-action">{copy.startCreating}<ArrowRight size={16} /></span>
                    </button>
                  </div>
                </section>
                <section className="user-recent-section" aria-labelledby="recent-question-papers-heading">
                  <div className="user-section-heading user-recent-heading">
                    <div><p className="user-panel-eyebrow">02 · {copy.papers}</p><h2 id="recent-question-papers-heading">{copy.recentPapers}</h2></div>
                    <button className="user-panel-text-button" type="button" onClick={() => navigateUserPanel("papers")}>{copy.viewAll}<ArrowRight size={15} /></button>
                  </div>
                  {renderSavedPapers(true)}
                </section>
              </>}
              {userPanelView === "papers" && (
                <section className="user-subpage">
                  <header className="user-subpage-heading">
                    <div><p className="user-panel-eyebrow">{copy.home} / {copy.papers}</p><h1>{copy.savedPapers}</h1><p>{copy.savedPapersDetail}</p></div>
                    <button className="button" type="button" onClick={() => setSavedPapersRefresh((value) => value + 1)} disabled={isLoadingSavedPapers}><RefreshCw size={15} />{copy.viewAll}</button>
                  </header>
                  {renderSavedPapers(false)}
                </section>
              )}
              {userPanelView === "notifications" && (
                <section className="user-subpage">
                  <header className="user-subpage-heading"><div><p className="user-panel-eyebrow">{copy.home} / {copy.notifications}</p><h1>{copy.notifications}</h1><p>{copy.recentActivity}</p></div></header>
                  <div className="user-activity-list">
                    {isLoadingGenerationClasses
                      ? <p className="user-panel-empty" role="status">{copy.loadingActivity}</p>
                      : tokenTransactions.length === 0
                        ? <p className="user-panel-empty">{copy.noActivity}</p>
                        : tokenTransactions.map((transaction, index) => (
                        <article className="user-activity-item" key={`${transaction.createdAt}-${index}`}>
                          <span className="user-activity-icon"><Bell size={17} /></span>
                          <span><strong>{transaction.type === "CHARGE" ? transaction.paper?.title ?? copy.create : copy.tokenUpdated}</strong><small>{new Date(transaction.createdAt).toLocaleString(language === "en" ? "en-US" : "bn-BD")}</small></span>
                          <strong className={transaction.amount < 0 ? "debit" : "credit"}>{transaction.amount > 0 ? "+" : ""}{transaction.amount}</strong>
                        </article>
                      ))}
                  </div>
                </section>
              )}
              {userPanelView === "profile" && (
                <section className="user-subpage">
                  <header className="user-subpage-heading"><div><p className="user-panel-eyebrow">{copy.home} / {copy.profile}</p><h1>{copy.profile}</h1><p>{copy.profileDetail}</p></div></header>
                  <div className="user-profile-card">
                    <span className="user-profile-avatar">{user?.name.trim().charAt(0).toUpperCase()}</span>
                    <div><small>{copy.name}</small><strong data-no-translate>{user?.name}</strong></div>
                    <div><small>{copy.email}</small><strong data-no-translate>{user?.email}</strong></div>
                    <div><small>{copy.role}</small><strong>{user?.role === "ADMIN" ? copy.admin : copy.teacher}</strong></div>
                  </div>
                </section>
              )}
              {userPanelView === "subscription" && (
                <section className="user-subpage">
                  <header className="user-subpage-heading"><div><p className="user-panel-eyebrow">{copy.home} / {copy.subscription}</p><h1>{copy.subscription}</h1><p>{copy.subscriptionDetail}</p></div></header>
                  {subscriptionError
                    ? <p className="user-panel-error" role="alert">{subscriptionError}</p>
                    : isLoadingSubscription
                      ? <p className="user-panel-empty" role="status">{copy.loadingSubscription}</p>
                      : <article className="user-subscription-card"><span className="user-creation-icon"><CreditCard size={22} /></span><div><h2>{subscription?.plan?.name ?? copy.subscription}</h2><p>{subscription?.status ?? copy.noSubscription}</p></div></article>}
                </section>
              )}
              {userPanelView === "help" && (
                <section className="user-subpage">
                  <header className="user-subpage-heading"><div><p className="user-panel-eyebrow">{copy.home} / {copy.help}</p><h1>{copy.help}</h1><p>{copy.helpDetail}</p></div></header>
                  <ol className="user-help-steps"><li>{copy.helpStepOne}</li><li>{copy.helpStepTwo}</li><li>{copy.helpStepThree}</li></ol>
                  <button className="button primary" type="button" onClick={() => navigateUserPanel("create")}><FilePlus2 size={16} />{copy.create}</button>
                </section>
              )}
            </section>
          ) : <>
          {isAdminPanel && secondaryMenuOpen && (
            <button className="drawer-backdrop" type="button" aria-label="মেনু বন্ধ করুন" onClick={() => setSecondaryMenuOpen(false)} />
          )}
          {isAdminPanel && secondaryMenuOpen && (
            <aside className="guest-menu" id="secondary-navigation" role="dialog" aria-modal="true" aria-label="অতিরিক্ত নেভিগেশন">
              <div className="secondary-menu-heading">
                <div>
                  <p className="eyebrow">প্রশ্নপত্র</p>
                  <h2>অতিরিক্ত কাজ</h2>
                </div>
                <button className="menu-close" type="button" aria-label="মেনু বন্ধ করুন" onClick={() => setSecondaryMenuOpen(false)}><X size={20} /></button>
              </div>
              <div className="secondary-menu-actions">
                <a href="#question-bank-controls" onClick={() => setSecondaryMenuOpen(false)}>প্রশ্ন বাছাইয়ের ফিল্টার</a>
                <a href="#question-bank" onClick={() => setSecondaryMenuOpen(false)}>প্রশ্ন ব্যাংক</a>
                <a href="#paper-settings" onClick={() => setSecondaryMenuOpen(false)}>পরীক্ষা ও পৃষ্ঠার সেটিংস</a>
              </div>
            </aside>
          )}
          {isAdminPanel && <aside className="admin-sidebar" aria-label="অ্যাডমিন নেভিগেশন">
            <p className="eyebrow"><LayoutDashboard size={14} />অ্যাডমিন প্যানেল</p>
            <a href="#admin-dashboard"><LayoutDashboard size={14} />ড্যাশবোর্ড</a>
            <a href="#questions"><BookMarked size={14} />প্রশ্ন পরিচালনা</a>
            <button type="button" onClick={() => openQuestionUpload("MCQ")}><Upload size={14} />Question Upload · MCQ</button>
            <button type="button" onClick={() => { addAdminQuestion("MCQ"); document.getElementById("questions")?.scrollIntoView({ behavior: "smooth" }); }}><FilePlus2 size={14} />MCQ হাতে যোগ</button>
            <button type="button" onClick={() => { addAdminQuestion("CQ"); document.getElementById("questions")?.scrollIntoView({ behavior: "smooth" }); }}><FilePlus2 size={14} />CQ হাতে যোগ</button>
            <a href="#admin-user-statistics"><Users size={14} />ব্যবহারকারী পরিসংখ্যান</a>
          </aside>}
          <div className="mobile-pane-tabs" role="tablist" aria-label="কাজের প্যানেল">
            <button type="button" role="tab" aria-selected={activeMobilePane === "questions"} className={activeMobilePane === "questions" ? "selected" : ""} onClick={() => setActiveMobilePane("questions")}>প্রশ্ন</button>
            <button type="button" role="tab" aria-selected={activeMobilePane === "preview"} className={activeMobilePane === "preview" ? "selected" : ""} onClick={() => setActiveMobilePane("preview")}>প্রিভিউ</button>
          </div>
          <section className="editor-pane" id="editor">
            {editorToolbarTarget && createPortal(
              <div className="pane-heading paper-setup-heading">
                <div className="paper-identity">
                  <p className="eyebrow">{isAdminPanel ? "প্রশ্ন ব্যাংক ব্যবস্থাপনা" : isDemo ? "শুধু এই ব্রাউজারে · DEMO" : "নতুন প্রশ্নপত্র"}</p>
                  {isAdminPanel
                    ? <h1 className="pane-title">অ্যাডমিন প্যানেল</h1>
                    : <input className="paper-title-input" id="exam" aria-label="পরীক্ষার শিরোনাম" value={settings.exam} onChange={(event) => updateSettings("exam", event.target.value)} />}
                </div>
                <div className="workflow-picker toolbar-mode-picker" role="group" aria-label="প্রশ্নপত্রের ধরন">
                  <button
                    type="button"
                    className={`workflow-option${activeSection === "MCQ" ? " selected" : ""}`}
                    aria-label="MCQ প্রশ্নপত্র"
                    aria-pressed={activeSection === "MCQ"}
                    onClick={() => { resetGenerationSelection(); setPreviewPageIndex(0); setSettingsSaveStatus(null); setActiveSection("MCQ"); }}
                  ><FileText size={14} />MCQ</button>
                  <button
                    type="button"
                    className={`workflow-option${activeSection === "CQ" ? " selected" : ""}`}
                    aria-label="CQ প্রশ্নপত্র"
                    aria-pressed={activeSection === "CQ"}
                    onClick={() => {
                      resetGenerationSelection();
                      setPreviewPageIndex(0);
                      setSettingsSaveStatus(null);
                      setActiveSection("CQ");
                    }}
                  ><ClipboardList size={14} />CQ</button>
                </div>
                <div className="toolbar-actions">
                    <button className="button toolbar-settings-button" type="button" aria-label="পরীক্ষার সেটিংস" title="পরীক্ষার সেটিংস" aria-controls="paper-settings" onClick={() => {
                      if (isAdminPanel) {
                        setPaperSettingsOpen((open) => !open);
                        return;
                      }
                      router.push("/app/settings");
                    }}><Settings2 size={14} /><span>পরীক্ষার সেটিংস</span></button>
                    <button className="button" type="button" aria-label="DEMO প্রশ্নপত্র তৈরি / খুলুন" title="DEMO প্রশ্নপত্র তৈরি / খুলুন" onClick={loadDemo}>DEMO</button>
                    <button className="button primary" type="button" disabled={sectionPages.length === 0 || cqGenerationBlocked} onClick={printPaper}><Printer size={14} />PDF / প্রিন্ট</button>
                </div>
                {!isAdminPanel && <div className="document-format-controls" aria-label="ডকুমেন্ট ফরম্যাটিং নিয়ন্ত্রণ">
                  <p className="format-layout-note">কলাম · MCQ: ২ · CQ: ২ (ল্যান্ডস্কেপ)</p>
                  <div className="format-control-fields">
                    <div className="field"><label htmlFor="font-size">ফন্ট (pt)</label><input id="font-size" type="number" min="8" max="16" step="0.5" value={settings.fontSize} onChange={(event) => updateSettings("fontSize", Number(event.target.value))} /></div>
                    <div className="field"><label htmlFor="page-margin">মার্জিন (mm)</label><input id="page-margin" type="number" min="8" max="24" value={settings.margin} onChange={(event) => updateSettings("margin", Number(event.target.value))} /></div>
                    <div className="field"><label htmlFor="column-gap">CQ ব্যবধান (mm)</label><input id="column-gap" type="number" min="4" max="18" value={settings.columnGap} onChange={(event) => updateSettings("columnGap", Number(event.target.value))} /></div>
                    <div className="field"><label htmlFor="line-spacing">লাইন স্পেসিং</label><input id="line-spacing" type="number" min="1" max="2.5" step="0.1" value={settings.lineSpacing} onChange={(event) => updateSettings("lineSpacing", Number(event.target.value))} /></div>
                  </div>
                </div>}
              </div>,
              editorToolbarTarget,
            )}

            {!isAdminPanel && (<section className="section section-bank" id="question-bank">
              <h2 className="section-title"><Library size={15} />প্রশ্ন ব্যাংক থেকে যোগ করুন</h2>
              {questionBankFilters}
              {!user && <p className="bank-help">প্রশ্ন ব্যাংক থেকে প্রশ্ন নিতে সাইন ইন করুন।</p>}
              {!isAdminPanel && user && (
                <div className="bank-results">
                  {bankQuestions.filter((question) => question.kind === activeSection).map((question) => (
                    <div className="bank-result" key={question.serverId}>
                      <span data-no-translate>{question.kind === "MCQ" ? "MCQ" : "CQ"} · {question.text}</span>
                      <button
                        className="small-action"
                        type="button"
                        disabled={
                          questions.some((item) => item.serverId === question.serverId) ||
                          (activeSection === "CQ" && activeQuestions.length >= 12)
                        }
                        onClick={() => addBankQuestion(question)}
                      >{questions.some((item) => item.serverId === question.serverId)
                        ? "যুক্ত হয়েছে"
                        : activeSection === "CQ" && activeQuestions.length >= 12
                          ? "সীমা পূর্ণ"
                          : "পেপারে যোগ"}</button>
                    </div>
                  ))}
                  {bankQuestions.every((question) => question.kind !== activeSection) && <p className="bank-help">এই শ্রেণি/বিষয়/অধ্যায়/টপিকে কোনো {activeSection} প্রশ্ন নেই।</p>}
                </div>
              )}
            </section>)}

            {!isAdminPanel && user && (
              <section
                className="section generation-panel"
                id="generation-workflow"
                aria-label="প্রশ্নপত্র তৈরি ও টোকেন খরচ"
              >
                <h2 className="section-title"><ClipboardList size={15} />প্রশ্নপত্র তৈরি ও টোকেন খরচ</h2>
                <div className="token-summary" role="status">
                  <span>আপনার টোকেন ব্যালেন্স</span>
                  <strong>{tokenBalance} <span>টোকেন</span></strong>
                  <small>প্রতি প্রশ্নে MCQ {tokenRates.MCQ}, CQ {tokenRates.CQ}, Short {tokenRates.SHORT} টোকেন · সফল তৈরির পর ব্যালেন্স থেকে কাটা হবে</small>
                </div>
                <ol className="generation-progress" aria-label="প্রশ্নপত্র তৈরির ধাপ" aria-live="polite">
                  {generationSteps.map((step, index) => (
                    <li className={index === generationStep ? "current" : index < generationStep ? "complete" : ""} key={step}>
                      <span>{index < generationStep ? "✓" : index + 1}</span>
                      <small>{step}</small>
                    </li>
                  ))}
                </ol>
                <p className="generation-step-heading" aria-live="polite">
                  ধাপ {generationStep + 1} / {generationSteps.length}: {generationSteps[generationStep]}
                </p>
                <div className="workflow-picker generation-method-picker" role="group" aria-label="প্রশ্ন তৈরির পদ্ধতি">
                  {([
                    ["quick", "Quick Generate"],
                    ["manual", "Manual Selection"],
                    ["manual-create", "Manual Creation"],
                    ["blueprint", "Blueprint Generation"],
                    ["previous", "Previous Paper Based"],
                  ] as const).map(([method, label]) => (
                    <button
                      className={`workflow-option${creationMethod === method ? " selected" : ""}`}
                      type="button"
                      aria-pressed={creationMethod === method}
                      key={method}
                      onClick={() => selectCreationMethod(method)}
                    >{label}</button>
                  ))}
                </div>
                {generationCatalogError && <p className="generation-load-error" role="alert">{generationCatalogError}</p>}
                <div className="generation-step-panel">
                  {generationStep === 0 && (
                    <div className="field">
                      <label htmlFor="generator-class">শ্রেণি নির্বাচন করুন</label>
                      <select id="generator-class" value={generationClass} disabled={isLoadingGenerationClasses} onChange={(event) => {
                        resetGenerationSelection();
                        setGenerationCatalogError("");
                        setGenerationClass(event.target.value);
                        setIsLoadingGenerationSubjects(Boolean(event.target.value));
                        setGenerationSubject("");
                        setGenerationSubjects([]);
                        setGenerationCqSets((current) => current.map((set) => ({ ...set, chapters: [] })));
                      }}>
                        <option value="">{isLoadingGenerationClasses ? "শ্রেণি লোড হচ্ছে…" : "শ্রেণি বাছুন"}</option>
                        {generationCatalog.classes.map((item) => <option key={item} data-no-translate>{item}</option>)}
                      </select>
                      {!isLoadingGenerationClasses && generationCatalog.classes.length === 0 &&
                        <p className="bank-help">প্রশ্ন ব্যাংকে কোনো শ্রেণির প্রশ্ন পাওয়া যায়নি।</p>}
                    </div>
                  )}
                  {generationStep === 1 && (
                    <div className="field">
                      <label htmlFor="generator-subject">বিষয় নির্বাচন করুন</label>
                      <select id="generator-subject" value={generationSubject} disabled={isLoadingGenerationSubjects || !generationClass} onChange={(event) => {
                        resetGenerationSelection();
                        setGenerationCatalogError("");
                        setGenerationSubject(event.target.value);
                        setGenerationCqSets((current) => current.map((set) => ({ ...set, chapters: [] })));
                      }}>
                        <option value="">{isLoadingGenerationSubjects ? "বিষয় লোড হচ্ছে…" : "বিষয় বাছুন"}</option>
                        {generationSubjects.map((item) => <option key={item} data-no-translate>{item}</option>)}
                      </select>
                      {!isLoadingGenerationSubjects && generationClass && generationSubjects.length === 0 &&
                        <p className="bank-help">এই শ্রেণিতে কোনো বিষয় পাওয়া যায়নি।</p>}
                    </div>
                  )}
                  {generationStep === 2 && (
                    <>
                      <div className="generation-summary" aria-label="আপনার নির্বাচন">
                        <h3>আপনার নির্বাচন</h3>
                        <dl>
                          <div><dt>শ্রেণি</dt><dd>{generationClass}</dd></div>
                          <div><dt>বিষয়</dt><dd>{generationSubject}</dd></div>
                        </dl>
                      </div>
                      {(creationMethod === "quick" || creationMethod === "manual") && (
                        <div className="form-grid generation-settings">
                          <div className="field">
                            <label htmlFor="generator-mode">প্রশ্ন বাছাই পদ্ধতি</label>
                            <select id="generator-mode" value={generationMode} onChange={(event) => updateGenerationMode(event.target.value)}>
                              <option value="auto">স্বয়ংক্রিয়ভাবে প্রশ্ন বাছুন</option>
                              <option value="manual">নিজে প্রশ্ন বাছুন</option>
                            </select>
                          </div>
                          {creationMethod === "quick" && generationMode === "auto" &&
                            !(activeSection === "CQ" && generationCqSetCount > 0) && (
                            <div className="field">
                              <label htmlFor="generator-question-count">প্রশ্নের সংখ্যা</label>
                              <input id="generator-question-count" type="number" min={1} max={activeSection === "CQ" ? 12 : 500} value={generationQuestionCount} onChange={(event) => {
                                resetGenerationSelection();
                                setGenerationQuestionCount(Number(event.target.value));
                              }} />
                            </div>
                          )}
                          {creationMethod === "quick" && activeSection === "CQ" && (
                            <div className="field">
                              <label htmlFor="generator-cq-set-count">Set নির্বাচন</label>
                              <select
                                id="generator-cq-set-count"
                                value={generationCqSetCount}
                                onChange={(event) => updateGenerationCqSetCount(event.target.value)}
                              >
                                <option value={0}>Set 0</option>
                                <option value={2}>Set 2</option>
                                <option value={3}>Set 3</option>
                                <option value={4}>Set 4</option>
                              </select>
                            </div>
                          )}
                        </div>
                      )}
                      {creationMethod === "quick" && activeSection === "CQ" && generationMode === "auto" && generationCqSetCount > 0 && (
                        <div className="cq-set-list">
                          {Array.from({ length: generationCqSetCount }, (_, setIndex) => {
                            const set = generationCqSets[setIndex];
                            return (
                              <fieldset className="cq-set" key={`generator-cq-set-${setIndex}`}>
                                <legend>Set {setIndex + 1}</legend>
                                <div className="field">
                                  <label htmlFor={`generator-cq-set-count-${setIndex}`}>প্রশ্নের সংখ্যা</label>
                                  <input
                                    id={`generator-cq-set-count-${setIndex}`}
                                    type="number"
                                    min={1}
                                    max={12}
                                    value={set.questionCount}
                                    onChange={(event) => updateGenerationCqSet(setIndex, { questionCount: Number(event.target.value) })}
                                  />
                                </div>
                                <div className="cq-set-chapters">
                                  <strong>অধ্যায় নির্বাচন করুন</strong>
                                  {isLoadingGenerationChapters
                                    ? <p className="bank-help">অধ্যায় লোড হচ্ছে…</p>
                                    : generationChapters.length > 0
                                      ? generationChapters.map((chapter) => (
                                        <label className="cq-set-chapter" key={chapter}>
                                          <input
                                            type="checkbox"
                                            checked={set.chapters.includes(chapter)}
                                            onChange={(event) => toggleGenerationCqChapter(setIndex, chapter, event.target.checked)}
                                          />
                                          <span data-no-translate>{chapter}</span>
                                        </label>
                                      ))
                                      : <p className="bank-help">এই শ্রেণি ও বিষয়ে কোনো অধ্যায় পাওয়া যায়নি।</p>}
                                </div>
                              </fieldset>
                            );
                          })}
                          <p className={`bank-help ${generationCqSets.slice(0, generationCqSetCount).reduce((total, set) => total + set.questionCount, 0) > 12 ? "error-text" : ""}`}>
                            মোট প্রশ্ন: {generationCqSets.slice(0, generationCqSetCount).reduce((total, set) => total + set.questionCount, 0)} / ১২
                          </p>
                        </div>
                      )}
                      {creationMethod === "quick" && <p className="bank-help generator-help">
                        {activeSection === "CQ" && generationMode === "auto" && generationCqSetCount > 0
                          ? "প্রতিটি Set-এর জন্য নির্বাচিত অধ্যায় ও প্রশ্নসংখ্যা অনুযায়ী আলাদা প্রশ্ন বাছা হবে।"
                          : "নির্বাচিত শ্রেণি ও বিষয়ের প্রশ্ন থেকে নির্দিষ্ট সংখ্যক প্রশ্ন বাছা হবে।"}
                        {" "}খরচ নিশ্চিত করার আগে প্রিভিউ দেখানো হবে।
                      </p>}
                      {creationMethod === "manual" && <p className="bank-help generator-help">
                        প্রশ্ন ব্যাংক থেকে প্রশ্ন নির্বাচন করুন। নির্বাচিত প্রশ্নের ক্রম পরিবর্তন করে Preview-তে যাচাই করুন।
                      </p>}
                      {creationMethod === "blueprint" && (
                        <div className="blueprint-inputs">
                          <div className="form-grid generation-settings">
                            <div className="field">
                              <label htmlFor="blueprint-chapter">অধ্যায়</label>
                              <select id="blueprint-chapter" value={blueprintChapter} disabled={isLoadingBlueprintCatalog} onChange={(event) => {
                                setBlueprintChapter(event.target.value);
                                setBlueprintTopic("");
                                setGenerationPreview(null);
                              }}>
                                <option value="">অধ্যায় বাছুন</option>
                                {blueprintCatalog.chapters.map((chapter) => <option key={chapter} data-no-translate>{chapter}</option>)}
                              </select>
                            </div>
                            <div className="field">
                              <label htmlFor="blueprint-topic">টপিক (ঐচ্ছিক)</label>
                              <select id="blueprint-topic" value={blueprintTopic} disabled={!blueprintChapter || isLoadingBlueprintCatalog} onChange={(event) => {
                                setBlueprintTopic(event.target.value);
                                setGenerationPreview(null);
                              }}>
                                <option value="">সব টপিক</option>
                                {blueprintCatalog.topics.map((topic) => <option key={topic} data-no-translate>{topic}</option>)}
                              </select>
                            </div>
                            <div className="field">
                              <label htmlFor="blueprint-marks">প্রতি প্রশ্নের নম্বর</label>
                              <input id="blueprint-marks" type="number" min={1} max={1000} value={blueprintMarks} onChange={(event) => {
                                setBlueprintMarks(Number(event.target.value));
                                setGenerationPreview(null);
                              }} />
                            </div>
                          </div>
                          <fieldset className="blueprint-difficulty">
                            <legend>কঠিনতার স্তর অনুযায়ী প্রশ্নসংখ্যা</legend>
                            {(["easy", "medium", "hard"] as const).map((difficulty) => (
                              <label className="field" key={difficulty}>
                                <span>{difficulty === "easy" ? "Easy" : difficulty === "medium" ? "Medium" : "Hard"}</span>
                                <input
                                  aria-label={`${difficulty} প্রশ্নসংখ্যা`}
                                  type="number"
                                  min={0}
                                  max={activeSection === "CQ" ? 12 : 500}
                                  value={blueprintDifficultyCounts[difficulty]}
                                  onChange={(event) => {
                                    setBlueprintDifficultyCounts((current) => ({ ...current, [difficulty]: Number(event.target.value) }));
                                    setGenerationPreview(null);
                                  }}
                                />
                              </label>
                            ))}
                          </fieldset>
                          {isLoadingBlueprintCatalog && <p className="bank-help" role="status">অধ্যায় ও টপিক লোড হচ্ছে…</p>}
                          {blueprintCatalogError && <p className="generation-load-error" role="alert">{blueprintCatalogError}</p>}
                          <p className="bank-help">ব্লুপ্রিন্টে শুধু নির্বাচিত অধ্যায়, টপিক, নম্বর এবং DB-তে Easy/Medium/Hard হিসেবে চিহ্নিত প্রশ্নই বিবেচিত হবে।</p>
                        </div>
                      )}
                      {creationMethod === "previous" && (
                        <div className="previous-paper-inputs">
                          <div className="field">
                            <label htmlFor="previous-paper-select">পূর্বের প্রশ্নপত্র</label>
                            <select id="previous-paper-select" value={previousPaperId} disabled={!previousPapers || isLoadingPreviousPaper} onChange={(event) => setPreviousPaperId(event.target.value)}>
                              <option value="">{previousPapers === null ? "প্রশ্নপত্র লোড হচ্ছে…" : "প্রশ্নপত্র বাছুন"}</option>
                              {(previousPapers ?? []).filter((paper) => paper._count.items > 0).map((paper) => (
                                <option key={paper.id} value={paper.id} data-no-translate>{paper.title} · {paper._count.items}টি প্রশ্ন</option>
                              ))}
                            </select>
                          </div>
                          <button className="button" type="button" disabled={!previousPaperId || isLoadingPreviousPaper} onClick={() => void loadPreviousPaper(previousPaperId)}>
                            {isLoadingPreviousPaper ? "খোলা হচ্ছে…" : "পূর্বের প্রশ্নপত্র থেকে বাছুন"}
                          </button>
                          {previousPaperError && <p className="generation-load-error" role="alert">{previousPaperError}</p>}
                          {previousPaperQuestions.length > 0 && <p className="bank-help">একই প্রশ্নগুলো থেকে বাছাই, সাজানো ও বাদ দিয়ে নতুন প্রশ্নপত্র তৈরি করুন।</p>}
                        </div>
                      )}
                      {creationMethod === "manual-create" && (
                        <form className="manual-question-form" onSubmit={(event) => void createManualQuestion(event)}>
                          <div className="generation-summary" aria-label="প্রশ्नের শ্রেণি ও বিষয়">
                            <dl>
                              <div><dt>শ্রেণি</dt><dd>{generationClass || "নির্বাচন করুন"}</dd></div>
                              <div><dt>বিষয়</dt><dd>{generationSubject || "নির্বাচন করুন"}</dd></div>
                            </dl>
                          </div>
                          <div className="form-grid">
                            <div className="field"><label htmlFor="manual-question-group">বিভাগ</label><input id="manual-question-group" maxLength={60} value={settings.group} onChange={(event) => setSettings((current) => ({ ...current, group: event.target.value }))} /></div>
                            <div className="field"><label htmlFor="manual-question-chapter">অধ্যায়</label><input id="manual-question-chapter" maxLength={160} value={manualDraft.chapter ?? settings.chapter} onChange={(event) => setManualDraft((current) => ({ ...current, chapter: event.target.value }))} /></div>
                            <div className="field"><label htmlFor="manual-question-topic">টপিক</label><input id="manual-question-topic" maxLength={160} value={manualDraft.topic ?? settings.topic} onChange={(event) => setManualDraft((current) => ({ ...current, topic: event.target.value }))} /></div>
                            <div className="field"><label htmlFor="manual-question-marks">নম্বর</label><input id="manual-question-marks" type="number" min={1} max={1000} value={manualDraft.marks} onChange={(event) => setManualDraft((current) => ({ ...current, marks: Number(event.target.value) }))} /></div>
                            <div className="field"><label htmlFor="manual-question-difficulty">কঠিনতার স্তর</label><select id="manual-question-difficulty" value={manualDraft.difficulty ?? ""} onChange={(event) => setManualDraft((current) => ({ ...current, difficulty: event.target.value ? event.target.value as QuestionDifficulty : undefined }))}><option value="">নির্বাচন করুন</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></div>
                          </div>
                          <label className="field"><span>প্রশ্নের বিবরণ</span><textarea required maxLength={500} value={manualDraft.text} onChange={(event) => setManualDraft((current) => ({ ...current, text: event.target.value }))} /></label>
                          {activeSection === "MCQ" && <div className="options-editor">
                            {(manualDraft.options ?? ["", "", "", ""]).map((option, index) => (
                              <label className="option-input" key={`manual-option-${index}`}><span>{["ক", "খ", "গ", "ঘ"][index]}.</span><input maxLength={120} aria-label={`${index + 1} নম্বর বিকল্প`} value={option} onChange={(event) => setManualDraft((current) => {
                                const options = [...(current.options ?? ["", "", "", ""])];
                                options[index] = event.target.value;
                                return { ...current, options };
                              })} /></label>
                            ))}
                          </div>}
                          {activeSection === "CQ" && (manualDraft.subs ?? ["", "", "", ""]).map((sub, index) => (
                            <label className="option-input" key={`manual-sub-${index}`}><span>({["ক", "খ", "গ", "ঘ"][index]})</span><input maxLength={90} aria-label={`${index + 1} নম্বর উপপ্রশ্ন`} value={sub} onChange={(event) => setManualDraft((current) => {
                              const subs = [...(current.subs ?? ["", "", "", ""])];
                              subs[index] = event.target.value;
                              return { ...current, subs };
                            })} /></label>
                          ))}
                          <div className="form-grid">
                            <div className="field"><label htmlFor="manual-question-answer">উত্তর</label><textarea id="manual-question-answer" maxLength={120} value={manualDraft.answer ?? ""} onChange={(event) => setManualDraft((current) => ({ ...current, answer: event.target.value }))} /></div>
                            <div className="field"><label htmlFor="manual-question-explanation">ব্যাখ্যা</label><textarea id="manual-question-explanation" maxLength={120} value={manualDraft.explanation ?? ""} onChange={(event) => setManualDraft((current) => ({ ...current, explanation: event.target.value }))} /></div>
                          </div>
                          <label className="field"><span>প্রশ্নের ছবি (ঐচ্ছিক)</span><input type="file" accept="image/*" onChange={(event) => setManualImage(event.target.files?.[0] ?? null)} /></label>
                          {manualImage && <p className="bank-help" data-no-translate>{manualImage.name}</p>}
                          <p className="bank-help" role="status">
                            এই প্রশ্ন তৈরি করে পেপারে যোগের খরচ: {tokenRates[activeSection]} টোকেন
                            {tokenBalance < tokenRates[activeSection] ? " · পর্যাপ্ত ব্যালেন্স নেই" : ""}
                          </p>
                          {manualQuestionError && <p className="generation-load-error" role="alert">{manualQuestionError}</p>}
                          <button className="button primary" type="submit" disabled={isSavingManualQuestion || !generationClass || !generationSubject || tokenBalance < tokenRates[activeSection]}>
                            {isSavingManualQuestion ? "সংরক্ষণ হচ্ছে…" : "প্রশ্ন তৈরি করে পেপারে যোগ"}
                          </button>
                        </form>
                      )}
                    </>
                  )}
                </div>
                <div className="generation-navigation">
                  <button className="button" type="button" disabled={generationStep === 0} onClick={() => setGenerationStep((step) => Math.max(0, step - 1))}>পেছনে</button>
                  {generationStep < 2 && (
                    <button
                      className="button primary"
                      type="button"
                      disabled={
                        (generationStep === 0 && (!generationClass || isLoadingGenerationClasses)) ||
                        (generationStep === 1 && (!generationSubjects.includes(generationSubject) || isLoadingGenerationSubjects))
                      }
                      onClick={() => setGenerationStep((step) => Math.min(2, step + 1))}
                    >পরবর্তী ধাপ</button>
                  )}
                </div>
                <div className="question-data-actions">
                  {generationStep === 2 && creationMethod === "manual" && generationMode === "manual" && (
                    <button className="button" type="button" onClick={() => void requestGenerationPreview([])}>
                      প্রশ্নের তালিকা দেখুন
                    </button>
                  )}
                  {generationStep === 2 && generationMode === "auto" && (
                    <button className="button" type="button" onClick={() => void requestGenerationPreview()}>
                      {creationMethod === "blueprint" ? "ব্লুপ্রিন্ট যাচাই ও খরচ দেখুন" : "সম্ভাব্যতা ও খরচ দেখুন"}
                    </button>
                  )}
                  {generationStep === 2 && generationMode === "manual" &&
                    (creationMethod === "manual" || creationMethod === "previous") && generationSelectedIds.length > 0 && (
                    <button className="button" type="button" onClick={() => void requestGenerationPreview()}>
                      {creationMethod === "previous" ? "পূর্বের প্রশ্ন থেকে খরচের প্রিভিউ" : "খরচের প্রিভিউ"}
                    </button>
                  )}
                  {generationStep === 2 && creationMethod !== "manual-create" && generationPreview && (
                    <button className="button primary" type="button" disabled={isGenerating || generationPreview.estimatedTokens > generationPreview.balance} onClick={() => void generatePaper()}>
                      {isGenerating ? "তৈরি হচ্ছে…" : `প্রশ্নপত্র তৈরি · ${generationPreview.estimatedTokens} টোকেন`}
                    </button>
                  )}
                </div>
                {generationStep === 2 && creationMethod !== "manual-create" && generationPreview && (
                  <p className="bank-help" role="status">
                    নির্বাচিত প্রশ্ন: {generationPreview.questionIds.length}টি · মোট নম্বর: {generationPreview.totalMarks} · আনুমানিক খরচ: {generationPreview.estimatedTokens} টোকেন
                    {generationPreview.estimatedTokens > generationPreview.balance ? " · পর্যাপ্ত ব্যালেন্স নেই" : ""}
                  </p>
                )}
                {generationStep === 2 && generationError && (
                  <div className="csv-report" role="alert">
                    <strong>{translateUiText(generationError, language)}</strong>
                  </div>
                )}
                {generationStep === 2 && (creationMethod === "manual" || creationMethod === "previous" || generationPreview) && <div className="generator-question-list">
                  {(creationMethod === "previous" ? previousPaperQuestions : generationCandidates).map((question) => {
                    const selected = generationSelectedIds.includes(question.serverId ?? question.id);
                    return (
                      <div className="generator-question" key={question.id}>
                        {generationMode === "manual" && <input
                          type="checkbox"
                          aria-label={`${question.text} নির্বাচন`}
                          checked={selected}
                          disabled={!selected && activeSection === "CQ" && generationSelectedIds.length >= 12}
                          onChange={(event) => {
                            const id = question.serverId ?? question.id;
                            const checked = event.currentTarget.checked;
                            setGenerationSelectedIds((current) => checked
                              ? [...current, id]
                              : current.filter((item) => item !== id));
                            setGenerationPreview(null);
                          }}
                        />}
                        <span data-no-translate>{question.chapter} {question.topic ? `· ${question.topic}` : ""} · {question.text}</span>
                        <strong>{question.marks} নম্বর</strong>
                        {generationMode === "manual" && selected && <>
                          <button className="small-action" type="button" aria-label={`${question.text} উপরে নিন`} disabled={generationSelectedIds[0] === (question.serverId ?? question.id)} onClick={() => moveSelectedGenerationQuestion(question.serverId ?? question.id, -1)}>↑</button>
                          <button className="small-action" type="button" aria-label={`${question.text} নিচে নিন`} disabled={generationSelectedIds[generationSelectedIds.length - 1] === (question.serverId ?? question.id)} onClick={() => moveSelectedGenerationQuestion(question.serverId ?? question.id, 1)}>↓</button>
                          <button className="small-action" type="button" onClick={() => {
                            setGenerationSelectedIds((current) => current.filter((id) => id !== (question.serverId ?? question.id)));
                            setGenerationPreview(null);
                          }}>বাদ দিন</button>
                        </>}
                      </div>
                    );
                  })}
                  {generationMode === "manual" && (creationMethod === "previous" ? previousPaperQuestions.length : generationCandidates.length) > 0 && (
                    <p className="bank-help">নির্বাচিত: {generationSelectedIds.length}টি প্রশ্ন</p>
                  )}
                </div>}
                {generationStep === 2 && tokenTransactions.length > 0 && (
                  <details className="token-history">
                    <summary>সাম্প্রতিক টোকেন লেনদেন</summary>
                    {tokenTransactions.slice(0, 10).map((transaction, index) => (
                      <div key={`${transaction.createdAt}-${index}`}>
                        <span>{transaction.type === "CHARGE" ? transaction.paper?.title ?? "প্রশ্নপত্র তৈরি" : "অ্যাডমিন টোকেন যোগ"}</span>
                        <strong>{transaction.amount > 0 ? "+" : ""}{transaction.amount}</strong>
                      </div>
                    ))}
                  </details>
                )}
              </section>
            )}

            {editorToolbarTarget && isAdminPanel && createPortal(questionSettingsForm, editorToolbarTarget)}

            {!isAdminPanel && activeSection === "CQ" && (
              <>
                <div className="divider" />
                <section className="section">
                  <h2 className="section-title"><Settings2 size={15} />{translateUiText("CQ পৃষ্ঠা বিন্যাস", language)}</h2>
                  <div className="field cq-page-layout-field">
                    <label htmlFor="cq-page-layout">{translateUiText("CQ পৃষ্ঠা বিন্যাস", language)}</label>
                    <select id="cq-page-layout" value={cqPageLayout} onChange={(event) => updateCqPageLayout(event.target.value)}>
                      <option value="one">{translateUiText("১ পৃষ্ঠা", language)}</option>
                      <option value="two">{translateUiText("২ পৃষ্ঠা", language)}</option>
                    </select>
                  </div>
                </section>
              </>
            )}

            {isAdminPanel && <section className="admin-dashboard" id="admin-dashboard" aria-label="অ্যাডমিন ড্যাশবোর্ড">
              <div className="admin-dashboard-heading">
                <div className="admin-dashboard-welcome">
                  <span className="admin-dashboard-mark"><LayoutDashboard size={21} /></span>
                  <div>
                    <p className="eyebrow">প্রতিষ্ঠানের সারসংক্ষেপ</p>
                    <h2>স্বাগতম, {user?.name || "অ্যাডমিন"}</h2>
                    <p>প্রশ্ন ব্যাংক, ব্যবহারকারী এবং সাম্প্রতিক কার্যক্রম এক নজরে দেখুন।</p>
                  </div>
                </div>
                <button className={`button admin-dashboard-refresh${isLoadingAdminDashboard ? " is-loading" : ""}`} type="button" onClick={() => setDashboardRefresh((current) => current + 1)} disabled={isLoadingAdminDashboard} aria-label="ড্যাশবোর্ড রিফ্রেশ">
                  <RefreshCw size={15} />{isLoadingAdminDashboard ? "হালনাগাদ হচ্ছে…" : "রিফ্রেশ"}
                </button>
              </div>
              {isLoadingAdminDashboard && !adminDashboard && <p className="admin-dashboard-loading" role="status">ড্যাশবোর্ডের তথ্য লোড হচ্ছে…</p>}
              {isLoadingAdminDashboard && adminDashboard && <p className="admin-dashboard-refresh-status" role="status">সর্বশেষ তথ্য হালনাগাদ হচ্ছে…</p>}
              {adminDashboardError && <div className="csv-report admin-dashboard-error" role="alert">
                <strong>{translateUiText(adminDashboardError, language)}</strong>
                <button className="button" type="button" onClick={() => setDashboardRefresh((current) => current + 1)}>আবার চেষ্টা করুন</button>
              </div>}
              {academicDataError && <div className="csv-report" role="alert">
                <strong>{translateUiText(academicDataError, language)}</strong>
                <button className="button" type="button" onClick={() => setAcademicRefresh((current) => current + 1)}>আবার চেষ্টা করুন</button>
              </div>}
              {adminDashboard && <>
                <div className="admin-dashboard-stats">
                  {[
                    { label: "মোট প্রশ্ন", total: adminDashboard.totals.totalQuestions ?? 0, icon: <BookMarked size={17} />, tone: "questions" },
                    { label: "MCQ প্রশ্ন", total: adminDashboard.totals.mcqQuestions ?? 0, icon: <FileText size={17} />, tone: "mcq" },
                    { label: "CQ প্রশ্ন", total: adminDashboard.totals.cqQuestions ?? 0, icon: <ClipboardList size={17} />, tone: "cq" },
                    { label: "শ্রেণি", total: adminDashboard.totals.classes ?? 0, icon: <GraduationCap size={17} />, tone: "classes" },
                    { label: "বিষয়", total: adminDashboard.totals.subjects ?? 0, icon: <BookOpen size={17} />, tone: "subjects" },
                    { label: "অধ্যায়", total: adminDashboard.totals.chapters ?? 0, icon: <Library size={17} />, tone: "chapters" },
                    { label: "টপিক", total: adminDashboard.totals.topics ?? 0, icon: <Activity size={17} />, tone: "topics" },
                    { label: "নিবন্ধিত ব্যবহারকারী", total: adminDashboard.totals.registeredUsers ?? 0, icon: <Users size={17} />, tone: "users" },
                  ].map(({ label, total, icon, tone }) => (
                    <div className={`admin-dashboard-stat ${tone}`} key={label}>
                      <span className="admin-dashboard-stat-icon">{icon}</span>
                      <span>{label}</span><strong>{total.toLocaleString()}</strong>
                    </div>
                  ))}
                </div>

                <section className="admin-dashboard-panel admin-dashboard-quick-actions" aria-labelledby="admin-quick-actions">
                  <div className="admin-dashboard-panel-heading">
                    <div><p className="admin-dashboard-kicker">শর্টকাট</p><h3 id="admin-quick-actions">দ্রুত কাজ</h3></div>
                    <span>প্রশ্ন ব্যবস্থাপনা</span>
                  </div>
                  <div className="admin-dashboard-actions">
                    <button type="button" onClick={() => openQuestionUpload("MCQ")}><span><Upload size={18} /></span><strong>Question Upload · MCQ</strong></button>
                    <button type="button" onClick={() => { addAdminQuestion("MCQ"); document.getElementById("questions")?.scrollIntoView({ behavior: "smooth" }); }}><span><FilePlus2 size={18} /></span><strong>MCQ হাতে যোগ</strong></button>
                    <button type="button" onClick={() => { addAdminQuestion("CQ"); document.getElementById("questions")?.scrollIntoView({ behavior: "smooth" }); }}><span><FilePlus2 size={18} /></span><strong>CQ হাতে যোগ</strong></button>
                    <a href="#questions"><span><BookMarked size={18} /></span><strong>প্রশ্ন পরিচালনা</strong></a>
                    <a href="#admin-user-statistics" title="এখানে শুধু ব্যবহারকারী পরিসংখ্যান আছে; অ্যাকাউন্ট পরিচালনা নেই"><span><Users size={18} /></span><strong>ব্যবহারকারী দেখুন</strong></a>
                  </div>
                  {!adminDashboard.capabilities.userManagement && <p className="admin-dashboard-note">অ্যাডমিন ব্যবহারকারী ব্যবস্থাপনার আলাদা পৃষ্ঠা এই সিস্টেমে নেই; শর্টকাটটি নিবন্ধন ও ব্যবহারকারীর পরিসংখ্যানে নিয়ে যায়।</p>}
                </section>

                <div className="admin-dashboard-grid">
                  <section className="admin-dashboard-panel" aria-labelledby="admin-question-distribution">
                    <h3 id="admin-question-distribution">প্রশ্নের পরিসংখ্যান</h3>
                    {(adminDashboard.totals.mcqQuestions ?? 0) + (adminDashboard.totals.cqQuestions ?? 0) > 0
                      ? <div className="admin-dashboard-chart">
                        {[
                          { label: "MCQ", count: adminDashboard.totals.mcqQuestions ?? 0, color: "primary" },
                          { label: "CQ", count: adminDashboard.totals.cqQuestions ?? 0, color: "secondary" },
                        ].map((item) => {
                          const total = (adminDashboard.totals.mcqQuestions ?? 0) + (adminDashboard.totals.cqQuestions ?? 0);
                          return <div className="admin-chart-row" key={item.label}>
                            <span>{item.label}</span>
                            <div className="admin-chart-track"><span className={item.color} style={{ width: `${item.count / total * 100}%` }} /></div>
                            <strong>{item.count.toLocaleString()}</strong>
                          </div>;
                        })}
                        <div className="admin-dashboard-legend"><span><i className="mcq" />MCQ</span><span><i className="cq" />CQ</span></div>
                      </div>
                      : <p className="admin-dashboard-empty">এখনো কোনো MCQ বা CQ প্রশ্ন নেই</p>}
                    <div className="admin-dashboard-groups">
                      {[
                        { heading: "শ্রেণি অনুযায়ী", groups: adminDashboard.classDistribution },
                        { heading: "বিষয় অনুযায়ী", groups: adminDashboard.subjectDistribution },
                      ].map(({ heading, groups }) => (
                        <div key={heading}>
                          <h4>{heading}</h4>
                          {groups.length
                            ? groups.slice(0, 8).map((group) => (
                              <div className="admin-group-row" key={`${heading}-${group.name}`}><span data-no-translate>{group.name}</span><strong>{group.count}</strong></div>
                            ))
                            : <p className="admin-dashboard-empty">কোনো প্রশ্নের তথ্য নেই</p>}
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="admin-dashboard-panel" aria-labelledby="admin-question-trend">
                    <div className="admin-dashboard-panel-heading">
                      <div><p className="admin-dashboard-kicker">প্রশ্ন যোগ</p><h3 id="admin-question-trend">প্রশ্ন আপলোডের প্রবণতা</h3></div>
                      <span>গত ৩০ দিন</span>
                    </div>
                    {adminDashboard.questionUploadTrend.some((point) => point.mcqCount + point.cqCount > 0)
                      ? <>
                        <div className="admin-trend-chart admin-question-trend" role="img" aria-label="গত ৩০ দিনে প্রতিদিনের MCQ ও CQ প্রশ্ন যোগের সংখ্যা">
                          {(() => {
                            const peak = Math.max(...adminDashboard.questionUploadTrend.map((point) => point.mcqCount + point.cqCount), 1);
                            return adminDashboard.questionUploadTrend.map((point) => (
                              <span className="admin-trend-day" key={point.day} title={`${new Date(point.day).toLocaleDateString()}: MCQ ${point.mcqCount}, CQ ${point.cqCount}`}>
                                <i className="mcq" style={{ height: `${Math.max(point.mcqCount / peak * 100, point.mcqCount ? 7 : 0)}%` }} />
                                <i className="cq" style={{ height: `${Math.max(point.cqCount / peak * 100, point.cqCount ? 7 : 0)}%` }} />
                              </span>
                            ));
                          })()}
                        </div>
                        <div className="admin-dashboard-legend"><span><i className="mcq" />MCQ</span><span><i className="cq" />CQ</span></div>
                      </>
                      : <p className="admin-dashboard-empty">গত ৩০ দিনে কোনো প্রশ্ন যোগ করা হয়নি</p>}
                  </section>

                  <section className="admin-dashboard-panel" aria-labelledby="admin-registration-trend">
                    <h3 id="admin-registration-trend">নতুন নিবন্ধন · গত ৩০ দিন</h3>
                    {adminDashboard.registrationTrend.some((point) => point.count > 0)
                      ? <div className="admin-trend-chart" role="img" aria-label="গত ৩০ দিনে প্রতিদিনের নিবন্ধন সংখ্যা">
                        {(() => {
                          const peak = Math.max(...adminDashboard.registrationTrend.map((point) => point.count), 1);
                          return adminDashboard.registrationTrend.map((point) => (
                            <span key={point.day} title={`${new Date(point.day).toLocaleDateString()}: ${point.count}`} style={{ height: `${Math.max(point.count / peak * 100, point.count ? 8 : 2)}%` }} />
                          ));
                        })()}
                      </div>
                      : <p className="admin-dashboard-empty">এই সময়ে কোনো নতুন নিবন্ধন নেই</p>}
                    <div className="admin-dashboard-subheading" id="admin-user-statistics"><h4>সাম্প্রতিক ব্যবহারকারী</h4></div>
                    <div className="admin-user-session-stats">
                      <span>সক্রিয় সেশন <strong>{adminDashboard.totals.activeUsers ?? 0}</strong></span>
                      <span>সেশন নেই <strong>{adminDashboard.totals.inactiveUsers ?? 0}</strong></span>
                    </div>
                    {adminDashboard.recentUsers.length
                      ? <div className="admin-dashboard-list">
                        {adminDashboard.recentUsers.map((item) => <div key={item.id}>
                          <span><strong data-no-translate>{item.name}</strong><small data-no-translate>{item.email} · {item.role}</small></span>
                          <time>{new Date(item.createdAt).toLocaleDateString()}</time>
                        </div>)}
                      </div>
                      : <p className="admin-dashboard-empty">কোনো ব্যবহারকারী নেই</p>}
                    <p className="admin-dashboard-note">সক্রিয়/নিষ্ক্রিয় সংখ্যা মেয়াদোত্তীর্ণ নয় এমন সেশন থেকে গণনা করা; এটি অ্যাকাউন্ট চালু/বন্ধ অবস্থা নয়। লগইন অডিট ইতিহাস ও আলাদা ব্যবহারকারী ব্যবস্থাপনা নেই।</p>
                  </section>

                  <section className="admin-dashboard-panel admin-dashboard-wide">
                    <div className="admin-dashboard-panel-heading admin-recent-question-heading">
                      <div><p className="admin-dashboard-kicker">প্রশ্ন ব্যাংক</p><h3>সাম্প্রতিক প্রশ্ন</h3></div>
                      <div className="admin-dashboard-filter" role="group" aria-label="সাম্প্রতিক প্রশ্নের ধরন">
                        <button type="button" className={dashboardQuestionType === "MCQ" ? "selected" : ""} aria-pressed={dashboardQuestionType === "MCQ"} onClick={() => setDashboardQuestionType("MCQ")}>MCQ</button>
                        <button type="button" className={dashboardQuestionType === "CQ" ? "selected" : ""} aria-pressed={dashboardQuestionType === "CQ"} onClick={() => setDashboardQuestionType("CQ")}>CQ</button>
                      </div>
                    </div>
                    {(dashboardQuestionType === "MCQ" ? adminDashboard.recentMcqQuestions : adminDashboard.recentCqQuestions).length
                      ? <div className="admin-dashboard-table-wrap"><table className="admin-dashboard-table">
                        <thead><tr><th>প্রশ্ন</th><th>ধরন</th><th>শ্রেণি · বিষয়</th><th>অধ্যায়</th><th>যোগ করেছেন</th><th>সময়</th></tr></thead>
                        <tbody>{(dashboardQuestionType === "MCQ" ? adminDashboard.recentMcqQuestions : adminDashboard.recentCqQuestions).map((question) => <tr key={question.id}>
                          <td data-no-translate>{dashboardQuestionText(question.content).slice(0, 110)}</td>
                          <td>{question.type}</td><td data-no-translate>{question.classLevel} · {question.subject}</td>
                          <td data-no-translate>{question.chapter}</td><td data-no-translate>{question.author.name}</td>
                          <td><time>{new Date(question.createdAt).toLocaleDateString()}</time></td>
                        </tr>)}</tbody>
                      </table></div>
                      : <p className="admin-dashboard-empty">এখনো কোনো {dashboardQuestionType} প্রশ্ন যোগ করা হয়নি</p>}
                  </section>

                  <section className="admin-dashboard-panel">
                    <h3>প্রশ্ন আপলোডের ইতিহাস</h3>
                    <div className="admin-upload-summary">
                      <div><span>পূর্বের CSV আমদানি</span><strong>{adminDashboard.uploadStats.attempts}</strong></div>
                      <div><span>সফল সারি</span><strong>{adminDashboard.uploadStats.importedRows}</strong></div>
                      <div><span>ব্যর্থ সারি</span><strong>{adminDashboard.uploadStats.failedRows}</strong></div>
                      <div><span>ডুপ্লিকেট</span><strong>{adminDashboard.uploadStats.duplicateRows}</strong></div>
                    </div>
                    <div className="admin-dashboard-subheading"><h4>ঐতিহাসিক CSV আমদানি</h4></div>
                    {adminDashboard.recentImports.length
                      ? <div className="admin-dashboard-list">
                        {adminDashboard.recentImports.slice(0, 5).map((item) => <div key={item.id}>
                          <span><strong data-no-translate>{item.filename} · {item.questionType}</strong><small>{item.importedRows}/{item.totalRows} সফল · {item.failedRows} ব্যর্থ · {item.status}</small></span>
                          <time>{new Date(item.createdAt).toLocaleDateString()}</time>
                        </div>)}
                      </div>
                      : <p className="admin-dashboard-empty">কোনো পুরোনো CSV আমদানির রেকর্ড নেই</p>}
                    <div className="admin-dashboard-subheading"><h4>সাম্প্রতিক ম্যানুয়াল প্রশ্ন</h4></div>
                    {adminDashboard.recentManualUploads.length
                      ? <div className="admin-dashboard-list">
                        {adminDashboard.recentManualUploads.slice(0, 5).map((item) => <div key={item.id}>
                          <span><strong>{item.action === "CREATE_QUESTION" ? "প্রশ্ন যোগ" : item.action}</strong><small data-no-translate>{item.admin.name || item.admin.email}</small></span>
                          <time>{new Date(item.createdAt).toLocaleDateString()}</time>
                        </div>)}
                      </div>
                      : <p className="admin-dashboard-empty">কোনো ম্যানুয়াল আপলোড রেকর্ড নেই</p>}
                    <p className="admin-dashboard-note">CSV ফলাফল আমদানি রেকর্ড থেকে গণনা করা। ম্যানুয়াল আপলোডের ব্যর্থতার ইতিহাস সংরক্ষিত হয় না।</p>
                  </section>

                  <section className="admin-dashboard-panel">
                    <h3>সাম্প্রতিক অ্যাডমিন কার্যক্রম</h3>
                    {adminDashboard.recentActivities.length
                      ? <div className="admin-dashboard-list">
                        {adminDashboard.recentActivities.map((item) => <div key={item.id}>
                          <span><strong>{item.action}</strong><small>{item.entityType} · {item.admin.name || item.admin.email}</small></span>
                          <time>{new Date(item.createdAt).toLocaleDateString()}</time>
                        </div>)}
                      </div>
                      : <p className="admin-dashboard-empty">কোনো কার্যক্রম রেকর্ড নেই</p>}
                    <p className="admin-dashboard-note">লগইন কার্যক্রমের অডিট রেকর্ড নেই।</p>
                  </section>
                </div>
              </>}
            </section>}

            <div className="divider" />

            <section className="section" id="questions">
              <div className="section-head">
                <h2 className="section-title"><FileText size={15} />{isAdminPanel ? "প্রশ্ন ব্যাংক · সমৃদ্ধ সম্পাদনা" : "প্রশ্নপত্রের প্রশ্ন"}</h2>
                <span className="paper-count">{isAdminPanel ? editedQuestions.length : activeQuestions.length}টি প্রশ্ন</span>
                <label className="small-action"><Search size={13} /><input aria-label="প্রশ্ন খুঁজুন" placeholder="খুঁজুন" value={search} onChange={(event) => { setAdminOffset(0); setSearch(event.target.value); }} /></label>
              </div>
              {isAdminPanel && questionBankFilters}
              {isAdminPanel && (
                <div className="question-data-actions admin-bulk-actions">
                  <button className="button" type="button" onClick={() => {
                    const visibleIds = visibleQuestions.flatMap((question) => question.serverId ? [question.serverId] : []);
                    setSelectedAdminQuestionIds((current) => current.length === visibleIds.length ? [] : visibleIds);
                  }}>{selectedAdminQuestionIds.length ? "নির্বাচন বাতিল" : "এই তালিকার সব নির্বাচন"}</button>
                  <button className="button danger" type="button" disabled={!selectedAdminQuestionIds.length || isDeletingAdminQuestions} onClick={() => void deleteSelectedAdminQuestions()}>
                    {isDeletingAdminQuestions ? "মুছছে…" : `নির্বাচিত ${selectedAdminQuestionIds.length}টি মুছুন`}
                  </button>
                </div>
              )}
              {!isAdminPanel && (
                <div className="question-data-actions" role="group" aria-label="প্রশ্নপত্রের খসড়া">
                  <button className="button secondary" type="button" onClick={loadDraft}><BookOpen size={14} />খসড়া খুলুন</button>
                  <button className="button secondary" type="button" onClick={saveDraft}><Save size={14} />প্রশ্নপত্র সংরক্ষণ</button>
                </div>
              )}
              {isAdminPanel && (
                <>
                  <details className="admin-import">
                    <summary>একাডেমিক তথ্য পরিচালনা</summary>
                        <div className="admin-import-content">
                          <form className="question-data-actions" onSubmit={(event) => void createAcademicEntry(event)}>
                            <select aria-label="একাডেমিক তথ্যের ধরন" value={academicType} onChange={(event) => { setAcademicType(event.target.value); setAcademicParentId(""); }}>
                              <option value="CLASS">শ্রেণি</option><option value="GROUP">বিভাগ / গ্রুপ</option>
                              <option value="SUBJECT">বিষয়</option><option value="CHAPTER">অধ্যায়</option>
                              <option value="TOPIC">টপিক</option><option value="DIVISION">CQ বিভাগ</option>
                            </select>
                            <input required maxLength={160} aria-label="একাডেমিক নাম" placeholder="নাম" value={academicName} onChange={(event) => setAcademicName(event.target.value)} />
                            {academicType !== "CLASS" && (
                              <select required aria-label="অভিভাবক একাডেমিক তথ্য" value={academicParentId} onChange={(event) => setAcademicParentId(event.target.value)}>
                                <option value="">অভিভাবক নির্বাচন করুন</option>
                                {academicEntries.filter((entry) => entry.type === ({
                                  GROUP: "CLASS", SUBJECT: "GROUP", CHAPTER: "SUBJECT", TOPIC: "CHAPTER", DIVISION: "CLASS",
                                } as Record<string, string>)[academicType]).map((entry) => (
                                  <option key={entry.id} value={entry.id} data-no-translate>{entry.name}</option>
                                ))}
                              </select>
                            )}
                            <button className="button" type="submit">যোগ করুন</button>
                          </form>
                          <div className="admin-academic-list">
                            {academicEntries.map((entry) => (
                              <span key={entry.id}>{entry.type}: <span data-no-translate>{entry.name}</span>
                                <button type="button" aria-label={`${entry.name} মুছুন`} onClick={() => void deleteAcademicEntry(entry.id)}>×</button>
                              </span>
                            ))}
                          </div>
                        </div>
                  </details>
                  <AdminQuestionUpload
                    initialType={questionUploadType}
                    onTypeChange={setQuestionUploadType}
                    onSaved={() => {
                      setBankRefresh((value) => value + 1);
                      setDashboardRefresh((value) => value + 1);
                      setAdminOffset(0);
                      setSearch("");
                      setTypeFilter("");
                    }}
                  />
                  <details className="admin-import" id="admin-exports">
                    <summary><Download size={15} />প্রশ্ন রপ্তানি</summary>
                    <div className="admin-import-content question-data-actions">
                      <button className="button" type="button" onClick={() => void exportCsv()}><Download size={14} />CSV রপ্তানি</button>
                      <button className="button" type="button" onClick={() => void exportXlsx()}><FileSpreadsheet size={14} />XLSX রপ্তানি</button>
                    </div>
                  </details>
                  <form className="token-grant-form" onSubmit={(event) => void grantTokens(event)}>
                    <strong>অ্যাকাউন্টে টোকেন যোগ</strong>
                    <input type="email" required maxLength={254} aria-label="শিক্ষকের ইমেইল" placeholder="শিক্ষকের ইমেইল" value={grantEmail} onChange={(event) => setGrantEmail(event.target.value)} />
                    <input type="number" required min={1} max={1000000} aria-label="টোকেন সংখ্যা" value={grantAmount} onChange={(event) => setGrantAmount(Number(event.target.value))} />
                    <button className="button" type="submit">টোকেন দিন</button>
                  </form>
                </>
              )}
              {isAdminPanel && isLoadingAdminQuestions && <p className="bank-help" role="status">প্রশ্ন ব্যাংক লোড হচ্ছে…</p>}
              {isAdminPanel && adminQuestionError && <div className="csv-report" role="alert">
                <strong>{translateUiText(adminQuestionError, language)}</strong>
                <button className="button" type="button" onClick={() => setBankRefresh((current) => current + 1)}>আবার চেষ্টা করুন</button>
              </div>}
              <div className="question-list">
                {visibleQuestions.map((question) => {
                  const index = editedQuestions.findIndex((item) => item.id === question.id);
                  return (
                    <article className="question-card" key={question.id}>
                      <div className="question-card-top">
                        <div className="question-kind"><span className="question-number">{index + 1}</span>{question.kind === "MCQ" ? "বহুনির্বাচনি" : "সৃজনশীল"}</div>
                        <div className="question-tools">
                          {isAdminPanel && question.serverId && <input
                            type="checkbox"
                            aria-label={`প্রশ্ন ${index + 1} নির্বাচন করুন`}
                            checked={selectedAdminQuestionIds.includes(question.serverId)}
                            onChange={(event) => setSelectedAdminQuestionIds((current) => event.target.checked
                              ? [...current, question.serverId!]
                              : current.filter((id) => id !== question.serverId))}
                          />}
                          {isAdminPanel && <button
                            type="button"
                            title="প্রশ্ন ব্যাংকে সংরক্ষণ"
                            aria-label="প্রশ্ন ব্যাংকে সংরক্ষণ"
                            aria-busy={savingAdminQuestionIds.includes(question.id)}
                            disabled={savingAdminQuestionIds.includes(question.id)}
                            onClick={() => void saveAdminQuestion(question)}
                          ><Save size={14} /></button>}
                          <button type="button" title="প্রশ্ন মুছুন" aria-label="প্রশ্ন মুছুন" onClick={() => isAdminPanel
                            ? void deleteAdminQuestion(question)
                            : setQuestions((current) => current.filter((item) => item.id !== question.id))}><Trash2 size={14} /></button>
                        </div>
                      </div>
                      <div className="question-fields">
                        {isAdminPanel && (
                          <>
                          <div className="field"><label htmlFor={`question-type-${question.id}`}>প্রশ্নের ধরন</label><select id={`question-type-${question.id}`} value={question.kind} onChange={(event) => {
                            const kind = event.target.value as QuestionKind;
                            if (typeFilter && typeFilter !== kind) setTypeFilter("");
                            updateQuestion(question.id, {
                              kind,
                              options: kind === "MCQ" ? question.options ?? ["", "", "", ""] : undefined,
                              subs: kind === "CQ" ? question.subs ?? ["", "", "", ""] : undefined,
                            });
                          }}><option value="MCQ">MCQ</option><option value="CQ">CQ</option></select></div>
                          <div className="form-grid">
                            <div className="field"><label>শ্রেণি</label><input value={question.classLevel ?? classFilter} onChange={(event) => updateQuestion(question.id, { classLevel: event.target.value })} /></div>
                            <div className="field"><label>বিভাগ</label><input value={question.group ?? groupFilter} onChange={(event) => updateQuestion(question.id, { group: event.target.value })} /></div>
                            <div className="field"><label>বিষয়</label><input value={question.subject ?? subjectFilter} onChange={(event) => updateQuestion(question.id, { subject: event.target.value })} /></div>
                            <div className="field"><label>অধ্যায়</label><input value={question.chapter ?? chapterFilter} onChange={(event) => updateQuestion(question.id, { chapter: event.target.value })} /></div>
                            <div className="field wide"><label>টপিক</label><input value={question.topic ?? topicFilter} onChange={(event) => updateQuestion(question.id, { topic: event.target.value })} /></div>
                          </div>
                        <RichTextEditor
                          label="প্রশ্নের বিবরণ"
                          value={question.text}
                          onChange={(text) => updateQuestion(question.id, { text })}
                        />
                        {question.kind === "MCQ" && (
                          <div className="options-editor">
                            {(question.options ?? []).map((option, optionIndex) => (
                              <label className="option-input" key={`${question.id}-edit-${optionIndex}`}><span>{["ক", "খ", "গ", "ঘ"][optionIndex]}.</span><input maxLength={120} aria-label={`${optionIndex + 1} নম্বর বিকল্প`} placeholder="বিকল্প" value={option} onChange={(event) => {
                                const options = [...(question.options ?? [])];
                                options[optionIndex] = event.target.value;
                                updateQuestion(question.id, { options });
                              }} /></label>
                            ))}
                          </div>
                        )}
                        {question.kind === "CQ" && (question.subs ?? []).map((sub, subIndex) => (
                          <label className="option-input" key={`${question.id}-subedit-${subIndex}`}><span>({["ক", "খ", "গ", "ঘ"][subIndex]})</span><input maxLength={90} aria-label={`${subIndex + 1} নম্বর উপপ্রশ্ন`} placeholder="উপপ্রশ্ন" value={sub} onChange={(event) => {
                            const subs = [...(question.subs ?? [])];
                            subs[subIndex] = event.target.value;
                            updateQuestion(question.id, { subs });
                          }} /></label>
                        ))}
                        {question.kind === "CQ" && <div className="demo-question-actions"><button className="small-action" type="button" onClick={() => updateQuestion(question.id, { diagram: question.diagram ? undefined : "plant-cell" })}>{question.diagram ? "উদ্ভিদ কোষের চিত্র সরান" : "উদ্ভিদ কোষের লেবেলচিত্র যোগ"}</button></div>}
                        {question.table && (
                          <div className="table-editor">
                            <div className="table-editor-row">{question.table.headers.map((header, columnIndex) => <input key={`${question.id}-th-${columnIndex}`} aria-label={`সারণির শিরোনাম ${columnIndex + 1}`} value={header} onChange={(event) => { const table = { ...question.table!, headers: [...question.table!.headers] }; table.headers[columnIndex] = event.target.value; updateQuestion(question.id, { table }); }} />)}</div>
                            {question.table.rows.map((row, rowIndex) => <div className="table-editor-row" key={`${question.id}-tr-${rowIndex}`}>{row.map((cell, columnIndex) => <input key={`${question.id}-${rowIndex}-${columnIndex}`} aria-label={`সারণির ঘর ${rowIndex + 1}, ${columnIndex + 1}`} value={cell} onChange={(event) => { const table = { ...question.table!, rows: question.table!.rows.map((cells) => [...cells]) }; table.rows[rowIndex][columnIndex] = event.target.value; updateQuestion(question.id, { table }); }} />)}</div>)}
                            <button className="small-action" type="button" onClick={() => updateQuestion(question.id, { table: { ...question.table!, rows: [...question.table!.rows, question.table!.headers.map(() => "")] } })}>সারণির পঙ্‌ক্তি যোগ</button>
                          </div>
                        )}
                        <div className="answer-line"><label htmlFor={`answer-${question.id}`}>উত্তর / সমাধান</label><input maxLength={120} id={`answer-${question.id}`} value={question.answer ?? ""} onChange={(event) => updateQuestion(question.id, { answer: event.target.value })} /></div>
                        <div className="equation-editor"><label>সমীকরণ</label><MathEditor value={question.equation ?? ""} onChange={(equation) => updateQuestion(question.id, { equation })} /></div>
                        <button className="small-action" type="button" onClick={() => updateQuestion(question.id, { table: question.table ? undefined : { headers: ["শিরোনাম ১", "শিরোনাম ২"], rows: [["", ""], ["", ""]] } })}>{question.table ? "সারণি সরান" : "তথ্যসারণি যোগ"}</button>
                        <div className="answer-line"><label htmlFor={`explanation-${question.id}`}>ব্যাখ্যা</label><input maxLength={120} id={`explanation-${question.id}`} value={question.explanation ?? ""} onChange={(event) => updateQuestion(question.id, { explanation: event.target.value })} /></div>
                        <label className="small-action image-upload"><Upload size={13} />চিত্র যুক্ত করুন<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(question.id, file); event.currentTarget.value = ""; }} /></label>
                        {(question.imageUrls?.length ? question.imageUrls : question.imageUrl ? [question.imageUrl] : []).map((imageUrl, imageIndex) => (
                          <Image className="editor-diagram" key={`${question.id}-editor-image-${imageIndex}`} src={imageUrl} alt={`প্রশ্নের চিত্র ${imageIndex + 1}`} width={240} height={160} unoptimized />
                        ))}
                        <div className="question-foot">
                          <label className="break-toggle"><input type="checkbox" checked={question.breakAfter ?? false} onChange={(event) => updateQuestion(question.id, { breakAfter: event.target.checked })} />এর পরে নতুন পৃষ্ঠা</label>
                          <label className="marks-input">নম্বর <input type="number" min="0" value={question.marks} onChange={(event) => updateQuestion(question.id, { marks: Number(event.target.value) })} /></label>
                        </div>
                          </>
                        )}
                        {!isAdminPanel && (
                          <div className="question-readonly">
                            <p>{question.text}</p>
                            <span>{question.kind === "CQ" ? question.chapter || "অধ্যায় নির্ধারিত নয়" : question.options?.filter(Boolean).length ? `${question.options?.filter(Boolean).length}টি বিকল্প` : "MCQ"}</span>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              {isAdminPanel && adminQuestionTotal > 100 && <div className="add-row" aria-label="প্রশ্ন ব্যাংক পৃষ্ঠা">
                <button className="button" disabled={adminOffset === 0} onClick={() => setAdminOffset((offset) => Math.max(0, offset - 100))}>আগের পৃষ্ঠা</button>
                <span className="bank-help">{adminOffset + 1}–{Math.min(adminOffset + 100, adminQuestionTotal)} / {adminQuestionTotal}</span>
                <button className="button" disabled={adminOffset + 100 >= adminQuestionTotal} onClick={() => setAdminOffset((offset) => offset + 100)}>পরের পৃষ্ঠা</button>
              </div>}
              {isAdminPanel && <div className="add-row">
                <button className="button" onClick={() => addAdminQuestion("MCQ")}><Plus size={14} />বহুনির্বাচনি যোগ</button>
                <button className="button" onClick={() => addAdminQuestion("CQ")}><Plus size={14} />সৃজনশীল যোগ</button>
              </div>}
            </section>

          </section>

          <section className="preview-pane" id="preview">
            <div className={`preview-toolbar${isAdminPanel ? "" : " question-preview-navbar"}`}>
              {!isAdminPanel && <div className="editor-toolbar-content" ref={setEditorToolbarElement} />}
              <div className="preview-tools">
                <span className="preview-format">{activeSection === "MCQ" ? "A4 · দুই কলাম" : "A4 ল্যান্ডস্কেপ · দুই কলাম"}</span>
                <div className="preview-page-navigation" role="group" aria-label="প্রিভিউ পৃষ্ঠা নেভিগেশন">
                  <button
                    className="button preview-icon-button"
                    type="button"
                    aria-label="আগের পৃষ্ঠা"
                    disabled={currentPreviewPageIndex <= 0}
                    onClick={() => {
                      const nextPage = Math.max(0, currentPreviewPageIndex - 1);
                      setPreviewPageIndex(nextPage);
                      window.requestAnimationFrame(() => previewPagesRef.current?.children.item(nextPage)?.scrollIntoView({ block: "start" }));
                    }}
                  ><ChevronLeft size={15} /></button>
                  <span className="preview-page-count" aria-live="polite">{sectionPages.length ? currentPreviewPageIndex + 1 : 0} / {sectionPages.length}</span>
                  <button
                    className="button preview-icon-button"
                    type="button"
                    aria-label="পরের পৃষ্ঠা"
                    disabled={currentPreviewPageIndex >= sectionPages.length - 1}
                    onClick={() => {
                      const nextPage = Math.min(sectionPages.length - 1, currentPreviewPageIndex + 1);
                      setPreviewPageIndex(nextPage);
                      window.requestAnimationFrame(() => previewPagesRef.current?.children.item(nextPage)?.scrollIntoView({ block: "start" }));
                    }}
                  ><ChevronRight size={15} /></button>
                </div>
                <div className="preview-zoom-controls" role="group" aria-label="প্রিভিউ জুম">
                  <button className="button preview-icon-button" type="button" aria-label="জুম কমান" disabled={previewZoom <= 0.6} onClick={() => setPreviewZoom((zoom) => Math.max(0.6, Math.round((zoom - 0.1) * 10) / 10))}><Minus size={14} /></button>
                  <span className="preview-zoom-level" aria-live="polite">{Math.round(previewZoom * 100)}%</span>
                  <button className="button preview-icon-button" type="button" aria-label="জুম বাড়ান" disabled={previewZoom >= 1.4} onClick={() => setPreviewZoom((zoom) => Math.min(1.4, Math.round((zoom + 0.1) * 10) / 10))}><Plus size={14} /></button>
                </div>
                <button className={`button${showAnswers ? " primary" : ""}`} onClick={() => updateShowAnswers(!showAnswers)}><Check size={14} />{showAnswers ? "প্রশ্নপত্র" : "উত্তরপত্র"}</button>
                <button className="button" disabled={sectionPages.length === 0 || cqGenerationBlocked} onClick={() => printPaperVersion(false)}><Printer size={14} />{activeSection} PDF</button>
                <button className="button primary" disabled={sectionPages.length === 0 || cqGenerationBlocked} onClick={() => printPaperVersion(true)}><Printer size={14} />{activeSection} উত্তরসূচি</button>
              </div>
            </div>
            <div className="preview-scroll-content">
              {activeSection === "CQ" && (
                <div className={`cq-limit-status${cqGenerationBlocked ? " exceeded" : ""}`} role={cqGenerationBlocked ? "alert" : "status"}>
                  <span>CQ প্রশ্ন: {activeQuestions.length}/12</span>
                  <span>{translateUiText(
                    cqPageLayout === "one"
                      ? printCqOnePagePages.length && cqLayoutFits ? "পৃষ্ঠা: ১/১" : "পৃষ্ঠা: ০/১"
                      : `বুকলেট পৃষ্ঠা: ${printCqPages.length ? "২/২" : "০/২"}`,
                    language,
                  )}</span>
                  {cqQuestionLimitExceeded && <strong>সর্বোচ্চ ১২টি CQ প্রশ্ন রাখা যাবে। PDF তৈরি করতে প্রশ্ন কমান।</strong>}
                  {!cqQuestionLimitExceeded && cqPageLimitExceeded && <strong>{cqPageLayout === "one"
                    ? translateUiText("সব CQ প্রশ্ন এক পৃষ্ঠার দুই কলামে ফিট হচ্ছে না। প্রশ্ন বা বিন্যাস কমান।", language)
                    : translateUiText("সব প্রশ্ন নির্ধারিত দুই পৃষ্ঠার চারটি section-এ ফিট হচ্ছে না। প্রশ্ন বা বিন্যাস কমান.", language)}</strong>}
                </div>
              )}
              <div className={`page-stack${activeSection === "CQ" ? " page-stack-cq-preview" : ""}`} ref={previewPagesRef} style={{ "--preview-zoom": previewZoom } as CSSProperties}>
                {activeSection === "CQ" && cqPageLayout === "one" && !cqLayoutFits
                  ? <div className="section-empty" role="alert">{translateUiText("এক পৃষ্ঠার দুই কলামে সব প্রশ্ন ফিট হচ্ছে না। CQ Page Layout বা প্রশ্নের বিন্যাস পরিবর্তন করুন।", language)}</div>
                  : sectionPages.map((page, pageIndex) => activeSection === "CQ" && cqPageLayout === "one"
                    ? renderCqOnePage(page, pageIndex)
                    : renderPaperPage(page, pageIndex, activeSection))}
                {sectionPages.length === 0 && <div className="section-empty">{activeSection} বিভাগে এখনো কোনো প্রশ্ন যোগ করা হয়নি।</div>}
              </div>
            </div>
            {activeSection === "CQ" && (
              <div className="page-stack-print">
                {cqPageLayout === "one"
                  ? cqLayoutFits && !cqQuestionLimitExceeded
                    ? printCqOnePagePages.map((page, pageIndex) => renderCqOnePage(page, pageIndex, true))
                    : null
                  : printCqPages.map((page, pageIndex) => renderPaperPage(page, pageIndex, "CQ-print", true))}
              </div>
            )}
            <div className="measure-layer" ref={measureRef} style={measureStyle} aria-hidden="true">
              <article
                className="paper-page paper-page-cq paper-page-cq-single"
                style={{
                  ...paperStyle,
                  width: "297mm",
                  height: "auto",
                  minHeight: 0,
                  overflow: "visible",
                }}
              >
                <div className="paper-intro cq-single-intro">
                  {renderPaperHeading(cqOnePageHeadingRef)}
                </div>
              </article>
              {questionFragments.map((fragment) => (
                <div
                  data-measure-id={fragment.id}
                  key={fragment.id}
                  style={{ width: `${fragment.question.kind === "MCQ" ? mcqWidth : cqWidth}px` }}
                >
                  <PaperQuestion
                    question={fragment.question}
                    number={fragment.number}
                    subquestionIndexes={fragment.subquestionIndexes}
                    showImage={fragment.showImage}
                    showDetails={fragment.showDetails}
                    showAnswers={showAnswers}
                    showPrompt={fragment.startSubIndex === 0}
                    onMathFieldReady={handleReadOnlyMathFieldReady}
                  />
                </div>
              ))}
            </div>
          </section>
          </>}
        </div>
      </section>
      {toast && <div className="toast" role="status">{translateUiText(toast, language)}</div>}
      <div className="sr-only" aria-live="polite">{questions.length}টি প্রশ্ন, মোট নম্বর {totalMarks}</div>
    </main>
  );
}

function PlantCellDiagram() {
  return (
    <svg className="biology-diagram" viewBox="0 0 360 220" role="img" aria-label="উদ্ভিদ কোষের চিত্র: কোষপ্রাচীর, কোষঝিল্লি, কেন্দ্রক, রসধানী ও ক্লোরোপ্লাস্ট">
      <rect x="108" y="35" width="194" height="150" rx="25" fill="#f1f6df" stroke="#698448" strokeWidth="8" />
      <rect x="117" y="44" width="176" height="132" rx="20" fill="none" stroke="#afc47d" strokeWidth="3" />
      <ellipse cx="210" cy="111" rx="42" ry="53" fill="#dcebc3" stroke="#8cae64" strokeWidth="2" />
      <circle cx="153" cy="92" r="19" fill="#dfc7a6" stroke="#8a6845" strokeWidth="2" />
      <circle cx="153" cy="92" r="7" fill="#a87652" />
      <ellipse cx="145" cy="146" rx="15" ry="7" fill="#8bb874" stroke="#45734d" strokeWidth="2" />
      <ellipse cx="264" cy="76" rx="15" ry="7" fill="#8bb874" stroke="#45734d" strokeWidth="2" />
      <ellipse cx="266" cy="145" rx="15" ry="7" fill="#8bb874" stroke="#45734d" strokeWidth="2" />
      <path d="M108 43 L74 22 L8 22 M117 59 L76 51 L8 51 M153 92 L77 92 L8 92 M170 133 L76 142 L8 142" fill="none" stroke="#40574a" strokeWidth="1.4" />
      <path d="M266 145 L302 155 L353 155 M210 111 L302 86 L353 86" fill="none" stroke="#40574a" strokeWidth="1.4" />
      <g fill="#243b2f" fontFamily="Noto Sans Bengali, sans-serif" fontSize="11">
        <text x="7" y="18">কোষপ্রাচীর</text><text x="7" y="47">কোষঝিল্লি</text>
        <text x="7" y="88">কেন্দ্রক</text><text x="7" y="139">রসধানী</text>
        <text x="278" y="80">ক্লোরোপ্লাস্ট</text><text x="277" y="151">সাইটোপ্লাজম</text>
      </g>
    </svg>
  );
}