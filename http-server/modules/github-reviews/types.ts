export interface GitHubConnectionState {
  accessToken: string;
  tokenType: string;
  scope: string;
  login: string;
  avatarUrl: string;
  profileUrl: string;
  connectedAt: number;
}

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GitHubNotification {
  id: string;
  reason: string;
  unread: boolean;
  repositoryFullName: string;
  repositoryUrl: string;
  subjectTitle: string;
  subjectType: string;
  subjectUrl: string;
}

export interface GitHubPollResult {
  reviewRequestCount: number;
  newReviewRequestCount: number;
  skipped?: 'not_connected' | 'already_running';
}

export interface GitHubViewer {
  login: string;
  avatarUrl: string;
  profileUrl: string;
}
