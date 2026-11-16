import { useEffect, useState } from 'react';
import type {
  GitHubActionResult,
  GitHubStatus,
  JiraActionResult,
  JiraStatus,
  SlackAuthStatus,
  SlackWorkspaceSummary,
} from '../../preload/preload';

export function PluginMenu() {
  const [managerOpen, setManagerOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<SlackWorkspaceSummary[]>([]);
  const [jiraStatus, setJiraStatus] = useState<JiraStatus | null>(null);
  const [githubStatus, setGitHubStatus] = useState<GitHubStatus | null>(null);
  const [aiInstalled, setAiInstalled] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const loadWorkspaces = async () => {
    const getWorkspaces = window.electronAPI?.getSlackWorkspaces;
    if (typeof getWorkspaces !== 'function') return;
    try {
      setWorkspaces(await getWorkspaces());
    } catch (error) {
      setStatus(`Could not load Slack workspaces: ${errorMessage(error)}`);
    }
  };

  const loadPlugins = async () => {
    try {
      const installedPlugins = await window.electronAPI.getInstalledPlugins() as string[];
      setAiInstalled(installedPlugins.includes('ai'));
    } catch (error) {
      setStatus(`Could not load plugins: ${errorMessage(error)}`);
    }
  };

  const loadJiraStatus = async () => {
    const getJiraStatus = window.electronAPI?.getJiraStatus;
    if (typeof getJiraStatus !== 'function') return;
    try {
      setJiraStatus(await getJiraStatus());
    } catch (error) {
      setStatus(`Could not load Jira status: ${errorMessage(error)}`);
    }
  };

  const loadGitHubStatus = async () => {
    const getGitHubStatus = window.electronAPI?.getGitHubStatus;
    if (typeof getGitHubStatus !== 'function') return;
    try {
      setGitHubStatus(await getGitHubStatus());
    } catch (error) {
      setStatus(`Could not load GitHub status: ${errorMessage(error)}`);
    }
  };

  useEffect(() => {
    void loadWorkspaces();
    void loadPlugins();
    void loadJiraStatus();
    void loadGitHubStatus();
    window.electronAPI?.onSlackAuthStatus?.((nextStatus: SlackAuthStatus) => {
      setBusy(false);
      setStatus(nextStatus.message);
      if (nextStatus.ok) void loadWorkspaces();
    });
  }, []);

  useEffect(() => {
    if (!managerOpen) return;
    void loadJiraStatus();
    void loadGitHubStatus();
    const timer = window.setInterval(() => {
      void loadJiraStatus();
      void loadGitHubStatus();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [managerOpen]);

  const openManager = () => {
    setManagerOpen(true);
    setBusy(false);
    setStatus('');
    void loadWorkspaces();
    void loadPlugins();
    void loadJiraStatus();
    void loadGitHubStatus();
  };

  useEffect(() => window.electronAPI?.onOpenPluginManager?.(openManager), []);

  const setAiPluginInstalled = async (installed: boolean) => {
    if (busy) return;
    setBusy(true);
    setStatus(installed ? 'Installing AI plugin...' : 'Removing AI plugin...');
    try {
      const installedPlugins = await window.electronAPI.setPluginInstalled('ai', installed) as string[];
      setAiInstalled(installed);
      setStatus(installed ? 'AI plugin installed. Slack rewrite is now available.' : 'AI plugin removed. Slack rewrite is unavailable.');
      window.dispatchEvent(new CustomEvent('multitasker:plugins-changed', { detail: { installedPlugins } }));
    } catch (error) {
      setStatus(`Could not ${installed ? 'install' : 'remove'} AI plugin: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const addWorkspace = async () => {
    if (busy) return;
    setBusy(true);
    setStatus('Opening Slack authorization...');
    try {
      const result: SlackAuthStatus = await window.electronAPI.startSlackAuth();
      setStatus(result.message);
      if (!result.ok) setBusy(false);
    } catch (error) {
      setBusy(false);
      setStatus(`Could not start Slack authorization: ${errorMessage(error)}`);
    }
  };

  const removeWorkspace = async (workspace: SlackWorkspaceSummary) => {
    if (!window.confirm(`Remove ${workspace.teamName} from the Slack plugin?`)) return;
    try {
      const removed = await window.electronAPI.removeSlackWorkspace(workspace.teamId);
      setStatus(removed ? `${workspace.teamName} was removed.` : `${workspace.teamName} could not be removed.`);
      await loadWorkspaces();
    } catch (error) {
      setStatus(`Could not remove ${workspace.teamName}: ${errorMessage(error)}`);
    }
  };

  const connectJira = async () => {
    if (busy) return;
    setBusy(true);
    setStatus('Opening Jira authorization...');
    try {
      const result: JiraActionResult = await window.electronAPI.connectJira();
      setJiraStatus(result.status);
      setStatus(result.message);
    } catch (error) {
      setStatus(`Could not start Jira authorization: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const disconnectJira = async () => {
    if (busy || !jiraStatus?.connected) return;
    if (!window.confirm(`Disconnect Jira${jiraStatus.site?.name ? ` from ${jiraStatus.site.name}` : ''}?`)) return;
    setBusy(true);
    try {
      const result: JiraActionResult = await window.electronAPI.disconnectJira();
      setJiraStatus(result.status);
      setStatus(result.message);
    } catch (error) {
      setStatus(`Could not disconnect Jira: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const pollJira = async () => {
    if (busy || !jiraStatus?.connected) return;
    setBusy(true);
    setStatus('Refreshing Jira tickets...');
    try {
      const result: JiraActionResult = await window.electronAPI.pollJira();
      setJiraStatus(result.status);
      setStatus(result.message);
    } catch (error) {
      setStatus(`Could not refresh Jira tickets: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const connectGitHub = async () => {
    if (busy) return;
    setBusy(true);
    setStatus('Opening GitHub authorization...');
    try {
      const result: GitHubActionResult = await window.electronAPI.connectGitHub();
      setGitHubStatus(result.status);
      setStatus(result.message);
    } catch (error) {
      setStatus(`Could not start GitHub authorization: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const disconnectGitHub = async () => {
    if (busy || githubStatus?.authMode !== 'oauth') return;
    if (!window.confirm(`Disconnect GitHub${githubStatus.account?.login ? ` account ${githubStatus.account.login}` : ''}?`)) return;
    setBusy(true);
    try {
      const result: GitHubActionResult = await window.electronAPI.disconnectGitHub();
      setGitHubStatus(result.status);
      setStatus(result.message);
    } catch (error) {
      setStatus(`Could not disconnect GitHub: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const pollGitHub = async () => {
    if (busy || !githubStatus?.connected) return;
    setBusy(true);
    setStatus('Refreshing GitHub review requests...');
    try {
      const result: GitHubActionResult = await window.electronAPI.pollGitHub();
      setGitHubStatus(result.status);
      setStatus(result.message);
    } catch (error) {
      setStatus(`Could not refresh GitHub review requests: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {managerOpen ? (
        <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setManagerOpen(false); }}>
          <div className="modal plugin-manager" role="dialog" aria-modal="true" aria-labelledby="plugin-manager-title">
            <div className="plugin-manager-header">
              <div>
                <div className="plugin-title-line"><h2 id="plugin-manager-title">Plugins</h2></div>
                <p>Install capabilities and manage connected services.</p>
              </div>
              <button className="btn-xs" aria-label="Close" onClick={() => setManagerOpen(false)}>x</button>
            </div>

            <div className="plugin-workspace-list">
              <section className="plugin-workspace">
                <div className="plugin-workspace-heading">
                  <div>
                    <strong>AI</strong>
                    <span>Enables /rewrite in Slack conversations using Codex.</span>
                  </div>
                  <button
                    className={`btn${aiInstalled ? ' btn-danger' : ' btn-primary'}`}
                    disabled={busy}
                    onClick={() => { void setAiPluginInstalled(!aiInstalled); }}
                  >
                    {aiInstalled ? 'Remove' : 'Install'}
                  </button>
                </div>
              </section>
              <section className="plugin-workspace">
                <div className="plugin-workspace-heading">
                  <div>
                    <strong>Jira</strong>
                    <span>{jiraStatus?.connected
                      ? `Connected to ${jiraStatus.site?.name || jiraStatus.site?.url || 'Jira'}`
                      : jiraStatus?.configured
                        ? 'Connect Atlassian to import new refinement tickets into next-up.'
                        : 'Configure Jira OAuth credentials in the HTTP server environment first.'}</span>
                  </div>
                  <div className="plugin-actions">
                    {jiraStatus?.connected ? (
                      <button className="btn" disabled={busy} onClick={() => { void pollJira(); }}>Poll now</button>
                    ) : null}
                    <button className="btn btn-primary" disabled={busy} onClick={() => { void connectJira(); }}>
                      {jiraStatus?.connected ? 'Reconnect' : 'Connect'}
                    </button>
                    {jiraStatus?.connected ? (
                      <button className="btn btn-danger" disabled={busy} onClick={() => { void disconnectJira(); }}>Disconnect</button>
                    ) : null}
                  </div>
                </div>
                {jiraStatus ? (
                  <div className="plugin-integration-details">
                    <span>Query <code>{jiraStatus.jql}</code></span>
                    <span>Every {jiraStatus.pollMinutes} minutes</span>
                    <span>{jiraStatus.trackedIssueCount} tracked {jiraStatus.trackedIssueCount === 1 ? 'ticket' : 'tickets'}</span>
                    {jiraStatus.lastPolledAt ? <span>Last poll {formatTimestamp(jiraStatus.lastPolledAt)}</span> : null}
                    {jiraStatus.lastError ? <span className="plugin-error">{jiraStatus.lastError}</span> : null}
                  </div>
                ) : null}
              </section>
              <section className="plugin-workspace">
                <div className="plugin-workspace-heading">
                  <div>
                    <strong>GitHub</strong>
                    <span>{githubStatus?.connected
                      ? `Monitoring unread review requests${githubStatus.account?.login ? ` for ${githubStatus.account.login}` : ''}.`
                      : githubStatus?.oauthConfigured
                        ? 'Connect GitHub to import pull requests awaiting your review into next-up.'
                        : githubStatus?.configured
                          ? 'A GitHub token is configured, but it could not be connected.'
                          : 'Configure GitHub OAuth credentials in the HTTP server environment first.'}</span>
                  </div>
                  <div className="plugin-actions">
                    {githubStatus?.connected ? (
                      <button className="btn" disabled={busy} onClick={() => { void pollGitHub(); }}>Poll now</button>
                    ) : null}
                    {githubStatus?.oauthConfigured ? (
                      <button className="btn btn-primary" disabled={busy} onClick={() => { void connectGitHub(); }}>
                        {githubStatus.connected ? 'Reconnect' : 'Connect'}
                      </button>
                    ) : null}
                    {githubStatus?.authMode === 'oauth' ? (
                      <button className="btn btn-danger" disabled={busy} onClick={() => { void disconnectGitHub(); }}>Disconnect</button>
                    ) : null}
                  </div>
                </div>
                {githubStatus ? (
                  <div className="plugin-integration-details">
                    <span>All repositories</span>
                    <span>Every {githubStatus.pollMinutes} minutes</span>
                    <span>{githubStatus.trackedReviewRequestCount} active review {githubStatus.trackedReviewRequestCount === 1 ? 'request' : 'requests'}</span>
                    {githubStatus.authMode === 'token' ? <span>Using environment token</span> : null}
                    {githubStatus.lastPolledAt ? <span>Last poll {formatTimestamp(githubStatus.lastPolledAt)}</span> : null}
                    {githubStatus.lastError ? <span className="plugin-error">{githubStatus.lastError}</span> : null}
                  </div>
                ) : null}
              </section>
              <section className="plugin-workspace">
                <div className="plugin-workspace-heading">
                  <div>
                    <strong>Slack</strong>
                    <span>Manage the workspaces connected to this plugin.</span>
                  </div>
                  <button className="btn btn-primary" disabled={busy} onClick={() => { void addWorkspace(); }}>
                    + Add workspace
                  </button>
                </div>
              </section>
              {workspaces.length === 0 ? <div className="plugin-empty">No Slack workspace is connected yet.</div> : null}
              {workspaces.map((workspace) => (
                <section className="plugin-workspace" key={workspace.teamId}>
                  <div className="plugin-workspace-heading">
                    <div>
                      <strong>{workspace.teamName}</strong>
                      <span>{workspace.teamId}</span>
                    </div>
                    <button className="btn btn-danger" onClick={() => { void removeWorkspace(workspace); }}>Remove</button>
                  </div>
                  <ScopeList label="User scopes" scopes={workspace.userScopes} />
                  <ScopeList label="Bot scopes" scopes={workspace.botScopes} />
                </section>
              ))}
            </div>
            {status ? <div className="plugin-status" role="status">{status}</div> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function ScopeList({ label, scopes }: { label: string; scopes: string[] }) {
  return (
    <div className="plugin-scopes">
      <span>{label}</span>
      <div>{scopes.length > 0 ? scopes.map((scope) => <code key={scope}>{scope}</code>) : <em>None reported</em>}</div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}
