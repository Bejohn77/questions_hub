# Frontend

Standalone Next.js + TypeScript frontend. The Express API and PostgreSQL/Prisma application are in `backend/`.

## Local development

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Set `API_ORIGIN=http://localhost:4000` in `.env.local` and run the backend separately. In production, set `API_ORIGIN` to the backend's actual HTTPS origin; reserved example domains are rejected. The Next.js `/api/*` proxy forwards to the REST API while keeping browser requests and HttpOnly session cookies same-origin, and returns JSON for proxy failures.

Use `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run test:ui` for validation. For Hostinger Business Web Hosting, deploy this directory as its own Node.js website and configure `API_ORIGIN` in that website's environment. See the repository [README](../README.md) for deployment settings.

## Language support

The interface defaults to Bangla and provides a বাংলা | English switcher on the public, authentication, and application navigation. The preference is stored in the browser under `school-question-paper-language`; it is a display preference only and does not store account, exam, or question data. UI translations are maintained separately in `src/app/i18n/bn.ts` and `src/app/i18n/en.ts`. User questions and academic/database values are kept in their original language.

## Color themes

The interface defaults to Light Mode and provides a Light/Dark theme switcher on public, authentication, and application navigation. The selected theme is stored independently under `school-question-paper-theme`, so changing the theme does not reset the language preference. The paper preview and print output retain their paper colors in both themes.

## Paper fonts

Paper output uses Times New Roman for Latin text and math text, and the bundled Noto Serif Bengali font for Unicode Bengali (`U+0980–U+09FF`). Bengali content is Unicode; no SutonnyMJ font file is required. Browser-generated PDFs embed fonts available to Chromium.

## Generating and exporting papers

Choose **Generate MCQ Paper** or **Generate CQ Paper** to open that question type's independent three-step workflow: select one class, select a subject belonging to that class, then choose a question count and generate. Automatic generation randomly selects exactly the requested number of eligible database questions. If fewer eligible questions are available, generation reports the available count rather than creating a partial paper. Manual selection remains available, and the server validates every selected question against the chosen class and subject. MCQ and CQ questions are never combined in a paper. MCQ output uses two portrait columns. CQ provides a selectable **CQ Page Layout**: **2 Pages** preserves the A4 landscape booklet formula and section order exactly (Page 1 right = Section 1, Page 2 left = Section 2, Page 2 right = Section 3, Page 1 left = Section 4); **1 Page** uses one A4 landscape page with questions flowing from the left (First Section) column to the right (Second Section) column. Questions remain sequential, and subquestion continuations retain their number. The selected CQ layout is stored with CQ settings. CQ output is limited to 12 questions; export is blocked if content cannot fit the selected fixed page count, and no overflow pages are created.

## Admin question uploads

The Admin Panel has one **Question Upload** workflow for MCQ and CQ. Select the type and enter class, subject, chapter, and topic, then upload DOCX or text-based PDF files. Text and embedded image previews are editable/reviewable before saving; image contents are never converted to text. Scanned/image-only PDFs are rejected. Imports support up to 1,000 questions and use no OCR or AI vision. CSV and XLSX remain question-bank export formats only.
