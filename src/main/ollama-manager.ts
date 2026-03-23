import { execFile, spawn, ChildProcess, ExecFileException } from 'child_process';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';

interface OllamaStatusResult {
  installed: boolean;
  running: boolean;
  version?: string;
  models: string[];
}

export class OllamaManager {
  private process: ChildProcess | null = null;
  private baseUrl = 'http://localhost:11434';

  // Ollama 실행 파일 경로 (설치 직후 PATH 반영 안 될 수 있으므로 직접 지정)
  private getOllamaPath(): string {
    if (process.platform === 'win32') {
      const localAppData = process.env['LOCALAPPDATA'] || '';
      const programsPath = path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe');
      if (fs.existsSync(programsPath)) return programsPath;

      const userProfile = process.env['USERPROFILE'] || '';
      const appDataPath = path.join(userProfile, 'AppData', 'Local', 'Ollama', 'ollama.exe');
      if (fs.existsSync(appDataPath)) return appDataPath;
    }
    return 'ollama'; // PATH에서 찾기
  }

  async getStatus(): Promise<OllamaStatusResult> {
    const installed = await this.isInstalled();
    const running = installed ? await this.healthCheck() : false;
    const models = running ? await this.listModels() : [];
    let version: string | undefined;

    if (installed) {
      version = await this.getVersion();
    }

    return { installed, running, version, models };
  }

  async isInstalled(): Promise<boolean> {
    const ollamaPath = this.getOllamaPath();
    return new Promise((resolve) => {
      execFile(ollamaPath, ['--version'], (error) => {
        resolve(!error);
      });
    });
  }

