export interface JiraConnectionState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  cloudId: string;
  siteName: string;
  siteUrl: string;
  connectedAt: number;
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
}

export interface JiraOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  preferredSiteUrl: string;
}

export interface JiraResource {
  id: string;
  name: string;
  url: string;
  scopes: string[];
}

export interface JiraPollResult {
  issueCount: number;
  newIssueCount: number;
  skipped?: 'not_connected' | 'already_running';
}
