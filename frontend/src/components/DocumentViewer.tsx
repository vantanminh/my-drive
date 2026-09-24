import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Info,
  Maximize2,
  Minimize2,
  X
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { downloadUrl, previewUrl } from '../api';
import { formatDate, formatSize } from '../format';
import type { EntryDetails } from '../types';
import type { MediaViewerProps, PreviewSourceSet, ViewerItem } from './MediaViewer';

type TextFormat = 'text' | 'markdown' | 'json';

function extensionFor(name: string): string {
  return name.split('.').at(-1)?.toLowerCase() || '';
}

function textFormatFor(name: string): TextFormat | null {
  const extension = extensionFor(name);
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'json') return 'json';
  if (extension === 'txt') return 'text';
  return null;
}

function typeLabel(name: string): string {
  const extension = extensionFor(name);
  const labels: Record<string, string> = {
    pdf: 'PDF document',
    doc: 'Word document',
    docx: 'Word document',
    ppt: 'PowerPoint presentation',
    pptx: 'PowerPoint presentation',
    xls: 'Excel spreadsheet',
    xlsx: 'Excel spreadsheet',
    rtf: 'Rich text document',
    csv: 'Comma-separated values',
    txt: 'Text file',
    md: 'Markdown document',
    markdown: 'Markdown document',
    json: 'JSON document'
  };
  return labels[extension] || 'Document';
}

function sourcesFor(item: ViewerItem, props: MediaViewerProps): PreviewSourceSet {
  return props.sourceFor?.(item) ?? props.sources ?? {
    preview: previewUrl(item.id),
    download: downloadUrl(item.id)
  };
}

