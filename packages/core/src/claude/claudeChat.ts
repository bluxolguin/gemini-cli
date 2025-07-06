/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  GenerateContentResponse,
  SendMessageParameters,
  createUserContent,
  GenerateContentConfig,
} from '@google/genai';
import { ChatInterface } from '../core/chatInterface.js';
import { ClaudeContentGenerator } from './claudeClient.js';
import { Config } from '../config/config.js';

export class ClaudeChat implements ChatInterface {
  constructor(
    private readonly config: Config,
    private readonly contentGenerator: ClaudeContentGenerator,
    private readonly generationConfig: GenerateContentConfig = {},
    private history: Content[] = [],
  ) {}

  addHistory(content: Content): void {
    this.history.push(content);
  }

  getHistory(_curated?: boolean): Content[] {
    return this.history;
  }

  setHistory(history: Content[]): void {
    this.history = [...history];
  }

  async sendMessage(
    params: SendMessageParameters,
  ): Promise<GenerateContentResponse> {
    const contents = [...this.history, createUserContent(params.message)];

    const request = {
      model: 'claude-3-5-sonnet-latest', // Default Claude model
      contents,
      generationConfig: this.generationConfig,
      ...params.config,
    };

    const response = await this.contentGenerator.generateContent(request);

    // Add the user message and model response to history
    this.addHistory(createUserContent(params.message));
    if (response.candidates?.[0]?.content) {
      this.addHistory(response.candidates[0].content);
    }

    return response;
  }

  async sendMessageStream(
    params: SendMessageParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const contents = [...this.history, createUserContent(params.message)];

    const request = {
      model: 'claude-3-5-sonnet-latest', // Default Claude model
      contents,
      generationConfig: this.generationConfig,
      ...params.config,
    };

    const responseStream =
      await this.contentGenerator.generateContentStream(request);

    // Add the user message to history
    this.addHistory(createUserContent(params.message));

    let modelResponse: Content | null = null;

    async function* wrappedStream(): AsyncGenerator<GenerateContentResponse> {
      for await (const response of responseStream) {
        // Accumulate the model response for history
        if (response.candidates?.[0]?.content && !modelResponse) {
          modelResponse = response.candidates[0].content;
        }
        yield response;
      }

      // Add final model response to history
      if (modelResponse) {
        // Note: We can't access 'this' here, so the caller needs to handle this
        // For now, we'll just yield responses and let the calling code handle history
      }
    }

    return wrappedStream();
  }
}
