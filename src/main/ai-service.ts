import http from 'http';
import https from 'https';
import { StringDecoder } from 'string_decoder';
import { BrowserWindow } from 'electron';

interface GenerateRequest {
  text: string;
  type: 'full' | 'chapter' | 'keywords';
  provider: 'ollama' | 'claude' | 'openai';
  model: string;
  ollamaBaseUrl: string;
  temperature?: number;
}

const activeRequests = new Map<string, { abort: () => void }>();

function validateOllamaUrl(url: string): void {
  try {
    const parsed = new URL(url);
    const allowedHosts = ['localhost', '127.0.0.1', '::1'];
    if (!allowedHosts.includes(parsed.hostname)) {
      throw new Error(`허용되지 않는 Ollama 호스트: ${parsed.hostname}. localhost만 허용됩니다.`);
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('올바르지 않은 Ollama URL 형식입니다.');
    }
    throw err;
  }
}

export function abortGenerate(requestId: string): void {
  const req = activeRequests.get(requestId);
  if (req) {
    req.abort();
    activeRequests.delete(requestId);
  }
}

export async function generate(
  requestId: string,
  request: GenerateRequest,
  apiKey: string | undefined,
  win: BrowserWindow,
): Promise<void> {
  const prompt = buildPrompt(request.text, request.type);

  switch (request.provider) {
    case 'ollama':
      return generateOllama(requestId, prompt, request, win);
    case 'claude':
      if (!apiKey) throw Object.assign(new Error('Claude API 키가 설정되지 않았습니다.'), { code: 'API_KEY_MISSING' });
      return generateClaude(requestId, prompt, request, apiKey, win);
    case 'openai':
      if (!apiKey) throw Object.assign(new Error('OpenAI API 키가 설정되지 않았습니다.'), { code: 'API_KEY_MISSING' });
      return generateOpenAi(requestId, prompt, request, apiKey, win);
  }
}

export async function checkAvailability(
  provider: 'ollama' | 'claude' | 'openai',
  ollamaBaseUrl: string,
  apiKey: string | undefined,
): Promise<boolean> {
  switch (provider) {
    case 'ollama':
      try {
        validateOllamaUrl(ollamaBaseUrl);
      } catch {
        return false;
      }
      const parsed = new URL(ollamaBaseUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      return new Promise((resolve) => {
        const req = client.get({ hostname: parsed.hostname, port: parsed.port, path: '/', timeout: 5000 }, (res) => resolve(res.statusCode === 200));
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
    case 'claude':
      return !!apiKey;
    case 'openai':
      return !!apiKey;
  }
}

// ─── Ollama ───

async function generateOllama(
  requestId: string,
  prompt: string,
  request: GenerateRequest,
  win: BrowserWindow,
): Promise<void> {
  validateOllamaUrl(request.ollamaBaseUrl);
  const url = new URL('/api/generate', request.ollamaBaseUrl);
  const { system, user } = splitPrompt(prompt);
  const body = JSON.stringify({
    model: request.model || 'llama3.2',
    system,
    prompt: user,
    stream: true,
    options: { temperature: request.temperature ?? 0.3 },
  });

  return streamRequest(requestId, {
    url: url.toString(),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    extractToken: (parsed) => parsed.response || null,
  }, win);
}

// ─── Claude ───

async function generateClaude(
  requestId: string,
  prompt: string,
  request: GenerateRequest,
  apiKey: string,
  win: BrowserWindow,
): Promise<void> {
  const { system, user } = splitPrompt(prompt);
  const body = JSON.stringify({
    model: request.model || 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    stream: true,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: user }],
    temperature: request.temperature ?? 0.3,
  });

  return streamRequest(requestId, {
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body,
    isSSE: true,
    extractToken: (parsed) => {
      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
        return parsed.delta.text;
      }
      return null;
    },
    checkAuthError: (statusCode) => statusCode === 401,
  }, win);
}

// ─── OpenAI ───

async function generateOpenAi(
  requestId: string,
  prompt: string,
  request: GenerateRequest,
  apiKey: string,
  win: BrowserWindow,
): Promise<void> {
  const { system, user } = splitPrompt(prompt);
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const body = JSON.stringify({
    model: request.model || 'gpt-4o-mini',
    stream: true,
    messages,
    temperature: request.temperature ?? 0.3,
  });

  return streamRequest(requestId, {
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body,
    isSSE: true,
    extractToken: (parsed) => parsed.choices?.[0]?.delta?.content || null,
    checkAuthError: (statusCode) => statusCode === 401,
  }, win);
}

// ─── 공통 스트리밍 요청 ───

interface StreamConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  isSSE?: boolean;
  extractToken: (parsed: Record<string, unknown>) => string | null;
  checkAuthError?: (statusCode: number) => boolean;
}

