import type { Session, TerminalBinding } from '../../desktop/sessionManager';
import type { ShellType, SlackNotificationState, ManualTaskState, RecurringTaskState } from '../../desktop/settings';

export type SlackNotificationPriorityLabel = NonNullable<SlackNotificationState['priorityLabel']>;

export interface SlackNotificationPriority {
  rank: number;
  label: SlackNotificationPriorityLabel;
}

export interface SlackNotificationPriorityDecision extends SlackNotificationPriority {
  reason: string;
  mentionsAuthedUser: boolean;
  directMessage: boolean;
  threadReply: boolean;
  threadWrittenByAuthedUser: boolean;
  threadTs?: string;
}

export interface SlackChannelInfo {
  id?: string;
  name: string;
  isUserMember?: boolean;
  type: string;
}

export interface MultitaskerCreateSessionRequest {
  id?: string;
  name: string;
  cmd: string;
  cwd: string;
  shellType: ShellType;
  sshCommand?: string;
  terminalRef?: string;
  terminalPid?: number;
  terminalName?: string;
  launchId?: string;
}

export interface SlackNotificationDismissRequest {
  channelId: string;
  teamId?: string;
  channelType?: string;
  reason?: string;
  targetTs?: string;
  replyTs?: string;
  ts?: string;
  receivedAt?: number;
}

export interface TerminalEventIdentity {
  explicitTaskId: string;
  terminalRef: string;
  launchId: string;
  terminalPid: number | undefined;
  terminalName: string;
  terminalCwd: string;
}

export interface BackendState {
  sessions: Session[];
  manualTasks: ManualTaskState[];
  recurringTasks: RecurringTaskState[];
  slackNotifications: SlackNotificationState[];
}

export interface GoogleCalendarOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  requested_reviewers?: Array<{ login?: string }>;
  draft?: boolean;
}

export { TerminalBinding };
