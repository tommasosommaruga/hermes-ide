import type {
  CreateTerminalRequest, CreateTerminalResponse,
  TerminalOutputRequest, TerminalOutputResponse,
  WaitForTerminalExitRequest, WaitForTerminalExitResponse,
  KillTerminalRequest, KillTerminalResponse,
  ReleaseTerminalRequest, ReleaseTerminalResponse,
} from '@agentclientprotocol/sdk';
import { log } from '../utils/Logger';

export class TerminalHandler {
  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    log(`createTerminal rejected (disabled): ${params.command}`);
    throw new Error('Client terminal/* is disabled. Hermes should use its own terminal tools.');
  }
  async terminalOutput(_p: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    throw new Error('Client terminal/* is disabled.');
  }
  async waitForTerminalExit(_p: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    throw new Error('Client terminal/* is disabled.');
  }
  async killTerminal(_p: KillTerminalRequest): Promise<KillTerminalResponse> {
    throw new Error('Client terminal/* is disabled.');
  }
  async releaseTerminal(_p: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    throw new Error('Client terminal/* is disabled.');
  }
  dispose(): void {}
}
