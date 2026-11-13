"use client";

import { AlertTriangle, FileImage, FileText, LoaderCircle, Plus, Trash2, Upload } from "lucide-react";
import Image from "next/image";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { apiFetch, readApiJson } from "../api/api-client";

type QuestionKind = "MCQ" | "CQ";
type QuestionDraft = {
  id: string;
  type: QuestionKind;
  marks: number;
  topic: string;
  sourceNumber: string;
  content: { text: string; options?: string[]; subs?: string[]; answer?: string; imageUrls?: string[] };
  sourcePages: number[];
  uncertain: boolean;
  uncertainty: string[];
};

const maximumFiles = 5;
const maximumFileBytes = 20 * 1024 * 1024;
const maximumRequestBytes = 50 * 1024 * 1024;
const acceptedExtensions = /\.(pdf|docx)$/i;
const maximumQuestions = 1000;

function getQuestionIssues(question: QuestionDraft, type: QuestionKind) {
  const issues = [];
  if (!question.content.text.trim()) issues.push("প্রশ্নের লেখা প্রয়োজন");
  if (!Number.isInteger(question.marks) || question.marks < 1) issues.push("নম্বর অন্তত ১ হতে হবে");
  if (type === "MCQ" && (question.content.options?.filter((option) => option.trim()).length ?? 0) < 2) {
    issues.push("কমপক্ষে ২টি option প্রয়োজন");
  }
  if (type === "CQ" && (question.content.subs?.filter((sub) => sub.trim()).length ?? 0) < 1) {
    issues.push("কমপক্ষে ১টি উপপ্রশ্ন প্রয়োজন");
  }
  return issues;
}

const QuestionPreviewCard = memo(function QuestionPreviewCard({
  question,
  index,
  type,
  hasIssues,
  isSaving,
  onUpdateQuestion,
  onUpdateContent,
  onRemove,
}: {
  question: QuestionDraft;
  index: number;
  type: QuestionKind;
  hasIssues: boolean;
  isSaving: boolean;
  onUpdateQuestion: (index: number, patch: Partial<QuestionDraft>) => void;
  onUpdateContent: (index: number, patch: Partial<QuestionDraft["content"]>) => void;
  onRemove: (index: number) => void;
}) {
  const issues = getQuestionIssues(question, type);
  return (
    <article className={`question-upload-card${question.uncertain || hasIssues ? " uncertain" : ""}`} key={question.id}>
      <header>
        <strong>প্রশ্ন {question.sourceNumber || index + 1} · Preview {index + 1} · {question.type} · {question.sourcePages.length ? `পৃষ্ঠা ${question.sourcePages.join(", ")}` : "নতুন"}</strong>
        <button className="icon-button" type="button" aria-label={`প্রশ্ন ${index + 1} মুছুন`} disabled={isSaving} onClick={() => onRemove(index)}><Trash2 size={15} /></button>
      </header>
      {(question.uncertain || issues.length > 0) && <div className="question-upload-warning"><AlertTriangle size={14} /><span>{[...question.uncertainty, ...issues].join(" ")}</span></div>}
      <label>প্রশ্ন / উদ্দীপক<textarea maxLength={500} rows={3} value={question.content.text} disabled={isSaving} onChange={(event) => onUpdateContent(index, { text: event.target.value })} /></label>
      {(question.content.imageUrls?.length ?? 0) > 0 && <div className="question-upload-images" aria-label="প্রশ্নের সঙ্গে থাকা ছবির প্রিভিউ">
        {question.content.imageUrls?.map((imageUrl, imageIndex) => (
          <Image key={imageUrl} src={imageUrl} alt={`প্রশ্ন ${index + 1}-এর ছবি ${imageIndex + 1}`} width={600} height={400} unoptimized />
        ))}
      </div>}
      {type === "MCQ" && <div className="question-upload-parts">
        {(question.content.options ?? []).map((option, optionIndex) => (
          <label key={optionIndex}>Option {optionIndex + 1}<textarea maxLength={120} rows={2} value={option} disabled={isSaving} onChange={(event) => onUpdateContent(index, { options: (question.content.options ?? []).map((value, itemIndex) => itemIndex === optionIndex ? event.target.value : value) })} /></label>
        ))}
        <button className="button" type="button" disabled={isSaving || (question.content.options?.length ?? 0) >= 8} onClick={() => onUpdateContent(index, { options: [...(question.content.options ?? []), ""] })}><Plus size={13} />Option যোগ</button>
      </div>}
      {type === "CQ" && <div className="question-upload-parts">
        {(question.content.subs ?? []).map((sub, subIndex) => (
          <label key={subIndex}>{["ক", "খ", "গ", "ঘ"][subIndex] ?? `উপপ্রশ্ন ${subIndex + 1}`}<textarea maxLength={90} rows={2} value={sub} disabled={isSaving} onChange={(event) => onUpdateContent(index, { subs: (question.content.subs ?? []).map((value, itemIndex) => itemIndex === subIndex ? event.target.value : value) })} /></label>
        ))}
        <button className="button" type="button" disabled={isSaving || (question.content.subs?.length ?? 0) >= 4} onClick={() => onUpdateContent(index, { subs: [...(question.content.subs ?? []), ""] })}><Plus size={13} />উপপ্রশ্ন যোগ</button>
      </div>}
      <label>উত্তর (ঐচ্ছিক)<textarea maxLength={120} rows={2} value={question.content.answer ?? ""} disabled={isSaving} onChange={(event) => onUpdateContent(index, { answer: event.target.value })} /></label>
      <div className="question-upload-metadata">
        <label>নম্বর<input type="number" min={1} max={1000} value={question.marks || ""} disabled={isSaving} onChange={(event) => onUpdateQuestion(index, { marks: Number(event.target.value) })} /></label>
        <label>Topic (ঐচ্ছিক)<input maxLength={160} value={question.topic} disabled={isSaving} onChange={(event) => onUpdateQuestion(index, { topic: event.target.value })} /></label>
      </div>
    </article>
  );
});

