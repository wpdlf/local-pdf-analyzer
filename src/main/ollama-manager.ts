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
    return new Promise((resolve) => {
      http.get(this.baseUrl, (res) => {
        resolve(res.statusCode === 200);
      }).on('error', () => {
        resolve(false);
      });
    });
  }

  async listModels(): Promise<string[]> {
    return new Promise((resolve) => {
      http.get(`${this.baseUrl}/api/tags`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const models = (parsed.models || []).map((m: { name: string }) => m.name);
            resolve(models);
          } catch {
            resolve([]);
          }
        });
      }).on('error', () => {
        resolve([]);
      });
    });
  }

  async pullModel(model: string): Promise<{ success: boolean; error?: string }> {
    const ollamaPath = this.getOllamaPath();
    return new Promise((resolve) => {
      const proc = spawn(ollamaPath, ['pull', model]);
      let lastProgress = '';

      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

      proc.stdout?.on('data', (data: Buffer) => {
        const line = stripAnsi(data.toString().trim());
        if (line && line !== lastProgress) {
          lastProgress = line;
          this.sendProgress(`모델 다운로드: ${line}`);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const line = stripAnsi(data.toString().trim());
        if (line && line !== lastProgress) {
          lastProgress = line;
          this.sendProgress(`모델 다운로드: ${line}`);
        }
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: `모델 다운로드 실패: ${err.message}` });
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: `모델 다운로드 실패 (exit code: ${code})` });
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
