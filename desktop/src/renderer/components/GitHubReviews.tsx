import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReviewPreview, ReviewPreviewState } from '../../../../shared/github-previews';
import './GitHubReviews.css';

export function GitHubReviews() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ReviewPreviewState>({ repositories: [], reviews: [] });
  const [draft, setDraft] = useState<ReviewPreview | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [repository, setRepository] = useState('');
  const [instructionsPath, setInstructionsPath] = useState('');
  const [enabled, setEnabled] = useState(true);
  const refresh = async () => {
    try {
      const result = await window.electronAPI.getGitHubPreviews();
      if (!result.ok) throw new Error(result.error);
      setData(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load review drafts.'); }
  };
  useEffect(() => {
    if (typeof window.electronAPI?.getGitHubPreviews !== 'function') return;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (draft && !dirty) setDraft(data.reviews.find(r => r.id === draft.id) ?? null);
  }, [data]);
  const action = async (payload: unknown) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.electronAPI.githubPreviewAction(payload);
      if (!result.ok) throw new Error(result.error);
      setDirty(false); setData(result);
      if (draft) setDraft(result.reviews.find((r: ReviewPreview) => r.id === draft.id) ?? null);
      return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Review action failed.'); return false; }
    finally { setBusy(false); }
  };
  const select = (review: ReviewPreview) => {
    if (dirty && !window.confirm('Discard unsaved edits?')) return;
    setDraft(structuredClone(review)); setDirty(false); setError(''); setNotice('');
  };
  const edit = (update: Partial<ReviewPreview>) => { if (draft) { setDraft({ ...draft, ...update }); setDirty(true); } };
  const close = () => { if (!dirty || window.confirm('Discard unsaved edits?')) { setOpen(false); setDraft(null); setDirty(false); } };
  const ready = data.reviews.filter(r => r.status === 'ready').length;
  return <>
    <button className="btn-xs" onClick={() => { setOpen(true); void refresh(); }}>PR reviews{ready ? ` (${ready})` : ''}</button>
    {open && createPortal(<div className="modal-overlay">
      <section className="modal github-reviews" role="dialog" aria-modal="true" aria-labelledby="github-reviews-title">
        <header><div><h2 id="github-reviews-title">PR prevalidation</h2><p>Codex prepares a private draft. You choose what to send to GitHub.</p></div><button className="btn-xs" onClick={close}>Close</button></header>
        {error && <p role="alert" className="review-error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <details>
          <summary>Automatic review settings</summary>
          <p>Choose the repositories to analyze and your local AGENTS.md. Repository AGENTS.md files from the base commit are also included.</p>
          <form onSubmit={async event => {
            event.preventDefault();
            if (await action({ action: 'configure', repository, instructionsPath, enabled })) {
              setNotice('Settings saved. The next GitHub refresh will queue matching review requests.');
              try { await window.electronAPI.pollGitHub(); await refresh(); } catch (reason) { setError(String(reason)); }
            }
          }}>
            <label>Repository <input value={repository} placeholder="owner/repository" required onChange={e => setRepository(e.target.value)} /></label>
            <label>Review instructions <input value={instructionsPath} placeholder="C:\reviews\AGENTS.md" required={enabled} onChange={e => setInstructionsPath(e.target.value)} /></label>
            <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Automatically prevalidate review requests</label>
            <button className="btn-xs" disabled={busy}>Save settings</button>
          </form>
          {data.repositories.map(config => <button className="btn-xs" key={config.repository} onClick={() => {
            setRepository(config.repository); setInstructionsPath(config.instructionsPath); setEnabled(config.enabled);
          }}>{config.repository} · {config.enabled ? 'On' : 'Off'}</button>)}
        </details>
        <div className="review-columns">
          <nav aria-label="Pull request drafts">
            {!data.reviews.length && <p>No prevalidations yet. Configure a repository above, then refresh GitHub.</p>}
            {data.reviews.map(review => <button key={review.id} className={draft?.id === review.id ? 'selected' : ''} onClick={() => select(review)}>
              <strong>{review.repository} #{review.number}</strong><span>{review.title}</span><small>{review.status} · {review.comments.length} comments</small>
            </button>)}
          </nav>
          <main>
            {!draft ? <p>Select a PR to read its prevalidation.</p> : <>
              <h3>{draft.title}</h3><a href={draft.url} target="_blank" rel="noreferrer">Open PR #{draft.number} on GitHub</a>
              <p>Status: {draft.status}{draft.headSha ? ` · Commit ${draft.headSha.slice(0, 8)}` : ''}</p>
              {draft.error && <p role="alert" className="review-error">{draft.error}</p>}
              {draft.status === 'queued' || draft.status === 'running' ? <p>Analyzing the changes and review instructions…</p> : null}
              <details><summary>Instructions used</summary><ul>{draft.instructions.map(p => <li key={p}>{p}</li>)}</ul></details>
              {draft.status === 'ready' || draft.status === 'exported' ? <>
                <label>Review summary<textarea rows={5} value={draft.summary} disabled={busy || draft.status !== 'ready'} onChange={e => edit({ summary: e.target.value })} /></label>
                {draft.comments.length === 0 && <p>No inline comments. Check the summary for findings and coverage limits.</p>}
                {draft.comments.map(comment => <article className="review-comment" key={comment.id}>
                  <strong>{comment.path}:{comment.line}</strong>
                  <textarea aria-label={`Comment on ${comment.path} line ${comment.line}`} rows={4} value={comment.body} disabled={busy || draft.status !== 'ready'} onChange={e => edit({ comments: draft.comments.map(c => c.id === comment.id ? { ...c, body: e.target.value } : c) })} />
                  {draft.status === 'ready' && <button className="btn-xs" disabled={busy} onClick={() => edit({ comments: draft.comments.filter(c => c.id !== comment.id) })}>Delete comment</button>}
                </article>)}
                {draft.status === 'ready' ? <div className="review-actions">
                  <button className="btn-xs" disabled={busy || !dirty} onClick={async () => {
                    if (await action({ action: 'save', ...draft })) setNotice('Draft saved locally.');
                  }}>Save draft</button>
                  <button className="btn-xs" disabled={busy || dirty} onClick={async () => {
                    if (await action({ action: 'export', id: draft.id, revision: draft.revision })) setNotice('Pending review created under your GitHub account. Open GitHub to edit or submit it.');
                  }}>Create pending review on GitHub</button>
                  {dirty && <small>Save your edits before exporting.</small>}
                </div> : <p>This draft was transferred to GitHub. Edit, delete or submit the pending review there.</p>}
              </> : null}
              {draft.status === 'error' && <button className="btn-xs" disabled={busy} onClick={() => void action({ action: 'retry', id: draft.id })}>Retry analysis</button>}
              {draft.status !== 'queued' && draft.status !== 'running' && <button className="btn-xs" disabled={busy} onClick={() => {
                if (window.confirm('Delete this local draft? GitHub reviews are not deleted. If automatic review is enabled, the next refresh can create a new analysis.')) void action({ action: 'delete', id: draft.id });
              }}>Delete local draft</button>}
            </>}
          </main>
        </div>
      </section>
    </div>, document.body)}
  </>;
}
