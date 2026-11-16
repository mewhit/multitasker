/** Reads OSC 7 directory reports without guessing from commands or prompt text. */
export class CurrentDirectoryParser {
  private pending = '';

  push(data: string): string | undefined {
    const input = this.pending + data;
    this.pending = '';
    let latest: string | undefined;
    let offset = 0;
    while (offset < input.length) {
      const start = input.indexOf('\x1b]', offset);
      if (start < 0) {
        if (input.endsWith('\x1b')) this.pending = '\x1b';
        break;
      }
      const end = /\x07|\x1b\\/.exec(input.slice(start + 2));
      if (!end) {
        if (input.length - start <= 32768) this.pending = input.slice(start);
        break;
      }
      const value = input.slice(start + 2, start + 2 + end.index);
      offset = start + 2 + end.index + end[0].length;
      if (!value.startsWith('7;file://')) continue;
      try {
        const url = new URL(value.slice(2));
        let cwd = decodeURIComponent(url.pathname);
        if (/^\/[a-z]:\//i.test(cwd)) cwd = cwd.slice(1).replace(/\//g, '\\');
        if (cwd && !/[\x00-\x1f\x7f]/.test(cwd)) latest = cwd;
      } catch { /* Ignore malformed terminal reports. */ }
    }
    return latest;
  }
}

// Wrap the existing prompt after profiles load, preserving customized prompts.
export const POWERSHELL_DIRECTORY_PROMPT = `$global:MultitaskerOriginalPrompt = $function:prompt; function global:prompt { $p = Get-Location; if ($p.Provider.Name -eq 'FileSystem') { $u = [System.Uri]::new($p.ProviderPath); [Console]::Write(([char]27).ToString() + ']7;' + $u.AbsoluteUri + [char]7) }; & $global:MultitaskerOriginalPrompt }`;