function streamRequest(
  requestId: string,
  config: StreamConfig,
  win: BrowserWindow,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeResolve = () => { if (!settled) { settled = true; resolve(); } };
    const safeReject = (err: Error) => { if (!settled) { settled = true; reject(err); } };

    const parsedUrl = new URL(config.url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    let responseStream: import('http').IncomingMessage | null = null;

    const req = client.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: config.method,
        headers: {
          ...config.headers,
          'Content-Length': Buffer.byteLength(config.body),
        },
      },
      (res) => {
        responseStream = res;
        if (config.checkAuthError?.(res.statusCode || 0)) {
          activeRequests.delete(requestId);
          safeReject(Object.assign(new Error('API 키가 유효하지 않습니다.'), { code: 'API_KEY_INVALID' }));
          res.destroy();
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          activeRequests.delete(requestId);
          safeReject(new Error(`API 요청 실패: HTTP ${res.statusCode}`));
          res.destroy();
          return;
        }

        const MAX_RESPONSE_SIZE = 50 * 1024 * 1024; // 50MB
        let totalBytes = 0;

        let buffer = '';
        const decoder = new StringDecoder('utf8');

        res.on('data', (chunk: Buffer) => {
          if (win.isDestroyed()) {
            res.destroy();
            return;
          }

          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_SIZE) {
            activeRequests.delete(requestId);
            res.destroy();
            safeReject(new Error('AI 응답이 너무 큽니다 (50MB 초과).'));
            return;
          }

          buffer += decoder.write(chunk);
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;

            let jsonStr = line;
            if (config.isSSE) {
              if (!line.startsWith('data: ')) continue;
              jsonStr = line.slice(6);
              if (jsonStr === '[DONE]') continue;
            }

            try {
              const parsed = JSON.parse(jsonStr);
              const token = config.extractToken(parsed);
              if (token) {
                win.webContents.send('ai:token', requestId, token);
              }
            } catch {
              // JSON 파싱 실패 무시
            }
          }
        });

        res.on('end', () => {
          // 버퍼에 남은 마지막 데이터 처리
          if (buffer.trim() && !win.isDestroyed()) {
            let jsonStr = buffer;
            if (config.isSSE && jsonStr.startsWith('data: ')) {
              jsonStr = jsonStr.slice(6);
            }
            if (jsonStr && jsonStr !== '[DONE]') {
              try {
                const parsed = JSON.parse(jsonStr);
                const token = config.extractToken(parsed);
                if (token) {
                  win.webContents.send('ai:token', requestId, token);
                }
              } catch { /* 파싱 실패 무시 */ }
            }
          }
          activeRequests.delete(requestId);
          if (!win.isDestroyed()) {
            win.webContents.send('ai:done', requestId);
          }
          safeResolve();
        });

        res.on('error', (err) => {
          activeRequests.delete(requestId);
          safeReject(err);
        });
      },
    );

    req.on('error', (err) => {
      activeRequests.delete(requestId);
      safeReject(err);
    });

    req.setTimeout(300000, () => {
      activeRequests.delete(requestId);
      req.destroy();
      safeReject(new Error('AI 서버 응답 타임아웃 (5분)'));
    });

    // abort를 write 전에 등록하여 race condition 방지
    // response 스트림도 함께 파괴하여 generator 무한 대기 방지
    activeRequests.set(requestId, {
      abort: () => {
        activeRequests.delete(requestId);
        if (responseStream && !responseStream.destroyed) responseStream.destroy();
        if (!req.destroyed) req.destroy();
      },
    });

    req.write(config.body);
    req.end();
  });
}

// ─── 프롬프트 분리 (시스템 지시 / 사용자 입력) ───

function splitPrompt(prompt: string): { system: string; user: string } {
  const separator = '---\n\n';
  const idx = prompt.lastIndexOf(separator);
  if (idx === -1) return { system: '', user: prompt };
  return {
    system: prompt.slice(0, idx).trim(),
    user: prompt.slice(idx + separator.length).trim(),
  };
}

// ─── 프롬프트 빌더 (Main 프로세스용) ───

function buildPrompt(text: string, type: 'full' | 'chapter' | 'keywords'): string {
  switch (type) {
    case 'full':
      return `당신은 대학교 강의자료 요약 전문가입니다.
반드시 한국어로 답변하세요. 원문이 영어라도 한국어로 요약합니다.

다음 강의자료를 분석하여 구조적으로 요약해주세요.

## 요약 규칙
1. **핵심 개념**: 주요 개념과 정의를 목록으로 정리 (전문 용어는 원어 병기)
2. **주요 내용**: 각 섹션의 핵심 내용을 간결하게 요약
3. **수식/공식**: 중요한 수식이 있으면 원문 그대로 포함
4. **예제**: 핵심 예제가 있으면 간략히 포함
5. **시험 포인트**: 시험에 출제될 가능성이 높은 내용 별도 표시

## 출력 형식
마크다운 형식으로 출력하세요.

---

${text}`;
    case 'chapter':
      return `당신은 대학교 강의자료 요약 전문가입니다.
반드시 한국어로 답변하세요. 원문이 영어라도 한국어로 요약합니다.

다음 강의자료의 이 섹션을 요약해주세요.

## 요약 규칙
1. 해당 섹션의 **핵심 개념**과 **정의**를 정리 (전문 용어는 원어 병기)
2. 중요한 **수식/공식**은 원문 그대로 포함
3. **예제**가 있으면 핵심만 간략히 포함
4. 3~5개의 **핵심 포인트**로 정리

## 출력 형식
마크다운 형식으로 출력하세요.

---

${text}`;
    case 'keywords':
      return `다음 강의자료에서 핵심 키워드를 추출하고 각각 간단히 설명해주세요.
반드시 한국어로 답변하세요. 전문 용어는 원어를 병기합니다.

## 출력 형식
아래 마크다운 테이블 형식으로 출력하세요:

| 키워드 | 설명 | 중요도 |
|--------|------|--------|
| 키워드명 | 한 줄 설명 | 상/중/하 |

키워드는 최소 10개, 최대 30개 추출해주세요.

---

${text}`;
  }
}
