/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  GenerateContentResponse,
  SendMessageParameters,
} from '@google/genai';

export interface ChatInterface {
  addHistory(content: Content): void;
  getHistory(curated?: boolean): Content[];
  setHistory(history: Content[]): void;
  sendMessage(params: SendMessageParameters): Promise<GenerateContentResponse>;
  sendMessageStream(
    params: SendMessageParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;
}
