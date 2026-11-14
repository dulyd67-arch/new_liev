'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <div className="empty-state card"><h1>تعذر عرض الصفحة · Unable to load this page</h1><p className="muted">يرجى المحاولة مجدداً · Please try again.</p><button className="button gold" onClick={reset}>إعادة المحاولة · Try again</button></div>;
}
