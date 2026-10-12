import { log } from '../utils/Logger';

interface RegistryAgent {
  name: string;
  description?: string;
  command: string;
  args?: string[];
  homepage?: string;
}

/** Offline: CDN agent registry disabled. */
export async function fetchRegistry(): Promise<RegistryAgent[]> {
  log('Agent registry fetch skipped (offline Hermes-only build).');
  return [];
}

export function clearRegistryCache(): void {}