export default function DocumentViewer(props: MediaViewerProps) {
  const gallery = props.items && props.items.length > 0
    ? props.items
    : props.entry
      ? [props.entry]
      : [];
  const index = Math.min(Math.max(props.index ?? 0, 0), Math.max(gallery.length - 1, 0));
  const current = gallery[index];
  const resolved = current ? sourcesFor(current, props) : null;
  const textFormat = current ? textFormatFor(current.name) : null;
  const [text, setText] = useState('');
  const [loadingText, setLoadingText] = useState(false);
  const [loadingConversion, setLoadingConversion] = useState(false);
  const [convertedPreviewUrl, setConvertedPreviewUrl] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [jsonWarning, setJsonWarning] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [details, setDetails] = useState<EntryDetails | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const shellRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (!textFormat || !current || !resolved) {
      setText('');
      setLoadError(false);
      setJsonWarning(false);
      setLoadingText(false);
      return;
    }
    const controller = new AbortController();
    setText('');
    setLoadError(false);
    setJsonWarning(false);
    setLoadingText(true);
    fetch(resolved.preview, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok || !response.headers.get('content-type')?.startsWith('text/plain')) {
          throw new Error('Document preview request failed');
        }
        const source = await response.text();
        if (textFormat !== 'json') return source;
        try {
          return JSON.stringify(JSON.parse(source), null, 2);
        } catch {
          setJsonWarning(true);
          return source;
        }
      })
      .then((value) => setText(value))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingText(false);
      });
    return () => controller.abort();
  }, [current?.id, resolved?.preview, textFormat]);

  useEffect(() => {
    if (!current || !resolved || textFormat || extensionFor(current.name) === 'pdf') {
      setConvertedPreviewUrl('');
      setLoadingConversion(false);
      return;
    }
    const controller = new AbortController();
    let objectUrl = '';
    setConvertedPreviewUrl('');
    setLoadError(false);
    setLoadingConversion(true);
    fetch(resolved.preview, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok || !response.headers.get('content-type')?.startsWith('application/pdf')) {
          throw new Error('Document conversion request failed');
        }
        return response.blob();
      })
      .then((pdf) => {
        if (pdf.size > 64 * 1024 * 1024) throw new Error('Document preview is too large');
        objectUrl = URL.createObjectURL(pdf);
        setConvertedPreviewUrl(objectUrl);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingConversion(false);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [current?.id, current?.name, resolved?.preview, textFormat]);

  useEffect(() => {
    if (!infoOpen || !current || !props.loadDetails) return;
    let cancelled = false;
    props.loadDetails(current)
      .then((value) => { if (!cancelled) setDetails(value); })
      .catch(() => { if (!cancelled) setDetails(null); });
    return () => { cancelled = true; };
  }, [infoOpen, current, props.loadDetails]);

  useEffect(() => {
    function onFullscreenChange() {
      setFullscreen(document.fullscreenElement === shellRef.current);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const canPrev = index > 0;
  const canNext = index < gallery.length - 1;
  const go = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < gallery.length) props.onIndexChange?.(next);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shellRef.current?.requestFullscreen();
  };

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, select, textarea')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (infoOpen) setInfoOpen(false);
        else props.onClose();
      } else if (event.key === 'ArrowLeft' && canPrev) {
        event.preventDefault();
        go(-1);
      } else if (event.key === 'ArrowRight' && canNext) {
        event.preventDefault();
        go(1);
      } else if (event.key === 'i' || event.key === 'I') {
        event.preventDefault();
        setInfoOpen((open) => !open);
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        toggleFullscreen();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  if (!current || !resolved) return null;
  const mime = details?.mime_type || current.mime_detected || current.mime_type || typeLabel(current.name);
  const size = details?.size_bytes ?? current.size_bytes;

  return (
    <div className="viewer-backdrop" role="presentation">
      <section
        className={'viewer-shell' + (infoOpen ? ' viewer-with-info' : '')}
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-label={current.name}
      >
        <header className="viewer-topbar">
          <button ref={closeButtonRef} className="viewer-icon" onClick={props.onClose} aria-label="Close preview"><X size={20} /></button>
          <div className="viewer-title">
            <strong title={current.name}>{current.name}</strong>
            <span>{typeLabel(current.name)}{gallery.length > 1 ? ` · ${index + 1} of ${gallery.length}` : ''}{size != null ? ` · ${formatSize(size)}` : ''}</span>
          </div>
          <div className="viewer-top-actions">
            <button className={'viewer-icon' + (infoOpen ? ' viewer-icon-active' : '')} onClick={() => setInfoOpen((open) => !open)} aria-label="File information" aria-pressed={infoOpen}><Info size={18} /></button>
            <button className="viewer-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
              {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </button>
            {props.showDownload !== false && resolved.download && (
              <a className="viewer-icon" href={resolved.download} aria-label="Download original"><Download size={18} /></a>
            )}
          </div>
        </header>

        <div className="viewer-stage viewer-document-stage">
          {canPrev && <button className="viewer-nav viewer-nav-prev" onClick={() => go(-1)} aria-label="Previous file"><ChevronLeft size={28} /></button>}
          {canNext && <button className="viewer-nav viewer-nav-next" onClick={() => go(1)} aria-label="Next file"><ChevronRight size={28} /></button>}
          {loadError ? (
            <div className="viewer-error" role="alert">
              <FileText size={28} />
              <strong>This file cannot be previewed.</strong>
              <span>{props.showDownload === false ? 'Downloads are disabled for this link.' : 'The original file is still available.'}</span>
              {props.showDownload !== false && resolved.download && <a className="button button-secondary" href={resolved.download}><Download size={15} /> Download original</a>}
            </div>
          ) : textFormat ? (
            <div className="viewer-document-scroll">
              {loadingText ? <div className="viewer-document-status" role="status">Loading document…</div> : null}
              {jsonWarning ? <div className="viewer-document-warning" role="status">This JSON is not valid; showing the original text.</div> : null}
              {!loadingText && !loadError && textFormat === 'markdown' ? (
                <article className="viewer-document-sheet viewer-markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    skipHtml
                    components={{ img: () => null }}
                  >
                    {text}
                  </ReactMarkdown>
                </article>
              ) : !loadingText && !loadError ? (
                <pre className="viewer-document-sheet viewer-plain-text"><code>{text}</code></pre>
              ) : null}
            </div>
          ) : loadingConversion ? (
            <div className="viewer-document-status" role="status">Preparing preview…</div>
          ) : (
            <iframe
              key={current.id}
              className="viewer-document-frame"
              src={textFormat || extensionFor(current.name) === 'pdf' ? resolved.preview : convertedPreviewUrl}
              title={'Preview of ' + current.name}
              referrerPolicy="no-referrer"
              onError={() => setLoadError(true)}
            />
          )}
        </div>

        {infoOpen && (
          <aside className="viewer-info" aria-label="File information">
            <header>
              <strong>Information</strong>
              <button className="viewer-icon" onClick={() => setInfoOpen(false)} aria-label="Close information"><X size={16} /></button>
            </header>
            <dl>
              <div><dt>Name</dt><dd>{current.name}</dd></div>
              <div><dt>Type</dt><dd>{mime}</dd></div>
              <div><dt>Size</dt><dd>{formatSize(size)}</dd></div>
              <div><dt>Created</dt><dd>{formatDate(details?.created_at || current.created_at)}</dd></div>
              <div><dt>Modified</dt><dd>{formatDate(details?.updated_at || current.updated_at)}</dd></div>
              {details?.location && <div><dt>Location</dt><dd>{details.location}</dd></div>}
            </dl>
          </aside>
        )}
      </section>
    </div>
  );
}