  private async getVersion(): Promise<string | undefined> {
    const ollamaPath = this.getOllamaPath();
    return new Promise((resolve) => {
      execFile(ollamaPath, ['--version'], (error, stdout) => {
        if (error) {
          resolve(undefined);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  async install(): Promise<{ success: boolean; error?: string }> {
    const platform = process.platform;

    if (platform === 'win32') {
      return this.installWindows();
    } else if (platform === 'darwin') {
      return this.installMac();
    }

    return { success: false, error: '지원하지 않는 운영체제입니다.' };
  }

  private async installWindows(): Promise<{ success: boolean; error?: string }> {
    const installerUrl = 'https://ollama.com/download/OllamaSetup.exe';
    const installerPath = path.join(app.getPath('temp'), 'OllamaSetup.exe');

    try {
      // 1. 인스톨러 다운로드
      this.sendProgress('Ollama 인스톨러 다운로드 중...');
      await this.downloadFile(installerUrl, installerPath);

      // 2. 설치 실행 (사용자가 설치 UI에서 완료할 때까지 대기)
      this.sendProgress('Ollama 설치 창이 열립니다. 설치를 완료해주세요...');
      await new Promise<void>((resolve, reject) => {
        // Start-Process의 -FilePath를 변수로 분리하여 인젝션 방지
        execFile(
          'powershell',
          ['-Command', 'Start-Process', '-FilePath', installerPath, '-Verb', 'RunAs', '-Wait'],
          { timeout: 300000 },
          (error) => {
            if (error && !error.message.includes('exited')) reject(error);
            else resolve();
          },
        );
      });

      // 3. 설치 후 대기 (프로세스 정리 및 PATH 반영)
      this.sendProgress('설치 완료 확인 중...');
      await new Promise((r) => setTimeout(r, 3000));

      // 4. 설치 확인
      const installed = await this.isInstalled();
      if (!installed) {
        return { success: false, error: 'Ollama 설치가 완료되었지만 실행 파일을 찾을 수 없습니다. PC를 재시작하거나 https://ollama.com 에서 수동 설치해주세요.' };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `설치 실패: ${error instanceof Error ? error.message : String(error)}. https://ollama.com 에서 수동 설치해주세요.`,
      };
    } finally {
      try { fs.unlinkSync(installerPath); } catch { /* 임시 파일 정리 실패 무시 */ }
    }
  }

  private async installMac(): Promise<{ success: boolean; error?: string }> {
    try {
      this.sendProgress('Ollama 설치 중 (Homebrew)...');
      await new Promise<void>((resolve, reject) => {
        execFile('brew', ['install', 'ollama'], { timeout: 300000 }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { success: true };
    } catch {
      // brew 실패 시 직접 다운로드 시도
      try {
        this.sendProgress('Homebrew 실패. 직접 다운로드 시도 중...');
        const dmgUrl = 'https://ollama.com/download/Ollama-darwin.zip';
        const dmgPath = path.join(app.getPath('temp'), 'Ollama-darwin.zip');
        await this.downloadFile(dmgUrl, dmgPath);
        await new Promise<void>((resolve, reject) => {
          execFile('unzip', ['-o', dmgPath, '-d', '/Applications'], (error: ExecFileException | null) => {
            if (error) reject(error);
            else resolve();
          });
        });
        await new Promise<void>((resolve) => {
          execFile('open', ['/Applications/Ollama.app'], () => resolve());
        });
        await new Promise((r) => setTimeout(r, 3000));
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: `설치 실패: ${error instanceof Error ? error.message : String(error)}. https://ollama.com 에서 수동 설치해주세요.`,
        };
      } finally {
        try { fs.unlinkSync(path.join(app.getPath('temp'), 'Ollama-darwin.zip')); } catch { /* 무시 */ }
      }
    }
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    const MAX_SIZE = 500 * 1024 * 1024; // 500MB
    const TIMEOUT_MS = 600000; // 10분

    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = () => { if (!settled) { settled = true; resolve(); } };
      const safeReject = (err: Error) => { if (!settled) { settled = true; reject(err); } };

      const follow = (targetUrl: string, redirects = 0) => {
        if (redirects > 5) {
          safeReject(new Error('너무 많은 리다이렉트'));
          return;
        }
        const client = targetUrl.startsWith('https') ? https : http;
        const req = client.get(targetUrl, (response) => {
          if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode)) {
            const location = response.headers.location;
            if (!location) {
              safeReject(new Error(`리다이렉트 응답에 Location 헤더가 없습니다 (HTTP ${response.statusCode})`));
              return;
            }
            if (!location.startsWith('https://') && !location.startsWith('http://')) {
              safeReject(new Error(`안전하지 않은 리다이렉트 URL: ${location.slice(0, 50)}`));
              return;
            }
            follow(location, redirects + 1);
          } else if (response.statusCode === 200) {
            const contentLength = parseInt(response.headers['content-length'] || '0', 10);
            if (contentLength > MAX_SIZE) {
              safeReject(new Error(`파일이 너무 큽니다 (${Math.round(contentLength / 1024 / 1024)}MB). 최대 500MB`));
              response.destroy();
              return;
            }

            let downloaded = 0;
            const file = fs.createWriteStream(dest);
            response.on('data', (chunk: Buffer) => {
              downloaded += chunk.length;
              if (downloaded > MAX_SIZE) {
                response.destroy();
                file.destroy();
                safeReject(new Error('다운로드 크기가 500MB를 초과했습니다.'));
              }
            });
            response.pipe(file);
            file.on('finish', () => { file.close(); safeResolve(); });
            file.on('error', safeReject);
          } else {
            safeReject(new Error(`다운로드 실패: HTTP ${response.statusCode}`));
          }
        });
        req.on('error', safeReject);
        req.setTimeout(TIMEOUT_MS, () => {
          req.destroy();
          safeReject(new Error('다운로드 타임아웃 (10분)'));
        });
      };
      follow(url);
    });
  }

  async start(): Promise<void> {
    if (await this.healthCheck()) return;

    const installed = await this.isInstalled();
    if (!installed) return;

    const ollamaPath = this.getOllamaPath();

    return new Promise((resolve) => {
      this.process = spawn(ollamaPath, ['serve'], {
        detached: true,
        stdio: 'ignore',
      });

      this.process.on('error', () => {
        this.process = null;
        resolve();
      });

      this.process.unref();

      const check = async (retries: number) => {
        if (retries <= 0) {
          resolve();
          return;
        }
        const ok = await this.healthCheck();
        if (ok) {
          resolve();
        } else {
          setTimeout(() => check(retries - 1), 1000);
        }
      };
      check(15);
    });
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  async healthCheck(): Promise<boolean> {
    const url = new URL(this.baseUrl);
    return new Promise((resolve) => {
      const req = http.get({ hostname: url.hostname, port: url.port || 11434, path: '/', timeout: 5000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  async listModels(): Promise<string[]> {
    const url = new URL(this.baseUrl);
    return new Promise((resolve) => {
      const MAX_RESPONSE = 1024 * 1024; // 1MB
      const req = http.get({ hostname: url.hostname, port: url.port || 11434, path: '/api/tags', timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > MAX_RESPONSE) { res.destroy(); resolve([]); return; }
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const models = (parsed.models || []).map((m: { name: string }) => m.name);
            resolve(models);
          } catch {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    });
  }

  async pullModel(model: string): Promise<{ success: boolean; error?: string }> {
    const ollamaPath = this.getOllamaPath();
    const PULL_TIMEOUT_MS = 1800000; // 30분

    return new Promise((resolve) => {
      let settled = false;
      const safeResolve = (result: { success: boolean; error?: string }) => {
        if (!settled) { settled = true; resolve(result); }
      };

      const proc = spawn(ollamaPath, ['pull', model]);
      let lastProgress = '';

      const timeout = setTimeout(() => {
        proc.kill();
        safeResolve({ success: false, error: '모델 다운로드 타임아웃 (30분). 네트워크를 확인 후 다시 시도해주세요.' });
      }, PULL_TIMEOUT_MS);

      // ANSI 이스케이프 시퀀스 전체 제거 (색상, 커서 이동 등)
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

      // ollama pull은 \r과 \n을 혼용하므로, 둘 다 기준으로 split 후 마지막 비어있지 않은 줄만 취함
      const extractLastLine = (raw: string): string => {
        const cleaned = stripAnsi(raw);
        const parts = cleaned.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : '';
      };

      // ollama pull 원본 출력을 사용자 친화적 메시지로 변환
      const toFriendlyMessage = (line: string): string => {
        // "pulling abc123..." → 퍼센트 추출
        const pullMatch = line.match(/^pulling\s+\S+.*?(\d+%)/);
        if (pullMatch) return `모델 다운로드 중... ${pullMatch[1]}`;
        // "pulling manifest"
        if (/^pulling\s+manifest/i.test(line)) return '모델 정보 확인 중...';
        // "verifying sha256 digest"
        if (/^verifying/i.test(line)) return '무결성 검증 중...';
        // "writing manifest"
        if (/^writing/i.test(line)) return '설치 마무리 중...';
        // "success"
        if (/^success/i.test(line)) return '다운로드 완료!';
        // 그 외 (예: pulling hash without %)
        if (/^pulling\s+[a-f0-9]/i.test(line)) return '모델 다운로드 준비 중...';
        return line;
      };

      proc.stdout?.on('data', (data: Buffer) => {
        const line = extractLastLine(data.toString());
        if (line && line !== lastProgress) {
          lastProgress = line;
          this.sendProgress(toFriendlyMessage(line));
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const line = extractLastLine(data.toString());
        if (line && line !== lastProgress) {
          lastProgress = line;
          this.sendProgress(toFriendlyMessage(line));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        safeResolve({ success: false, error: `모델 다운로드 실패: ${err.message}` });
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          safeResolve({ success: true });
        } else {
          safeResolve({ success: false, error: `모델 다운로드 실패 (exit code: ${code})` });
        }
      });
    });
  }

  /** renderer에 진행 상태 전송 */
  private sendProgress(message: string): void {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send('setup:progress', message);
    }
  }
}
