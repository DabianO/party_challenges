import type { GameSnapshot, HostAction, ModuleInfo } from '@challenge/contract';
import type { HostActionResponse } from '../../lib/api';
import type { ToastTone } from '../../components/Toast';

/** Everything the host tabs need; built once in HostGame. */
export interface HostCtx {
  gameId: string;
  token: string;
  snapshot: GameSnapshot;
  modules: ModuleInfo[];
  clockOffset: number;
  /** Posts a host action; errors are toasted and yield null. */
  act(action: HostAction): Promise<HostActionResponse | null>;
  /** Uploads a media file and resolves to its `media://` ref. */
  upload(file: File): Promise<string>;
  toast(message: string, tone?: ToastTone): void;
}

export function moduleFor(modules: ModuleInfo[], moduleId: string): ModuleInfo | undefined {
  return modules.find((m) => m.manifest.id === moduleId);
}