export default function AdminQuestionUpload({
  initialType = "MCQ",
  onTypeChange,
  onSaved,
}: {
  initialType?: QuestionKind;
  onTypeChange: (type: QuestionKind) => void;
  onSaved: () => void;
}) {
  const type = initialType;
  const [classLevel, setClassLevel] = useState("");
  const [subject, setSubject] = useState("");
  const [chapter, setChapter] = useState("");
  const [topic, setTopic] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const invalidQuestions = useMemo(() => questions.map((question) => getQuestionIssues(question, type)), [questions, type]);
  const validQuestionCount = invalidQuestions.filter((issues) => issues.length === 0).length;

  function chooseFiles(selectedFiles: FileList | null) {
    if (!selectedFiles) return;
    const selection = Array.from(selectedFiles);
    if (!selection.length || selection.length > maximumFiles) {
      setError(`একবারে সর্বোচ্চ ${maximumFiles}টি PDF বা DOCX ফাইল দিন।`);
      return;
    }
    if (selection.some((file) => !acceptedExtensions.test(file.name)
      || (file.type && !["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"].includes(file.type)))) {
      setError("শুধু টেক্সট-ভিত্তিক PDF অথবা DOCX ফাইল সমর্থিত।");
      return;
    }
    if (selection.some((file) => file.size === 0 || file.size > maximumFileBytes)) {
      setError("প্রতিটি ফাইল ১ byte থেকে ২০ MB-এর মধ্যে হতে হবে।");
      return;
    }
    if (selection.reduce((total, file) => total + file.size, 0) > maximumRequestBytes) {
      setError("সব ফাইলের মোট আকার ৫০ MB-এর বেশি হতে পারবে না।");
      return;
    }
    setError("");
    setStatus("");
    setQuestions([]);
    setFiles(selection);
  }

  async function extractQuestions() {
    if (!classLevel.trim() || !subject.trim() || !chapter.trim() || !topic.trim() || !files.length) {
      setError("প্রশ্নের ধরন, শ্রেণি, বিষয়, অধ্যায়, Topic ও ফাইল দিন।");
      return;
    }
    setError("");
    setStatus("");
    setQuestions([]);
    setIsExtracting(true);
    setStatus("ডকুমেন্ট থেকে টেক্সট ও ছবি বের করা হচ্ছে…");
    const body = new FormData();
    body.set("type", type);
    body.set("classLevel", classLevel.trim());
    body.set("subject", subject.trim());
    body.set("chapter", chapter.trim());
    body.set("topic", topic.trim());
    files.forEach((file) => body.append("files", file));
    try {
      const response = await apiFetch("/api/admin/questions/upload/extract", {
        method: "POST",
        credentials: "same-origin",
        body,
        signal: AbortSignal.timeout(105_000),
      });
      const data = await readApiJson<{ error?: string; questions?: QuestionDraft[]; imageCount?: number }>(response);
      if (!response.ok) throw new Error(data.error ?? "প্রশ্ন বের করা যায়নি।");
      if (!data.questions?.length) throw new Error("কোনো প্রশ্ন বের হয়নি। পরিষ্কার ফাইল দিয়ে আবার চেষ্টা করুন।");
      setQuestions(data.questions);
      setStatus(`${data.questions.length}টি প্রশ্ন ও ${data.imageCount ?? 0}টি ছবি পাওয়া গেছে। সংরক্ষণের আগে যাচাই ও সম্পাদনা করুন।`);
    } catch (caught) {
      setStatus("");
      setError(caught instanceof Error ? caught.message : "ডকুমেন্ট থেকে তথ্য বের করা যায়নি।");
    } finally {
      setIsExtracting(false);
    }
  }

  const updateQuestion = useCallback((index: number, patch: Partial<QuestionDraft>) => {
    setQuestions((current) => current.map((question, currentIndex) =>
      currentIndex === index ? { ...question, ...patch } : question));
  }, []);

  const updateContent = useCallback((index: number, patch: Partial<QuestionDraft["content"]>) => {
    setQuestions((current) => current.map((question, currentIndex) =>
      currentIndex === index ? { ...question, content: { ...question.content, ...patch } } : question));
  }, []);

  const removeQuestion = useCallback((index: number) => {
    setQuestions((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const addQuestion = useCallback(() => {
    setQuestions((current) => [...current, {
      id: crypto.randomUUID(),
      type,
      marks: 0,
      topic: "",
      sourceNumber: String(current.length + 1),
      content: type === "MCQ" ? { text: "", options: ["", ""] } : { text: "", subs: [""] },
      sourcePages: [],
      uncertain: true,
      uncertainty: ["নতুন প্রশ্নটি হাতে লিখুন।"],
    }]);
  }, [type]);

  async function saveQuestions() {
    if (!questions.length || validQuestionCount !== questions.length || isSaving) return;
    setError("");
    setStatus("");
    setIsSaving(true);
    try {
      const response = await apiFetch("/api/admin/questions/upload/save", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          classLevel: classLevel.trim(),
          subject: subject.trim(),
          chapter: chapter.trim(),
          questions: questions.map(({ marks, topic: questionTopic, sourceNumber, content }) => ({
            marks,
            topic: questionTopic || topic.trim(),
            sourceNumber,
            content: {
              text: content.text.trim(),
              ...(type === "MCQ" ? { options: content.options ?? [] } : { subs: content.subs ?? [] }),
              ...(content.answer?.trim() ? { answer: content.answer.trim() } : {}),
              ...(content.imageUrls?.length ? { imageUrls: content.imageUrls } : {}),
            },
          })),
        }),
      });
      const data = await readApiJson<{ error?: string; saved?: number }>(response);
      if (!response.ok) throw new Error(data.error ?? "প্রশ্ন সংরক্ষণ করা যায়নি।");
      setStatus(`ডাটাবেজে ${data.saved ?? 0}টি প্রশ্ন সংরক্ষিত হয়েছে।`);
      setQuestions([]);
      setFiles([]);
      if (inputRef.current) inputRef.current.value = "";
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "প্রশ্ন সংরক্ষণ করা যায়নি।");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="question-upload" id="admin-question-upload" aria-labelledby="question-upload-title">
      <header className="question-upload-heading">
        <div><p className="eyebrow">অ্যাডমিন</p><h3 id="question-upload-title">Question Upload</h3></div>
        <span><FileImage size={18} /> PDF / DOCX</span>
      </header>
      <div className="question-upload-fields">
        <fieldset className="question-upload-types">
          <legend>১ · প্রশ্নের ধরন</legend>
          {(["MCQ", "CQ"] as const).map((questionType) => (
            <label key={questionType}>
              <input
                type="radio"
                name="question-upload-type"
                value={questionType}
                checked={type === questionType}
                disabled={isExtracting || isSaving}
                onChange={() => { onTypeChange(questionType); setQuestions([]); setStatus(""); }}
              />
              {questionType}
            </label>
          ))}
        </fieldset>
        <div className="question-upload-metadata">
          <label>২ · Class<input required maxLength={60} value={classLevel} disabled={isExtracting || isSaving} onChange={(event) => setClassLevel(event.target.value)} placeholder="যেমন: Class 9" /></label>
          <label>Subject<input required maxLength={120} value={subject} disabled={isExtracting || isSaving} onChange={(event) => setSubject(event.target.value)} placeholder="যেমন: গণিত / Mathematics" /></label>
          <label>Chapter<input required maxLength={160} value={chapter} disabled={isExtracting || isSaving} onChange={(event) => setChapter(event.target.value)} placeholder="যেমন: বীজগণিত" /></label>
          <label>Topic<input required maxLength={160} value={topic} disabled={isExtracting || isSaving} onChange={(event) => setTopic(event.target.value)} placeholder="যেমন: সরল সমীকরণ" /></label>
        </div>
        <div className="question-upload-file">
          <strong>৩ · টেক্সট-ভিত্তিক PDF / DOCX ফাইল</strong>
          <p>সর্বোচ্চ ৫টি ফাইল; প্রতিটি সর্বোচ্চ ২০ MB, মোট ৫০ MB। স্ক্যান করা PDF সমর্থিত নয়। OCR ব্যবহার করা হয় না।</p>
          <label className="button file-upload">
            <Upload size={15} />{files.length ? `${files.length}টি ফাইল নির্বাচিত` : "ফাইল বাছুন"}
            <input ref={inputRef} type="file" multiple accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={isExtracting || isSaving} onChange={(event) => chooseFiles(event.currentTarget.files)} />
          </label>
          {files.length > 0 && <ul className="question-upload-files">{files.map((file) => <li key={`${file.name}-${file.size}`}>{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</li>)}</ul>}
        </div>
      </div>
      <button className="button primary" type="button" disabled={isExtracting || isSaving || !files.length || !classLevel.trim() || !subject.trim() || !chapter.trim() || !topic.trim()} onClick={() => void extractQuestions()}>
        {isExtracting ? <LoaderCircle size={15} className="animate-spin" /> : <FileText size={15} />}{isExtracting ? "প্রশ্ন বের করা হচ্ছে…" : "প্রশ্ন বের করুন"}
      </button>
      {error && <p className="question-upload-error" role="alert">{error}</p>}
      {status && <p className="question-upload-status" role="status" aria-busy={isExtracting}>{isExtracting && <LoaderCircle size={15} className="animate-spin" />}{status}</p>}

      {questions.length > 0 && <div className="question-upload-preview">
        <div className="question-upload-preview-heading">
          <h4>Preview · মোট {questions.length}টি প্রশ্ন</h4>
          <button className="button" type="button" disabled={isSaving || questions.length >= maximumQuestions} onClick={addQuestion}><Plus size={14} />প্রশ্ন যোগ</button>
        </div>
        {questions.map((question, index) => (
          <QuestionPreviewCard
            key={question.id}
            question={question}
            index={index}
            type={type}
            hasIssues={Boolean(invalidQuestions[index]?.length)}
            isSaving={isSaving}
            onUpdateQuestion={updateQuestion}
            onUpdateContent={updateContent}
            onRemove={removeQuestion}
          />
        ))}
        <button className="button primary" type="button" disabled={isSaving || !questions.length || validQuestionCount !== questions.length} onClick={() => void saveQuestions()}>
          {isSaving ? "সংরক্ষণ হচ্ছে…" : `${validQuestionCount}/${questions.length}টি প্রশ্ন নিশ্চিত করে সংরক্ষণ করুন`}
        </button>
      </div>}
    </section>
  );
}
