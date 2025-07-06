/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export enum LogLevel {
  NONE = 0,
  ERROR = 1,
  BASIC = 2,
  DETAILED = 3,
  VERBOSE = 4,
}

class ApiLogger {
  private logLevel: LogLevel;

  constructor() {
    const envLevel = process.env.GEMINI_LOG_LEVEL?.toUpperCase();
    switch (envLevel) {
      case 'NONE':
        this.logLevel = LogLevel.NONE;
        break;
      case 'ERROR':
        this.logLevel = LogLevel.ERROR;
        break;
      case 'BASIC':
        this.logLevel = LogLevel.BASIC;
        break;
      case 'DETAILED':
        this.logLevel = LogLevel.DETAILED;
        break;
      case 'VERBOSE':
        this.logLevel = LogLevel.VERBOSE;
        break;
      default:
        this.logLevel = LogLevel.BASIC; // Default level
    }
  }

  shouldLog(level: LogLevel): boolean {
    return this.logLevel >= level;
  }

  logGeminiRequest(data: unknown): void {
    if (this.shouldLog(LogLevel.BASIC)) {
      console.log(
        '🟢 GEMINI REQUEST:',
        this.shouldLog(LogLevel.DETAILED)
          ? JSON.stringify(data, null, 2)
          : this.summarizeRequestData(data),
      );
    }
  }

  logGeminiResponse(data: unknown): void {
    if (this.shouldLog(LogLevel.BASIC)) {
      console.log(
        '🟢 GEMINI RESPONSE:',
        this.shouldLog(LogLevel.DETAILED)
          ? JSON.stringify(data, null, 2)
          : this.summarizeResponseData(data),
      );
    }
  }

  logGeminiStreamRequest(data: unknown): void {
    if (this.shouldLog(LogLevel.BASIC)) {
      console.log(
        '🟢 GEMINI STREAM REQUEST:',
        this.shouldLog(LogLevel.DETAILED)
          ? JSON.stringify(data, null, 2)
          : this.summarizeRequestData(data),
      );
    }
  }

  logGeminiStreamChunk(chunkNumber: number, data: unknown): void {
    if (this.shouldLog(LogLevel.VERBOSE)) {
      console.log(
        `🟢 GEMINI STREAM CHUNK ${chunkNumber}:`,
        JSON.stringify(data, null, 2),
      );
    } else if (this.shouldLog(LogLevel.DETAILED)) {
      console.log(`🟢 GEMINI STREAM CHUNK ${chunkNumber}`);
    }
  }

  logGeminiStreamComplete(chunkCount: number): void {
    if (this.shouldLog(LogLevel.BASIC)) {
      console.log(`🟢 GEMINI STREAM COMPLETED - Total chunks: ${chunkCount}`);
    }
  }

  logGeminiError(data: unknown): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error('🔴 GEMINI API ERROR:', JSON.stringify(data, null, 2));
    }
  }

  logClaudeRequest(data: unknown): void {
    if (this.shouldLog(LogLevel.BASIC)) {
      console.log(
        '🔵 CLAUDE REQUEST:',
        this.shouldLog(LogLevel.DETAILED)
          ? JSON.stringify(data, null, 2)
          : this.summarizeClaudeRequestData(data),
      );
    }
  }

  logClaudeResponse(data: unknown): void {
    if (this.shouldLog(LogLevel.BASIC)) {
      console.log(
        '🔵 CLAUDE RESPONSE:',
        this.shouldLog(LogLevel.DETAILED)
          ? JSON.stringify(data, null, 2)
          : this.summarizeClaudeResponseData(data),
      );
    }
  }

  logClaudeStreamRequest(data: unknown): void {
    if (this.shouldLog(LogLevel.BASIC)) {
      console.log(
        '🔵 CLAUDE STREAM REQUEST:',
        this.shouldLog(LogLevel.DETAILED)
          ? JSON.stringify(data, null, 2)
          : this.summarizeClaudeRequestData(data),
      );
    }
  }

  logClaudeStreamChunk(chunkNumber: number, data: unknown): void {
    if (this.shouldLog(LogLevel.VERBOSE)) {
      console.log(
        `🔵 CLAUDE STREAM CHUNK ${chunkNumber}:`,
        JSON.stringify(data, null, 2),
      );
    } else if (this.shouldLog(LogLevel.DETAILED)) {
      console.log(`🔵 CLAUDE STREAM CHUNK ${chunkNumber}`);
    }
  }

  logClaudeStreamComplete(chunkCount: number): void {
    if (this.shouldLog(LogLevel.BASIC)) {
      console.log(`🔵 CLAUDE STREAM COMPLETED - Total chunks: ${chunkCount}`);
    }
  }

  logClaudeError(error: unknown): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error('🔴 CLAUDE API ERROR:', error);
    }
  }

  private summarizeRequestData(data: unknown): string {
    const req = data as { model: string; contentCount?: number };
    return `Model: ${req.model}, Contents: ${req.contentCount || 'unknown'}`;
  }

  private summarizeResponseData(data: unknown): string {
    const resp = data as {
      model: string;
      durationMs: number;
      usageMetadata?: unknown;
    };
    return `Model: ${resp.model}, Duration: ${
      resp.durationMs
    }ms, Usage: ${JSON.stringify(resp.usageMetadata)}`;
  }

  private summarizeClaudeRequestData(data: unknown): string {
    const req = data as { model: string; messages?: unknown[] };
    return `Model: ${req.model}, Messages: ${
      req.messages?.length || 'unknown'
    }`;
  }

  private summarizeClaudeResponseData(data: unknown): string {
    const resp = data as { model: string; usage?: unknown };
    return `Model: ${resp.model}, Usage: ${JSON.stringify(resp.usage)}`;
  }
}

export const apiLogger = new ApiLogger();
