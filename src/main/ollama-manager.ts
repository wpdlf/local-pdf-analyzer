import { execFile, spawn, ChildProcess, ExecFileException } from 'child_process';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';
// v0.18.19 patch R32 P2: PowerShell single-quote escape 헬퍼를 별도 모듈로 분리.
// `ollama-manager.ts` 가 electron 을 import 하므로 vitest 에서 직접 import 불가했고,
// 그래서 escape 로직에 회귀 테스트가 0건이었다 (R15 H1 / R28 P2 발생 영역). 분리하여
// `__tests__/ollama-psquote.test.ts` 가 검증.
import { psQuotePath } from './ps-quote';
// R37 P6 (v0.18.23): pull 진행 출력 파싱 로직 분리 (QA M5) — 위 ps-quote 와 동일 사유.
// `__tests__/ollama-pull-progress.test.ts` 가 ANSI/개행/퍼센트/상태 매핑 회귀를 가드.
import { extractLastLine, toFriendlyMessage } from './ollama-pull-progress';

interface OllamaStatusResult {
  installed: boolean;
  running: boolean;
  version?: string;
  models: string[];
}

export class OllamaManager {
  private process: ChildProcess | null = null;
  private pullProcess: ChildProcess | null = null; // 진행 중인 `ollama pull` 자식 프로세스 — stop() 에서 종료 필요
  private baseUrl = 'http://localhost:11434';
  private startPromise: Promise<boolean> | null = null; // 동시 start() 호출 시 동일 Promise 반환
  private installPromise: Promise<{ success: boolean; error?: string }> | null = null; // 동시 install() 호출 시 동일 Promise 반환

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
    // 동시 호출 시 동일 Promise 반환하여 이중 다운로드/인스톨러 spawn 방지
    if (this.installPromise) return this.installPromise;
    this.installPromise = this._installInternal();
    try {
      return await this.installPromise;
    } finally {
      this.installPromise = null;
    }
  }

  private async _installInternal(): Promise<{ success: boolean; error?: string }> {
    const platform = process.platform;

    if (platform === 'win32') {
      return this.installWindows();
    } else if (platform === 'darwin') {
      return this.installMac();
    }

    return { success: false, error: '지원하지 않는 운영체제입니다.' };
  }

  /** 다운로드 파일의 SHA-256 해시를 계산합니다 (로깅 + 에러 진단용) */
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

  /**
   * Windows Authenticode 서명 검증 (v0.17.7, 보안 M1).
   * 다운로드한 인스톨러가 Ollama 발행자의 유효한 서명을 갖는지 확인.
   * SHA-256 pinning 대비 장점: Ollama 버전 bump 시 bkit 릴리즈 없이도 지속 동작.
   * 실패 시 invalid → 인스톨러 실행 거부.
   */
  private async verifyInstallerSignature(filePath: string): Promise<{ valid: boolean; subject?: string; reason?: string }> {
    return new Promise((resolve) => {
      // PowerShell single-quote escape (installWindows 와 동일 규칙) — 공통 헬퍼 사용.
      const psQuotedPath = psQuotePath(filePath);
      // R28 P2 (v0.18.12): -FilePath → -LiteralPath
      //   `-FilePath` 는 wildcard ([], *, ?) 를 해석해 사용자명/임시경로에 그런 문자가
      //   포함된 경우 (예: "C:\Users\foo[bar]\...\OllamaSetup.exe") 검증이 잘못된 경로를
      //   대상으로 하거나 실패해 설치가 DoS 된다. `-LiteralPath` 는 글로빙을 끄고
      //   문자열을 그대로 파일 경로로 취급한다. 보안 자체보다는 견고성 fix.
      // Status 가 'Valid' 여야 하고, Subject 에 Ollama 발행자 CN 이 포함되어야 함
      const script = `$s = Get-AuthenticodeSignature -LiteralPath ${psQuotedPath}; if ($s.Status -ne 'Valid') { Write-Output "STATUS:$($s.Status)"; exit } $subj = $s.SignerCertificate.Subject; Write-Output "OK:$subj"`;
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 30000 },
        (err, stdout) => {
          if (err) {
            resolve({ valid: false, reason: `PowerShell 실패: ${err.message}` });
            return;
          }
          const out = String(stdout).trim();
          if (out.startsWith('OK:')) {
            const subject = out.slice('OK:'.length);
            // 발행자 CN 에 "Ollama" 포함 (대소문자 무관). 여러 법인명 변형(Ollama, Ollama Inc, Ollama, Inc.) 수용.
            const isOllama = /CN=[^,]*Ollama/i.test(subject);
            if (isOllama) {
              resolve({ valid: true, subject });
            } else {
              resolve({ valid: false, subject, reason: '서명자가 Ollama 가 아님' });
            }
          } else if (out.startsWith('STATUS:')) {
            resolve({ valid: false, reason: `서명 상태: ${out.slice('STATUS:'.length)}` });
          } else {
            resolve({ valid: false, reason: `알 수 없는 출력: ${out.slice(0, 100)}` });
          }
        },
      );
    });
  }

  private async installWindows(): Promise<{ success: boolean; error?: string }> {
    const installerUrl = 'https://ollama.com/download/OllamaSetup.exe';
    const installerPath = path.join(app.getPath('temp'), 'OllamaSetup.exe');

    try {
      // 1. 인스톨러 다운로드
      this.sendProgress('Ollama 인스톨러 다운로드 중...');
      await this.downloadFile(installerUrl, installerPath);

      // 2. 다운로드 무결성 검증 (크기 + Authenticode 서명)
      this.sendProgress('다운로드 무결성 검증 중...');
      const hash = await this.computeFileHash(installerPath);
      const stat = fs.statSync(installerPath);
      if (stat.size < 1024 * 1024) { // 1MB 미만이면 비정상
        fs.unlinkSync(installerPath);
        return { success: false, error: `다운로드 파일이 비정상적으로 작습니다 (${stat.size} bytes). 네트워크를 확인 후 다시 시도해주세요. (sha256:${hash.slice(0, 16)}...)` };
      }
      // v0.17.7 (M1): Authenticode 서명 검증 — Ollama 발행자 인증서로 서명되었는지 확인
      const sig = await this.verifyInstallerSignature(installerPath);
      if (!sig.valid) {
        console.error(`[Ollama] Installer signature verification FAILED: ${sig.reason || sig.subject || 'unknown'} (sha256:${hash})`);
        fs.unlinkSync(installerPath);
        return { success: false, error: `Ollama 인스톨러 서명 검증에 실패했습니다 (${sig.reason || '알 수 없는 서명자'}). 안전을 위해 설치가 중단되었습니다. https://ollama.com 에서 직접 다운로드 후 수동 설치해주세요.` };
      }
      console.log(`[Ollama] Installer Authenticode verified: ${sig.subject}`);

      // 3. 설치 실행 (사용자가 설치 UI에서 완료할 때까지 대기)
      this.sendProgress('Ollama 설치 창이 열립니다. 설치를 완료해주세요...');
      await new Promise<void>((resolve, reject) => {
        // PowerShell 의 -Command 플래그는 뒤따르는 argv 를 단일 scriptblock 문자열로 재합치므로,
        // installerPath 에 공백/한글이 있으면 quote 정보가 소실되어 인스톨러 경로가 여러 토큰으로
        // 쪼개질 수 있다 (예: C:\Users\John Doe\...\OllamaSetup.exe). 이를 방지하기 위해
        // path 를 PowerShell single-quote literal 로 직접 감싸 하나의 command 문자열로 전달한다.
        // PowerShell single-quote 규칙: 내부 `'` 는 `''` 로 escape (path injection 방어) — 공통 헬퍼 사용.
        const psQuotedPath = psQuotePath(installerPath);
        execFile(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Start-Process -FilePath ${psQuotedPath} -Verb RunAs -Wait`,
          ],
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
          // QA(low): Windows 설치 경로(timeout 300000)와 일관되게 unzip 도 타임아웃 부여.
          // 손상·초대형 zip 또는 unzip 행(hang) 시 설치 플로우가 무한 블록되지 않도록.
          execFile('unzip', ['-l', zipPath], { timeout: 300000 }, (error, stdout) => {
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
          execFile('unzip', ['-o', zipPath, '-d', '/Applications'], { timeout: 300000 }, (error: ExecFileException | null) => {
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
        // v0.18.3 M3: req.setTimeout 핸들러에서도 WriteStream 을 파괴할 수 있도록 outer-scope 참조.
        // 이전에는 file 이 200 분기 내부 지역변수라 타임아웃 경로에서 접근 불가 → FD leak 가능성.
        let currentFile: fs.WriteStream | null = null;
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

            // response.pipe(file) 사용으로 backpressure 복구. 이전의 수동 pump
            // (file.write(chunk) 반환값 무시) 는 느린 디스크 + 빠른 네트워크에서 chunks 가
            // WriteStream 내부 버퍼에 쌓여 힙 폭주 → OOM 위험이 있었음.
            // pipe() 는 readable.pause()/resume() 로 자동 backpressure 처리.
            let downloaded = 0;
            let aborted = false;
            const file = fs.createWriteStream(dest);
            currentFile = file;

            // 다운로드 바이트 카운터 — MAX_SIZE 초과 직전에 즉시 abort.
            // 'data' 이벤트는 pipe 의 write 와 같은 턴에 발화되므로, chunk 를 더하기 전에
            // 체크하면 해당 chunk 가 디스크로 쓰이기 전에 unpipe+destroy 할 수 있다.
            // (Node 이벤트 emit 순서: readable → data 리스너들 실행 → pipe 가 내부적으로 write)
            response.on('data', (chunk: Buffer) => {
              if (aborted) return;
              if (downloaded + chunk.length > MAX_SIZE) {
                aborted = true;
                response.unpipe(file);
                response.destroy();
                file.destroy();
                safeReject(new Error('다운로드 크기가 500MB를 초과했습니다.'));
                return;
              }
              downloaded += chunk.length;
            });

            response.on('error', (err) => {
              if (aborted) return;
              aborted = true;
              file.destroy();
              safeReject(err);
            });
            file.on('error', (err) => {
              if (aborted) return;
              aborted = true;
              response.destroy();
              file.destroy();
              safeReject(err);
            });
            // 파일 flush 완료 = 다운로드 성공
            file.on('finish', () => {
              if (!aborted) safeResolve();
            });
            // 타임아웃 등으로 소켓이 파괴될 때 WriteStream 정리 (파일 디스크립터 누수 방지)
            response.on('close', () => {
              if (!aborted && !response.complete) {
                aborted = true;
                file.destroy();
                safeReject(new Error('다운로드 연결이 끊어졌습니다.'));
              }
            });

            response.pipe(file);
          } else {
            response.resume();
            safeReject(new Error(`다운로드 실패: HTTP ${response.statusCode}`));
          }
        });
        req.on('error', safeReject);
        req.setTimeout(TIMEOUT_MS, () => {
          req.destroy();
          // v0.18.3 M3: 200 분기에서 생성된 WriteStream 이 있으면 명시적으로 파괴.
          // req.destroy() → response 'close' 이벤트 전파에 의존하지 않고 즉시 FD 반환.
          currentFile?.destroy();
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
    // 진행 중인 pull 도 함께 종료 (stop() 이 앱 종료 경로의 공통 진입점)
    await this.killPullProcess();
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
      // v0.18.19 patch R32 P3: taskkill 실패(권한 거부, AV 간섭, PID 재사용 race) 시 silent
      // 처리하면 ollama.exe serve 자식 트리가 살아남아 port 11434 squat. 실패 시 fallback
      // SIGKILL + 콘솔 로그로 가시화 (R32 Surface 2 P4).
      try {
        await new Promise<void>((resolve) => {
          execFile('taskkill', ['/F', '/T', '/PID', String(proc.pid)], (err) => {
            if (err) console.warn(`[Ollama] taskkill failed for pid ${proc.pid}: ${err.message} — fallback SIGKILL`);
            resolve();
          });
        });
      } catch { /* taskkill 실패 시 무시 */ }
      try { proc.kill('SIGKILL'); } catch { /* 이미 종료됨 */ }
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

    // 재진입 가드 — 이미 pull 이 진행 중이면 두 번째 요청은 첫 번째 proc 참조를 덮어쓰지
    // 않고 즉시 실패한다. 이전 구현은 this.pullProcess 단일 슬롯에 덮어쓰기만 해서
    // 첫 번째 자식 프로세스가 killPullProcess 에서 보이지 않는 orphan 이 될 수 있었음.
    if (this.pullProcess) {
      return { success: false, error: '다른 모델 다운로드가 이미 진행 중입니다. 완료 후 다시 시도해주세요.' };
    }

    return new Promise((resolve) => {
      let settled = false;
      const safeResolve = (result: { success: boolean; error?: string }) => {
        if (!settled) { settled = true; resolve(result); }
      };

      const proc = spawn(ollamaPath, ['pull', model]);
      // 인스턴스에 등록 — 앱 종료 시 stop() 에서 kill, 고아 프로세스 방지.
      // Windows에서 부모 프로세스가 죽어도 pipe로 연결된 자식은 살아남는 문제(Node + win32)
      // 때문에 명시적 taskkill 이 필요.
      this.pullProcess = proc;
      let lastProgress = '';

      const timeout = setTimeout(() => {
        // killPullProcess 를 사용해 Windows taskkill /F /T 경로와 통일 — 향후 ollama pull 이
        // 헬퍼 자식을 spawn 하더라도 프로세스 트리 전체가 종료된다.
        this.killPullProcess().catch(() => { /* 이미 죽은 프로세스 무시 */ });
        safeResolve({ success: false, error: '모델 다운로드 타임아웃 (30분). 네트워크를 확인 후 다시 시도해주세요.' });
      }, PULL_TIMEOUT_MS);

      // ANSI 제거 · \r\n 혼용 분할 · 퍼센트/상태 매핑은 ./ollama-pull-progress 로 분리 (M5).

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
        if (this.pullProcess === proc) this.pullProcess = null;
        safeResolve({ success: false, error: `모델 다운로드 실패: ${err.message}` });
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (this.pullProcess === proc) this.pullProcess = null;
        if (code === 0) {
          safeResolve({ success: true });
        } else {
          safeResolve({ success: false, error: `모델 다운로드 실패 (exit code: ${code})` });
        }
      });
    });
  }

  /** 진행 중인 `ollama pull` 자식 프로세스를 즉시 종료. 앱 종료 직전 호출. */
  async killPullProcess(): Promise<void> {
    const proc = this.pullProcess;
    if (!proc) return;
    this.pullProcess = null;
    if (process.platform === 'win32' && proc.pid) {
      // v0.18.19 patch R32 P3: 위 stop() 과 동일 패턴 — taskkill 실패 시 SIGKILL fallback.
      try {
        await new Promise<void>((resolve) => {
          execFile('taskkill', ['/F', '/T', '/PID', String(proc.pid)], (err) => {
            if (err) console.warn(`[Ollama pull] taskkill failed for pid ${proc.pid}: ${err.message} — fallback SIGKILL`);
            resolve();
          });
        });
      } catch { /* 무시 */ }
      try { proc.kill('SIGKILL'); } catch { /* 무시 */ }
    } else {
      try { proc.kill('SIGTERM'); } catch { /* 무시 */ }
    }
  }

  /** renderer에 진행 상태 전송 */
  private sendProgress(message: string): void {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('setup:progress', message);
    }
  }
}
