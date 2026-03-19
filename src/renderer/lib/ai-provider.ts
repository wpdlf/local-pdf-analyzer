// AI Provider는 Main 프로세스(src/main/ai-service.ts)로 이전됨.
// Renderer에서는 IPC를 통해 ai-client.ts가 Main 프로세스에 요약을 요청합니다.
// 이 파일은 하위 호환성을 위해 유지되며, 새로운 코드에서는 사용하지 않습니다.

export interface GenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AiProvider {
  generate(prompt: string, options?: GenerateOptions): AsyncGenerator<string>;
  listModels(): Promise<string[]>;
  isAvailable(): Promise<boolean>;
}
