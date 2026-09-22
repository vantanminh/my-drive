import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, GitMerge, RefreshCw, ScanFace, Tag, X } from 'lucide-react';
import { api } from '../api';
import { formatDate, friendlyError } from '../format';
import type { FaceCluster } from '../types';

type Props = { onClose: () => void };

export default function FaceManagementPanel({ onClose }: Props) {
  const [clusters, setClusters] = useState<FaceCluster[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [targetId, setTargetId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api.faceClusters(0, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setClusters(page.clusters);
        setNextOffset(page.nextOffset);
        setSelectedIds([]);
        setTargetId('');
        setLabelDrafts(Object.fromEntries(page.clusters.map((cluster) => [cluster.id, cluster.label || ''])));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(friendlyError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey]);

  const selected = useMemo(
    () => selectedIds.map((id) => clusters.find((cluster) => cluster.id === id)).filter((cluster): cluster is FaceCluster => !!cluster),
    [clusters, selectedIds]
  );

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
      if (!targetId && next.length) setTargetId(next[0]);
      if (targetId === id && !next.includes(id)) setTargetId(next[0] || '');
      return next;
    });
  }

  async function renameCluster(event: FormEvent<HTMLFormElement>, cluster: FaceCluster) {
    event.preventDefault();
    const value = (labelDrafts[cluster.id] ?? '').trim();
    if (value.length > 80) {
      setError('Face labels must be 80 characters or fewer.');
      return;
    }
    setBusyKey('rename:' + cluster.id);
    setError('');
    setNotice('');
    try {
      const result = await api.renameFaceCluster(cluster.id, value || null);
      setClusters((current) => current.map((item) => item.id === cluster.id ? { ...item, label: result.label, updatedAt: new Date().toISOString() } : item));
      setLabelDrafts((current) => ({ ...current, [cluster.id]: result.label || '' }));
      setNotice(result.label ? `Face group renamed to “${result.label}”.` : 'Face group label cleared.');
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function mergeSelected() {
    if (selectedIds.length < 2 || !targetId) return;
    const sourceIds = selectedIds.filter((id) => id !== targetId);
    const target = clusters.find((cluster) => cluster.id === targetId);
    if (!target || !window.confirm(`Merge ${sourceIds.length} face groups into “${target.label || 'Unlabelled group'}”?`)) return;
    setBusyKey('merge');
    setError('');
    setNotice('');
    try {
      const result = await api.mergeFaceClusters(targetId, sourceIds);
      setNotice(`Merged ${result.mergedClusters} groups and moved ${result.movedFaces} face observations.`);
      setRefreshKey((current) => current + 1);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function loadMore() {
    if (nextOffset == null || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const page = await api.faceClusters(nextOffset);
      setClusters((current) => {
        const existing = new Set(current.map((cluster) => cluster.id));
        const additions = page.clusters.filter((cluster) => !existing.has(cluster.id));
        setLabelDrafts((drafts) => ({ ...drafts, ...Object.fromEntries(additions.map((cluster) => [cluster.id, cluster.label || ''])) }));
        return [...current, ...additions];
      });
      setNextOffset(page.nextOffset);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="face-admin-panel account-admin-panel" id="face-admin-panel" aria-labelledby="face-admin-title">
      <div className="account-admin-header">
        <div>
          <span className="eyebrow">OWNER CONTROLS</span>
          <h2 id="face-admin-title">Face groups</h2>
          <p>Review detected faces, label groups, and merge duplicates. Groups stay private to your account.</p>
        </div>
        <div className="account-admin-header-actions">
          <button className="icon-button account-refresh" type="button" aria-label="Refresh face groups" title="Refresh face groups" disabled={loading || busyKey !== null} onClick={() => setRefreshKey((current) => current + 1)}><RefreshCw size={16} /></button>
          <button className="icon-button media-index-close" type="button" aria-label="Close face groups" onClick={onClose}><X size={17} /></button>
        </div>
      </div>

      {error ? <div className="account-admin-message account-admin-error" role="alert">{error}</div> : null}
      {notice && !error ? <div className="account-admin-message account-admin-notice" role="status"><Check size={14} />{notice}</div> : null}

      {selected.length >= 2 ? (
        <div className="face-merge-toolbar">
          <div><GitMerge size={16} /><span><strong>{selected.length} groups selected.</strong> Choose the group that should keep its label.</span></div>
          <div className="face-merge-actions">
            <label htmlFor="face-merge-target">Keep</label>
            <select id="face-merge-target" className="text-input" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {selected.map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.label || 'Unlabelled group'}</option>)}
            </select>
            <button className="button button-primary" type="button" disabled={busyKey !== null} onClick={() => void mergeSelected()}><GitMerge size={14} />{busyKey === 'merge' ? 'Merging…' : 'Merge groups'}</button>
          </div>
        </div>
      ) : null}

      <div className="account-admin-list-heading">
        <div><ScanFace size={16} /><strong>Detected groups</strong><span>{clusters.length}{nextOffset != null ? '+' : ''}</span></div>
        <span>Select two or more groups to merge them.</span>
      </div>

      {loading ? (
        <div className="account-admin-loading"><span className="spinner" />Loading face groups…</div>
      ) : clusters.length === 0 ? (
        <div className="account-admin-empty"><ScanFace size={19} /><span>No face groups have been indexed yet. Start media indexing and return here when it has processed some files.</span></div>
      ) : (
        <div className="face-list">
          {clusters.map((cluster) => {
            const selectedCluster = selectedIds.includes(cluster.id);
            const draft = labelDrafts[cluster.id] ?? cluster.label ?? '';
            return (
              <article className={'face-card' + (selectedCluster ? ' is-selected' : '')} key={cluster.id}>
                <label className="face-card-select">
                  <input type="checkbox" checked={selectedCluster} onChange={() => toggleSelected(cluster.id)} aria-label={'Select ' + (cluster.label || 'unlabelled face group')} />
                  <span className="face-card-mark"><ScanFace size={18} /></span>
                </label>
                <div className="face-card-copy">
                  <strong>{cluster.label || 'Unlabelled face group'}</strong>
                  <span>{cluster.faceCount} face observations · {cluster.assetCount} media assets · Updated {formatDate(cluster.updatedAt)}</span>
                </div>
                <form className="face-label-form" onSubmit={(event) => void renameCluster(event, cluster)}>
                  <label htmlFor={'face-label-' + cluster.id}><Tag size={13} /> Label</label>
                  <input id={'face-label-' + cluster.id} className="text-input" maxLength={80} value={draft} onChange={(event) => setLabelDrafts((current) => ({ ...current, [cluster.id]: event.target.value }))} placeholder="e.g. Family" />
                  <button className="button button-secondary" type="submit" disabled={busyKey !== null && busyKey !== 'rename:' + cluster.id}>{busyKey === 'rename:' + cluster.id ? 'Saving…' : 'Save'}</button>
                </form>
              </article>
            );
          })}
        </div>
      )}

      {nextOffset != null && !loading ? <button className="button button-secondary account-load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more face groups'}</button> : null}
    </section>
  );
}
