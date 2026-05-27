import { getSlackAuthedUserId } from '../../state/slack';
import { readSlackRecord, readSlackString, isRawSlackId } from './parse';
import { getSlackUserName } from './users';

export function slackEventMentionsUser(event: Record<string, unknown>): boolean {
  const authedUserId = getSlackAuthedUserId();
  if (!authedUserId) return false;

  const blocks = event['blocks'];
  if (Array.isArray(blocks) && mentionedInSlackBlocks(blocks, authedUserId)) {
    return true;
  }

  const text = readSlackString(event, 'text');
  if (text.includes(`<@${authedUserId}>`)) {
    return true;
  }

  return false;
}

function mentionedInSlackBlocks(blocks: unknown[], userId: string): boolean {
  for (const block of blocks) {
    const blockRecord = readSlackRecord(block);
    if (!blockRecord) continue;

    const elements = blockRecord['elements'];
    if (Array.isArray(elements)) {
      for (const element of elements) {
        const elementRecord = readSlackRecord(element);
        if (!elementRecord) continue;

        const elementType = readSlackString(elementRecord, 'type');
        if (elementType === 'user' && readSlackString(elementRecord, 'user_id') === userId) {
          return true;
        }
        if (elementType === 'rich_text_section' || elementType === 'rich_text_list' || elementType === 'rich_text_preformatted' || elementType === 'rich_text_quote') {
          const nestedElements = elementRecord['elements'];
          if (Array.isArray(nestedElements) && mentionedInSlackBlocks(nestedElements, userId)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

export async function resolveSlackMessageMentions(text: string): Promise<string> {
  if (!text) return text;

  const mentionPattern = /<@([A-Z][A-Z0-9]{8,})(?:\|[^>]*)?>/g;
  const matches: Array<{ userId: string; fullMatch: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(text)) !== null) {
    const userId = match[1];
    if (userId && isRawSlackId(userId)) {
      matches.push({ userId, fullMatch: match[0] });
    }
  }

  if (matches.length === 0) return text;

  const uniqueUserIds = [...new Set(matches.map(m => m.userId))];
  const names = await Promise.all(uniqueUserIds.map(getSlackUserName));
  const nameMap = new Map<string, string>();
  for (let i = 0; i < uniqueUserIds.length; i++) {
    const id = uniqueUserIds[i];
    const name = names[i];
    if (id && name) {
      nameMap.set(id, name);
    }
  }

  let result = text;
  for (const { userId, fullMatch } of matches) {
    const name = nameMap.get(userId);
    if (name && name !== userId) {
      result = result.replace(fullMatch, `@${name}`);
    }
  }
  return result;
}
