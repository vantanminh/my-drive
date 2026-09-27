import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export default function ApiDocsPage({ href }: { href: string }) {
  const page = href.split('?')[0].split('/').pop() || 'index';
  const valid = ['index', 'authentication', 'drive', 'uploads', 'photos', 'shares', 'usage', 'lesson-sync'].includes(page);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController(); setText(''); setError('');
    fetch(`/docs/${page}.md`, { signal: controller.signal }).then(async r => { if (!r.ok) throw new Error('Documentation unavailable'); return r.text(); }).then(setText).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [page, valid]);
  return <main className="api-docs"><nav><a href="/drive">MyDrive</a><a href="/docs/index">API overview</a><a href={`/docs/${valid ? page : 'index'}.md`}>Read Markdown</a></nav>{!valid ? <h1>Page not found</h1> : error ? <p role="alert">{error}</p> : text ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href: link, children }) => <a href={link?.startsWith('/docs/') && link.endsWith('.md') ? link.slice(0, -3) : link}>{children}</a> }}>{text}</ReactMarkdown> : <p>Loading documentation…</p>}</main>;
}
