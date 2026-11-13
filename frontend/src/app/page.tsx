import Link from "next/link";
import { LanguageSwitcher, ThemeSwitcher } from "./i18n/language-provider";

const services = [
  {
    number: "01",
    title: "প্রশ্নপত্র তৈরি",
    description: "MCQ ও সৃজনশীল প্রশ্ন সাজিয়ে কয়েক মিনিটে সম্পূর্ণ প্রশ্নপত্র তৈরি করুন।",
  },
  {
    number: "02",
    title: "প্রশ্ন ব্যাংক",
    description: "শ্রেণি, বিষয়, অধ্যায় ও টপিক অনুযায়ী প্রশ্ন সংরক্ষণ ও খুঁজে নিন।",
  },
  {
    number: "03",
    title: "প্রস্তুত ও প্রিন্ট",
    description: "বাংলা ফন্ট, গাণিতিক সমীকরণ ও পরিচ্ছন্ন A4 লেআউটসহ PDF প্রস্তুত করুন।",
  },
];

const features = [
  ["MCQ ও CQ", "বহুনির্বাচনি এবং সৃজনশীল—দুই ধরনের প্রশ্নপত্রই তৈরি করুন।"],
  ["বাংলা-প্রথম", "বাংলা ফন্ট, সমীকরণ, ছবি ও টেবিলের নির্ভরযোগ্য সমর্থন।"],
  ["সহজ আমদানি", "CSV ও Excel ফাইল থেকে প্রশ্ন যোগ করুন, প্রয়োজনে রপ্তানিও করুন।"],
  ["নিজস্ব নিয়ন্ত্রণ", "প্রশ্ন বাছাই, নম্বর, সময়, নির্দেশনা ও পৃষ্ঠা বিন্যাস ঠিক করুন।"],
];

