// @vitest-environment happy-dom

// StatusBar 행위 — Ollama 상태(실행/중지/미설치) 표시 / 비-Ollama provider 라벨 표시 /
// 버전 표시. R43 I-1 회귀 가드: gemini 가 'OpenAI' 로 오표시되지 않아야 한다.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { StatusBar } from '../StatusBar';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';

beforeEach(() => {
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, provider: 'ollama', model: 'gemma3' },
    ollamaStatus: { installed: false, running: false, models: [] },
  });
});
afterEach(() => cleanup());

describe('StatusBar', () => {
  it('Ollama 실행 중 → Running + 모델명', () => {
    useAppStore.setState({ ollamaStatus: { installed: true, running: true, models: [] } });
    render(<StatusBar />);
    expect(screen.getByText(/Running \(gemma3\)/)).toBeTruthy();
    expect(screen.getByText(/Ollama:/)).toBeTruthy();
  });

  it('설치됨 + 미실행 → 중지됨', () => {
    useAppStore.setState({ ollamaStatus: { installed: true, running: false, models: [] } });
    render(<StatusBar />);
    expect(screen.getByText(/중지됨/)).toBeTruthy();
  });

  it('미설치 → 미설치', () => {
    useAppStore.setState({ ollamaStatus: { installed: false, running: false, models: [] } });
    render(<StatusBar />);
    expect(screen.getByText(/미설치/)).toBeTruthy();
  });

  it('Ollama 버전이 있으면 표시', () => {
    useAppStore.setState({ ollamaStatus: { installed: true, running: true, models: [], version: '0.5.1' } });
    render(<StatusBar />);
    expect(screen.getByText('0.5.1')).toBeTruthy();
  });

  it('비-Ollama(gemini) provider → Gemini 라벨 + 모델 (OpenAI 로 오표시 안 함)', () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'gemini', model: 'gemini-2.0-flash' },
    });
    render(<StatusBar />);
    expect(screen.getByText(/Gemini:/)).toBeTruthy();
    expect(screen.getByText(/gemini-2\.0-flash/)).toBeTruthy();
    expect(screen.queryByText(/OpenAI:/)).toBeNull();
  });

  it('claude provider → Claude 라벨', () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'claude', model: 'claude-sonnet-4-6' },
    });
    render(<StatusBar />);
    expect(screen.getByText(/Claude:/)).toBeTruthy();
  });
});
