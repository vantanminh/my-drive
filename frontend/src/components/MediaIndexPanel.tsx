import { useEffect, useRef, useState } from 'react';
import { Activity, Pause, Play, RotateCcw, X } from 'lucide-react';
import { api, type MediaIndexJob, type MediaIndexStatus } from '../api';
import { formatSize, friendlyError } from '../format';
import { useI18n } from '../i18n';

export default function MediaIndexPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<MediaIndexStatus | null>(null);
  const [olderJobs, setOlderJobs] = useState<MediaIndexJob[]>([]);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activeRequests = useRef<Set<AbortController>>(new Set());

  function mediaStageLabel(stage: string | null): string {
    const keys: Record<string, Parameters<typeof t>[0]> = {
      opening_source: 'stage.reading',
      copying_source: 'stage.reading',
      checking_dimensions: 'stage.dims',
      thumbnailing_viewer: 'stage.viewer',
      thumbnailing_card: 'stage.card',
      extracting_video_poster: 'stage.poster_extract',
      encoding_video_poster: 'stage.poster_encode',
      transcoding_video_preview: 'stage.video',
      extracting_face_frame: 'stage.face_frame',
      detecting_faces: 'stage.faces',
      publishing_viewer: 'stage.pub_viewer',
      publishing_card: 'stage.pub_card',
      publishing_video_poster: 'stage.pub_poster',
      publishing_video_preview: 'stage.pub_video'
    };
    return stage ? t(keys[stage] ?? 'stage.processing') : t('stage.starting');
  }

  function mediaTaskLabel(task: string): string {
    switch (task) {
      case 'image_preview': return t('task.image_preview');
      case 'video_thumbnail': return t('task.video_thumbnail');
      case 'video_preview': return t('task.video_preview');
      case 'face_index': return t('task.face_index');
      default: return t('task.media_job');
    }
  }

  function mediaFailureLabel(code: string | null): string {
    const keys: Record<string, Parameters<typeof t>[0]> = {
      unsupported_format: 'failure.unsupported',
      decode_failed: 'failure.decode',
      input_missing: 'failure.missing',
      resource_limit: 'failure.limit',
      preview_storage_unavailable: 'failure.storage',
      detector_unavailable: 'failure.detector',
      processing_failed: 'failure.generic'
    };
    return code ? t(keys[code] ?? 'failure.generic') : t('failure.generic');
  }

  useEffect(() => {
    let closed = false;
    let timer: number | undefined;
    const poll = async () => {
      const controller = new AbortController();
      activeRequests.current.add(controller);
      try {
        const result = await api.mediaIndexStatus(controller.signal);
        if (!closed) {
          setStatus(result);
          setError('');
          if (olderJobs.length === 0) setOlderCursor(result.nextBeforeId);
        }
      } catch (cause: unknown) {
        if (!closed && !controller.signal.aborted) setError(friendlyError(cause));
      } finally {
        activeRequests.current.delete(controller);
        if (!closed) timer = window.setTimeout(() => void poll(), 15000);
      }
    };
    void poll();
    return () => {
      closed = true;
      if (timer != null) window.clearTimeout(timer);
      activeRequests.current.forEach((controller) => controller.abort());
      activeRequests.current.clear();
    };
  }, [reloadKey, olderJobs.length]);

  async function runAction(action: 'pause' | 'resume' | 'retry' | 'retry-all', jobId?: number) {
    const key = jobId == null ? action : 'retry-' + jobId;
    const controller = new AbortController();
    activeRequests.current.add(controller);
    setBusyAction(key);
    setError('');
    setNotice('');
    try {
      if (action === 'pause' || action === 'resume') {
        const result = await api.setMediaIndexPaused(action === 'pause', controller.signal);
        if (!controller.signal.aborted) {
          setStatus((current) => current ? { ...current, paused: result.paused } : current);
          setNotice(result.paused ? t('media.paused') : t('media.resumed'));
        }
      } else {
        const result = await api.retryMediaIndex(jobId, controller.signal);
        if (!controller.signal.aborted) {
          setOlderJobs((jobs) => jobs.filter((job) => jobId == null || job.id !== jobId));
          setNotice(result.retried === 1 ? t('media.retry_one') : t('media.retry_n', { count: result.retried }));
        }
      }
      if (!controller.signal.aborted) setReloadKey((value) => value + 1);
    } catch (cause: unknown) {
      if (!controller.signal.aborted) setError(friendlyError(cause));
    } finally {
      activeRequests.current.delete(controller);
      if (!controller.signal.aborted) setBusyAction(null);
    }
  }

  async function loadOlderJobs() {
    if (olderCursor == null || loadingOlder) return;
    const controller = new AbortController();
    activeRequests.current.add(controller);
    setLoadingOlder(true);
    try {
      const page = await api.mediaIndexStatus(controller.signal, olderCursor);
      if (!controller.signal.aborted) {
        setOlderJobs((jobs) => {
          const existing = new Set(jobs.map((job) => job.id));
          return [...jobs, ...page.jobs.filter((job) => !existing.has(job.id))];
        });
        setOlderCursor(page.nextBeforeId);
      }
    } catch (cause: unknown) {
      if (!controller.signal.aborted) setError(friendlyError(cause));
    } finally {
      activeRequests.current.delete(controller);
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }

  const allJobs = status ? [...status.jobs, ...olderJobs] : olderJobs;
  const failedJobs = allJobs.filter((job) => job.state === 'failed');
  const visibleFailures = failedJobs.slice(0, 4);
  const counts = status?.counts;
  const activeJob = status?.jobs.find((job) => job.state === 'running');

  return (
    <section className="media-index-panel" id="media-index-panel" aria-labelledby="media-index-title">
      <div className="media-index-header">
        <div>
          <span className="eyebrow">{t('media.eyebrow')}</span>
          <h2 id="media-index-title">{t('media.title')}</h2>
          <p>{t('media.subtitle')}</p>
        </div>
        <button className="icon-button media-index-close" type="button" onClick={onClose} aria-label={t('media.close')}><X size={18} /></button>
      </div>

      {error ? <div className="media-index-message media-index-error" role="alert">{error}</div> : null}
      {notice ? <div className="media-index-message media-index-notice" role="status">{notice}</div> : null}

      {status ? (
        <>
          <div className="media-index-toolbar">
            <span className={'media-index-health ' + (status.previewStorageAvailable ? 'is-healthy' : 'is-unhealthy')} role="status">
              <i /> {t('media.ssd', { state: t(status.previewStorageAvailable ? 'media.ssd_ok' : 'media.ssd_bad') })}
            </span>
            <div className="media-index-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={busyAction != null}
                onClick={() => void runAction(status.paused ? 'resume' : 'pause')}
              >
                {status.paused ? <Play size={15} /> : <Pause size={15} />}
                {status.paused ? t('media.resume') : t('media.pause')}
              </button>
              {status.counts.failed > 0 ? (
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={busyAction != null}
                  onClick={() => void runAction('retry-all')}
                >
                  <RotateCcw size={15} /> {t('media.retry_all')}
                </button>
              ) : null}
            </div>
          </div>

          <div className="media-index-metrics" aria-label={t('media.metrics_label')}>
            <div><span>{t('media.queued')}</span><strong>{counts?.queued ?? 0}</strong></div>
            <div><span>{t('media.running')}</span><strong>{counts?.running ?? 0}</strong></div>
            <div><span>{t('media.completed')}</span><strong>{counts?.completed ?? 0}</strong></div>
            <div><span>{t('media.unsupported')}</span><strong>{counts?.unsupported ?? 0}</strong></div>
            <div><span>{t('media.retry_wait')}</span><strong>{counts?.retryWait ?? 0}</strong></div>
            <div><span>{t('media.failed')}</span><strong>{counts?.failed ?? 0}</strong></div>
          </div>

          <div className="media-index-byte-stats">
            <div><span>{t('media.bytes_pending')}</span><strong>{formatSize(status.pendingBytes)}</strong></div>
            <div><span>{t('media.bytes_active')}</span><strong>{formatSize(status.processedBytes)}</strong></div>
          </div>

          {status.taskMetrics?.length ? (
            <div className="media-index-task-metrics" aria-label={t('media.tasks_label')}>
              {status.taskMetrics.map((metric) => (
                <article key={metric.task}>
                  <div className="media-index-task-heading">
                    <strong>{mediaTaskLabel(metric.task)}</strong>
                    <span>{metric.counts.running > 0 ? t('media.running_n', { count: metric.counts.running }) : t('media.idle')}</span>
                  </div>
                  <div className="media-index-task-counts">
                    <span>{t('media.n_queued', { count: metric.counts.queued })}</span>
                    <span>{t('media.n_done', { count: metric.counts.completed })}</span>
                    <span>{t('media.n_failed', { count: metric.counts.failed })}</span>
                  </div>
                  <div className="media-index-task-bytes">
                    <span>{t('media.pending', { size: formatSize(metric.pendingBytes) })}</span>
                    <span>{t('media.active', { size: formatSize(metric.processedBytes) })}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : null}

          <div className="media-index-active" aria-live="polite">
            <Activity size={16} />
            {activeJob ? (
              <span><strong>{activeJob.fileName}</strong> · {mediaTaskLabel(activeJob.task)} · {mediaStageLabel(activeJob.currentStage)} · {formatSize(activeJob.processedBytes)} / {formatSize(activeJob.totalBytes)}</span>
            ) : <span>{t('media.none_running')}</span>}
          </div>

          <div className="media-index-failures">
            <div className="media-index-subhead"><strong>{t('media.recent_failures')}</strong><span>{t('media.total', { count: counts?.failed ?? 0 })}</span></div>
            {visibleFailures.length ? (
              <ul>
                {visibleFailures.map((job) => (
                  <li key={job.id}>
                    <div><strong title={job.fileName}>{job.fileName}</strong><span>{mediaTaskLabel(job.task)} · {mediaFailureLabel(job.errorCode)}</span></div>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={busyAction != null}
                      onClick={() => void runAction('retry', job.id)}
                      aria-label={t('media.retry_label', { name: job.fileName })}
                    >
                      <RotateCcw size={14} /> {t('media.retry')}
                    </button>
                  </li>
                ))}
              </ul>
            ) : counts?.failed ? (
              <p className="media-index-empty">{t('media.older_hint')}</p>
            ) : (
              <p className="media-index-empty">{t('media.no_failed')}</p>
            )}
            {olderCursor != null && failedJobs.length < (counts?.failed ?? 0) ? (
              <button className="load-more media-index-load-more" type="button" disabled={loadingOlder} onClick={() => void loadOlderJobs()}>
                {loadingOlder ? t('media.loading_older') : t('media.load_older')}
              </button>
            ) : null}
            {failedJobs.length > visibleFailures.length ? <p className="media-index-empty">{t('media.showing_n', { count: failedJobs.length })}</p> : null}
          </div>
        </>
      ) : (
        <div className="media-index-loading" role="status">{t('media.loading')}</div>
      )}
    </section>
  );
}
