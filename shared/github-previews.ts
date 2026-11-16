export interface ReviewCommentDraft {
  id: string;
  path: string;
  line: number;
  body: string;
}

export interface ReviewRepositoryConfig {
  repository: string;
  instructionsPath: string;
  enabled: boolean;
}

export interface ReviewPreview {
  id: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  status: 'queued' | 'running' | 'ready' | 'error' | 'exported';
  summary: string;
  comments: ReviewCommentDraft[];
  instructions: string[];
  error: string;
  updatedAt: number;
  revision: number;
  githubReviewId?: number;
}

export interface ReviewPreviewState {
  repositories: ReviewRepositoryConfig[];
  reviews: ReviewPreview[];
}
