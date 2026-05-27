export const seenGitHubReviewRequestKeys = new Set<string>();

let githubReviewTimer: ReturnType<typeof setInterval> | null = null;
let githubReviewPollInFlight = false;

export function getGitHubReviewTimer(): ReturnType<typeof setInterval> | null {
  return githubReviewTimer;
}

export function setGitHubReviewTimer(timer: ReturnType<typeof setInterval> | null): void {
  githubReviewTimer = timer;
}

export function isGitHubReviewPollInFlight(): boolean {
  return githubReviewPollInFlight;
}

export function setGitHubReviewPollInFlight(value: boolean): void {
  githubReviewPollInFlight = value;
}
