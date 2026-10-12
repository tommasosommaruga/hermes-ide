import type {
  ReadTextFileRequest, ReadTextFileResponse,
  WriteTextFileRequest, WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { log } from '../utils/Logger';

export class FileSystemHandler {
  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    log(`readTextFile rejected (disabled): ${params.path}`);
    throw new Error('Client fs/read_text_file is disabled. Hermes should use its own file tools.');
  }
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    log(`writeTextFile rejected (disabled): ${params.path}`);
    throw new Error('Client fs/write_text_file is disabled. Hermes should use its own file tools.');
  }
}