export default function Home() {
  return (
    <main className="public-home">
      <header className="public-nav">
        <Link className="public-brand" href="/" aria-label="প্রশ্নপত্র হোম">
          <span className="public-brand-mark">Q</span>
          <span><strong>প্রশ্নপত্র</strong><small>প্রশ্নপত্র নির্মাতা</small></span>
        </Link>
        <nav className="public-nav-links" aria-label="প্রধান নেভিগেশন">
          <a href="#about">আমাদের সম্পর্কে</a>
          <a href="#services">সেবাসমূহ</a>
          <a href="#features">বৈশিষ্ট্য</a>
          <a href="#how-it-works">যেভাবে কাজ করে</a>
          <a href="#contact">যোগাযোগ</a>
        </nav>
        <div className="public-nav-actions">
          <LanguageSwitcher />
          <ThemeSwitcher />
          <Link className="public-login-link" href="/login">সাইন ইন</Link>
          <Link className="public-button public-button-small" href="/register">নিবন্ধন</Link>
        </div>
      </header>

      <section className="public-hero">
        <div className="public-hero-copy">
          <p className="public-eyebrow"><span /> শিক্ষকদের জন্য স্মার্ট প্রশ্নপত্র প্ল্যাটফর্ম</p>
          <h1>প্রশ্নপত্র তৈরি হোক<br /><em>সহজ, দ্রুত ও সুন্দর</em></h1>
          <p className="public-hero-description">
            প্রশ্ন বাছাই থেকে প্রিন্ট-প্রস্তুত কপি—একটি সহজ কর্মপ্রবাহে MCQ ও সৃজনশীল প্রশ্নপত্র তৈরি, সাজান এবং সংরক্ষণ করুন।
          </p>
          <div className="public-hero-actions">
            <Link className="public-button" href="/register">বিনামূল্যে শুরু করুন <span aria-hidden="true">→</span></Link>
            <Link className="public-button public-button-outline" href="/login">সাইন ইন</Link>
          </div>
          <p className="public-hero-note">শিক্ষক ও শিক্ষা প্রতিষ্ঠানের জন্য তৈরি</p>
        </div>
        <div className="public-hero-art" aria-hidden="true">
          <div className="hero-orbit hero-orbit-one" />
          <div className="hero-orbit hero-orbit-two" />
          <div className="hero-paper">
            <div className="hero-paper-top"><span>বিদ্যালয়ের নাম</span><span>২০২৬</span></div>
            <div className="hero-paper-rule" />
            <strong>বার্ষিক মূল্যায়ন</strong>
            <small>নবম শ্রেণি · পদার্থবিজ্ঞান</small>
            <div className="hero-paper-meta"><span>সময়: ২ ঘণ্টা</span><span>পূর্ণমান: ৫০</span></div>
            <div className="hero-question"><b>১.</b><span>বস্তুর বেগ-সময় লেখচিত্রের ঢাল কী নির্দেশ করে?</span></div>
            <div className="hero-options"><span>ক. সরণ</span><span>খ. ত্বরণ</span><span>গ. বল</span><span>ঘ. কাজ</span></div>
            <div className="hero-question"><b>২.</b><span>নিচের সৃজনশীল প্রশ্নটির উত্তর দাও।</span></div>
            <div className="hero-paper-lines"><i /><i /><i /></div>
            <div className="hero-paper-stamp">প্রিন্ট প্রস্তুত</div>
          </div>
          <div className="hero-float-card"><span>✓</span><div><b>প্রশ্নপত্র প্রস্তুত</b><small>MCQ · CQ · PDF</small></div></div>
        </div>
        <div className="public-hero-bottom"><span>প্রশ্ন তৈরি</span><i /><span>প্রশ্ন সাজানো</span><i /><span>প্রিন্ট ও শেয়ার</span></div>
      </section>

      <section className="public-about" id="about">
        <div className="public-about-mark" aria-hidden="true">Q</div>
        <div>
          <p className="public-eyebrow">শিক্ষকের কাজের জন্য তৈরি</p>
          <h2>পরিকল্পনা থেকে প্রিন্ট—একটি নিরবচ্ছিন্ন কর্মপ্রবাহ</h2>
          <p>প্রশ্ন নির্বাচন, পরীক্ষার সেটিংস, লাইভ প্রিভিউ এবং প্রশ্নপত্র সংরক্ষণের দরকারি ধাপগুলো এক জায়গায় রাখে প্রশ্নপত্র নির্মাতা।</p>
        </div>
        <Link className="public-text-link" href="/register">প্ল্যাটফর্ম ব্যবহার শুরু করুন <span aria-hidden="true">→</span></Link>
      </section>

      <section className="public-section public-services" id="services">
        <div className="public-section-heading">
          <p className="public-eyebrow">আমাদের সেবাসমূহ</p>
          <h2>শিক্ষকের কাজকে করি আরও সহজ</h2>
          <p>প্রশ্নপত্র তৈরির প্রতিটি ধাপ এক জায়গায়—পরিকল্পনা থেকে চূড়ান্ত প্রিন্ট পর্যন্ত।</p>
        </div>
        <div className="public-service-grid">
          {services.map((service) => (
            <article className="public-service-card" key={service.number}>
              <span className="service-number">{service.number}</span>
              <h3>{service.title}</h3>
              <p>{service.description}</p>
              <span className="service-arrow" aria-hidden="true">↗</span>
            </article>
          ))}
        </div>
      </section>

      <section className="public-features" id="features">
        <div className="public-features-intro">
          <p className="public-eyebrow">একটি সম্পূর্ণ কর্মপরিবেশ</p>
          <h2>প্রশ্নপত্রের প্রতিটি খুঁটিনাটিতে আপনার নিয়ন্ত্রণ</h2>
          <p>শিক্ষাদানের সময় বাঁচাতে দরকারি টুলগুলোকে সাজানো হয়েছে একটি নির্ভরযোগ্য প্ল্যাটফর্মে।</p>
          <Link className="public-text-link" href="/register">আপনার অ্যাকাউন্ট তৈরি করুন <span aria-hidden="true">→</span></Link>
        </div>
        <div className="public-feature-grid">
          {features.map(([title, description], index) => (
            <article className="public-feature" key={title}>
              <span className="feature-icon">{["Aa", "∑", "↥", "✓"][index]}</span>
              <div><h3>{title}</h3><p>{description}</p></div>
            </article>
          ))}
        </div>
      </section>

      <section className="public-process" id="how-it-works">
        <div className="public-section-heading">
          <p className="public-eyebrow">যেভাবে কাজ করে</p>
          <h2>তিন ধাপে প্রস্তুত প্রশ্নপত্র</h2>
        </div>
        <div className="public-process-grid">
          <article><span>১</span><h3>অ্যাকাউন্ট তৈরি করুন</h3><p>নিরাপদ শিক্ষক অ্যাকাউন্টে নিবন্ধন করে প্রবেশ করুন।</p></article>
          <article><span>২</span><h3>প্রশ্ন বাছাই ও সাজান</h3><p>প্রশ্ন ব্যাংক থেকে নিন অথবা নিজে প্রশ্ন লিখুন, নম্বর ও বিন্যাস ঠিক করুন।</p></article>
          <article><span>৩</span><h3>প্রিভিউ ও প্রিন্ট করুন</h3><p>লাইভ প্রিভিউ দেখে PDF তৈরি করুন বা সরাসরি প্রিন্ট করুন।</p></article>
        </div>
      </section>

      <section className="public-cta">
        <div><p className="public-eyebrow">আজই শুরু করুন</p><h2>আরও সময় দিন শেখানোয়</h2><p>আপনার পরের প্রশ্নপত্রটি তৈরি করুন আরও কম সময়ে।</p></div>
        <Link className="public-button public-button-light" href="/register">নিবন্ধন করুন <span aria-hidden="true">→</span></Link>
      </section>

      <section className="public-contact" id="contact">
        <div>
          <p className="public-eyebrow">যোগাযোগ ও সহায়তা</p>
          <h2>প্রশ্নপত্র তৈরির যাত্রা শুরু করুন</h2>
          <p>অ্যাকাউন্ট, প্রশ্ন নির্বাচন, পরীক্ষার সেটিংস কিংবা প্রিন্ট-প্রস্তুত কপি—আপনার কাজ শুরু করতে সাইন ইন করুন বা নতুন শিক্ষক অ্যাকাউন্ট তৈরি করুন।</p>
        </div>
        <div className="public-contact-actions">
          <Link className="public-button" href="/register">শিক্ষক অ্যাকাউন্ট তৈরি করুন <span aria-hidden="true">→</span></Link>
          <Link className="public-text-link" href="/login">ইতিমধ্যে অ্যাকাউন্ট আছে? সাইন ইন</Link>
        </div>
      </section>

      <footer className="public-footer">
        <Link className="public-brand" href="/">
          <span className="public-brand-mark">Q</span>
          <span><strong>প্রশ্নপত্র</strong><small>প্রশ্নপত্র নির্মাতা</small></span>
        </Link>
        <p>শিক্ষকদের জন্য একটি সহজ, নির্ভরযোগ্য প্রশ্নপত্র তৈরির প্ল্যাটফর্ম।</p>
        <div className="public-footer-links"><Link href="/login">সাইন ইন</Link><Link href="/register">নিবন্ধন</Link><Link href="/admin/login">অ্যাডমিন প্রবেশ</Link></div>
        <small className="public-copyright">© ২০২৬ প্রশ্নপত্র · সর্বস্বত্ব সংরক্ষিত</small>
      </footer>
    </main>
  );
}
