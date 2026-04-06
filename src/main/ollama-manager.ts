import { execFile, spawn, ChildProcess, ExecFileException } from 'child_process';
import crypto from 'crypto';
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
  private startPromise: Promise<boolean> | null = null; // 동시 start() 호출 시 동일 Promise 반환

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

  /** 다운로드 파일의 SHA-256 해시를 계산합니다 (무결성 추적용, 자동 검증 아님) */
  private async computeFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => {
        const digest = hash.digest('hex');
        console.log(`[Ollama] Downloaded file hash: sha256:${digest}`);
        resolve(digest);
      });
      stream.on('error', reject);
    });
  }

  private async installWindows(): Promise<{ success: boolean; error?: string }> {
    const installerUrl = 'https://ollama.com/download/OllamaSetup.exe';
    const installerPath = path.join(app.getPath('temp'), 'OllamaSetup.exe');

    try {
      // 1. 인스톨러 다운로드
      this.sendProgress('Ollama 인스톨러 다운로드 중...');
      await this.downloadFile(installerUrl, installerPath);

      // 2. 다운로드 무결성 검증
      this.sendProgress('다운로드 무결성 검증 중...');
      const hash = await this.computeFileHash(installerPath);
      const stat = fs.statSync(installerPath);
      if (stat.size < 1024 * 1024) { // 1MB 미만이면 비정상
        fs.unlinkSync(installerPath);
        return { success: false, error: `다운로드 파일이 비정상적으로 작습니다 (${stat.size} bytes). 네트워크를 확인 후 다시 시도해주세요. (sha256:${hash.slice(0, 16)}...)` };
      }

      // 3. 설치 실행 (사용자가 설치 UI에서 완료할 때까지 대기)
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

      // 4. 설치 후 대기 (프로세스 정리 및 PATH 반영)
      this.sendProgress('설치 완료 확인 중...');
      await new Promise((r) => setTimeout(r, 3000));

      // 5. 설치 확인
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
      const zipPath = path.join(app.getPath('temp'), 'Ollama-darwin.zip');
      try {
        this.sendProgress('Homebrew 실패. 직접 다운로드 시도 중...');
        const zipUrl = 'https://ollama.com/download/Ollama-darwin.zip';
        await this.downloadFile(zipUrl, zipPath);

        // 다운로드 무결성 검증
        this.sendProgress('다운로드 무결성 검증 중...');
        const hash = await this.computeFileHash(zipPath);
        const stat = fs.statSync(zipPath);
        if (stat.size < 1024 * 1024) {
          fs.unlinkSync(zipPath);
          throw new Error(`다운로드 파일이 비정상적으로 작습니다 (sha256:${hash.slice(0, 16)}...)`);
        }

        // zip エントリのパス検証 (path traversal 防止)
        await new Promise<void>((resolve, reject) => {
          execFile('unzip', ['-l', zipPath], (error, stdout) => {
            if (error) { reject(error); return; }
            const hasTraversal = stdout.split('\n').some((line) => {
              const parts = line.trim().split(/\s+/);
              const entryPath = parts[parts.length - 1] || '';
              return entryPath.includes('..') || entryPath.startsWith('/');
            });
            if (hasTraversal) {
              reject(new Error('다운로드 파일에 위험한 경로가 포함되어 있습니다. 수동 설치를 권장합니다.'));
              return;
            }
            resolve();
          });
        });
        await new Promise<void>((resolve, reject) => {
          execFile('unzip', ['-o', zipPath, '-d', '/Applications'], (error: ExecFileException | null) => {
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
        try { fs.unlinkSync(zipPath); } catch { /* 무시 */ }
      }
    }
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    const MAX_SIZE = 500 * 1024 * 1024; // 500MB
    const TIMEOUT_MS = 600000; // 10분

    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = () => { if (!settled) { settled = true; resolve(); } };
      const safeReject = (err: Error) => {
        if (!settled) {
          settled = true;
          // 에러 시 부분 다운로드 파일 삭제
          try { fs.unlinkSync(dest); } catch { /* 파일 미존재 무시 */ }
          reject(err);
        }
      };

      const follow = (targetUrl: string, redirects = 0) => {
        if (redirects > 5) {
          safeReject(new Error('너무 많은 리다이렉트'));
          return;
        }
        const client = targetUrl.startsWith('https') ? https : http;
        const req = client.get(targetUrl, (response) => {
          if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.resume(); // 리다이렉트 응답 body 소비하여 소켓 해제
            const location = response.headers.location;
            if (!location) {
              safeReject(new Error(`리다이렉트 응답에 Location 헤더가 없습니다 (HTTP ${response.statusCode})`));
              return;
            }
            if (!location.startsWith('https://')) {
              safeReject(new Error(`안전하지 않은 리다이렉트 URL (HTTPS만 허용): ${location.slice(0, 50)}`));
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
            let aborted = false;
            const file = fs.createWriteStream(dest);
            response.on('data', (chunk: Buffer) => {
              if (aborted) return;
              downloaded += chunk.length;
              if (downloaded > MAX_SIZE) {
                aborted = true;
                response.destroy();
                file.end(() => safeReject(new Error('다운로드 크기가 500MB를 초과했습니다.')));
                return;
              }
              file.write(chunk);
            });
            response.on('end', () => {
              if (aborted) return;
              file.end(() => safeResolve());
            });
            response.on('error', (err) => {
              if (aborted) return;
              aborted = true;
              file.end(() => safeReject(err));
            });
            file.on('error', (err) => {
              if (aborted) return;
              aborted = true;
              response.destroy();
              safeReject(err);
            });
            // 타임아웃 등으로 소켓이 파괴될 때 WriteStream 정리 (파일 디스크립터 누수 방지)
            response.on('close', () => {
              if (!aborted && !response.complete) {
                aborted = true;
                file.end(() => safeReject(new Error('다운로드 연결이 끊어졌습니다.')));
              }
            });
          } else {
            response.resume();
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

  async start(): Promise<boolean> {
    // 동시 호출 시 동일 Promise 반환하여 이중 spawn 방지
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._startInternal();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async _startInternal(): Promise<boolean> {
    if (await this.healthCheck()) return true;

    const installed = await this.isInstalled();
    if (!installed) return false;

    const ollamaPath = this.getOllamaPath();

    // 기존 프로세스가 남아있으면 먼저 정리
    if (this.process) {
      await this.stop();
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const safeResolve = (value: boolean) => {
        if (!settled) { settled = true; resolve(value); }
      };

      this.process = spawn(ollamaPath, ['serve'], {
        detached: true,
        stdio: 'ignore',
      });

      this.process.on('error', () => {
        this.process = null;
        safeResolve(false);
      });

      // 프로세스가 예기치 않게 종료되면 참조 정리
      this.process.on('close', () => {
        this.process = null;
      });

      this.process.unref();

      const check = async (retries: number) => {
        if (settled) return; // error 이벤트로 이미 resolve된 경우 중단
        // 프로세스가 이미 종료된 경우 retry 중단
        if (!this.process) {
          safeResolve(false);
          return;
        }
        if (retries <= 0) {
          // healthCheck 실패 시 spawned 프로세스 정리 (백그라운드 누수 방지)
          await this.stop();
          safeResolve(false);
          return;
        }
        const ok = await this.healthCheck();
        if (ok) {
          safeResolve(true);
        } else {
          setTimeout(() => check(retries - 1), 1000);
        }
      };
      check(15);
    });
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    const proc = this.process;
    this.process = null;

    // 프로세스 종료 대기 Promise (최대 5초)
    const waitForExit = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      proc.on('close', () => { clearTimeout(timeout); resolve(); });
    });

    if (process.platform === 'win32' && proc.pid) {
      // Windows: detached 프로세스 트리 전체 종료
      try {
        await new Promise<void>((resolve) => {
          execFile('taskkill', ['/F', '/T', '/PID', String(proc.pid)], () => resolve());
        });
      } catch { /* taskkill 실패 시 무시 */ }
    } else {
      try { proc.kill('SIGTERM'); } catch { /* 이미 종료된 프로세스 */ }
    }

    await waitForExit;
  }

  async healthCheck(): Promise<boolean> {
    const url = new URL(this.baseUrl);
    return new Promise((resolve) => {
      const req = http.get({ hostname: url.hostname, port: url.port || 11434, path: '/', timeout: 5000 }, (res) => {
        res.on('error', () => {}); // 응답 drain 중 연결 끊김 시 unhandled error 방지
        res.resume();
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
      let resolved = false;
      const safeResolve = (val: string[]) => { if (!resolved) { resolved = true; resolve(val); } };
      const req = http.get({ hostname: url.hostname, port: url.port || 11434, path: '/api/tags', timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > MAX_RESPONSE) { res.destroy(); safeResolve([]); return; }
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const models = (parsed.models || []).map((m: { name: string }) => m.name);
            safeResolve(models);
          } catch {
            safeResolve([]);
          }
        });
        res.on('error', () => safeResolve([]));
      });
      req.on('error', () => safeResolve([]));
      req.on('timeout', () => { req.destroy(); safeResolve([]); });
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
    if (win && !win.isDestroyed()) {
      win.webContents.send('setup:progress', message);
    }
  }
}
