import { Suspense, lazy } from 'react';
import MediaViewer, { isDocumentPreviewable, mediaKindFor, type MediaViewerProps } from './MediaViewer';

const DocumentViewer = lazy(() => import('./DocumentViewer'));

export default function FilePreviewer(props: MediaViewerProps) {
  const gallery = props.items && props.items.length > 0
    ? props.items
    : props.entry
      ? [props.entry]
      : [];
  const index = Math.min(Math.max(props.index ?? 0, 0), Math.max(gallery.length - 1, 0));
  const current = gallery[index];

  if (current && !mediaKindFor(current) && isDocumentPreviewable(current)) {
    return (
      <Suspense fallback={<div className="viewer-backdrop"><div className="viewer-error" role="status">Opening document preview…</div></div>}>
        <DocumentViewer {...props} />
      </Suspense>
    );
  }
  return <MediaViewer {...props} />;
}
