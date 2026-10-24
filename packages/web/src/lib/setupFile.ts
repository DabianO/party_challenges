import { api } from './api';

/** Download a game's setup (board, settings, branding and media) as a JSON file. */
export async function downloadSetup(gameId: string, token: string, gameName: string): Promise<void> {
  const setup = await api.exportSetup(gameId, token);
  const blob = new Blob([JSON.stringify(setup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const safe = gameName.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'game';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}-setup-${date}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Parse a setup file chosen by the host; the server validates its contents. */
export async function readSetupFile(file: File): Promise<unknown> {
  try {
    return JSON.parse(await file.text()) as unknown;
  } catch {
    throw new Error('That file is not valid JSON — choose a setup file exported from this app');
  }
}
