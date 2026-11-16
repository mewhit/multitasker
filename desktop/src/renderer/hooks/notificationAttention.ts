interface AttentionItem {
  key: string;
  source: string;
  status?: string;
  startDate: number;
}

// Acknowledgements last for one attention episode, not the lifetime of a task.
export class NotificationAttention {
  private pending = new Map<string, number>();
  private acknowledged = new Map<string, number>();

  update(items: readonly AttentionItem[], now: number): boolean {
    this.pending = new Map(items.filter(item => item.source === 'session'
      ? item.status === 'needs_attention'
      : item.startDate <= now + (item.source === 'google-calendar' ? 300_000 : 0)
    ).map(item => [item.key, item.source === 'session' ? 0 : item.startDate]));
    for (const [key, episode] of this.acknowledged) {
      if (this.pending.get(key) !== episode) this.acknowledged.delete(key);
    }
    return this.hasPending();
  }

  acknowledge(key: string): boolean {
    const episode = this.pending.get(key);
    if (episode !== undefined) this.acknowledged.set(key, episode);
    return this.hasPending();
  }

  private hasPending(): boolean {
    return [...this.pending].some(([key, episode]) => this.acknowledged.get(key) !== episode);
  }
}
