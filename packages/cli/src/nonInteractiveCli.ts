/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  ToolCallRequestInfo,
  executeToolCall,
  ToolRegistry,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  GeminiClient,
} from '@google/gemini-cli-core';
import {
  Content,
  Part,
  FunctionCall,
  GenerateContentResponse,
} from '@google/genai';

import { parseAndFormatApiError } from './ui/utils/errorParsing.js';

function getResponseText(response: GenerateContentResponse): string | null {
  if (response.candidates && response.candidates.length > 0) {
    const candidate = response.candidates[0];
    if (
      candidate.content &&
      candidate.content.parts &&
      candidate.content.parts.length > 0
    ) {
      // We are running in headless mode so we don't need to return thoughts to STDOUT.
      const thoughtPart = candidate.content.parts[0];
      if (thoughtPart?.thought) {
        return null;
      }
      return candidate.content.parts
        .filter((part) => part.text)
        .map((part) => part.text)
        .join('');
    }
  }
  return null;
}

export async function runNonInteractive(
  config: Config,
  input: string,
): Promise<void> {
  // Handle EPIPE errors when the output is piped to a command that closes early.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      // Exit gracefully if the pipe is closed.
      process.exit(0);
    }
  });

  const geminiClient = config.getGeminiClient();
  const toolRegistry: ToolRegistry = await config.getToolRegistry();

  const abortController = new AbortController();

  try {
    // For Claude provider, use GeminiClient's sendMessageStream directly
    if (config.getProvider() === 'claude') {
      await runClaudeNonInteractive(
        geminiClient,
        input,
        abortController.signal,
      );
    } else {
      await runGeminiNonInteractive(
        geminiClient,
        toolRegistry,
        input,
        abortController.signal,
        config,
      );
    }
  } catch (error) {
    console.error(
      parseAndFormatApiError(
        error,
        config.getContentGeneratorConfig().authType,
      ),
    );
    process.exit(1);
  } finally {
    if (isTelemetrySdkInitialized()) {
      await shutdownTelemetry();
    }
  }
}

async function runClaudeNonInteractive(
  geminiClient: GeminiClient,
  input: string,
  abortSignal: AbortSignal,
): Promise<void> {
  // Use GeminiClient's sendMessageStream for Claude
  const responseStream = geminiClient.sendMessageStream(
    [{ text: input }],
    abortSignal,
  );

  for await (const event of responseStream) {
    if (abortSignal.aborted) {
      console.error('Operation cancelled.');
      return;
    }

    if (event.type === 'content') {
      process.stdout.write(event.value);
    } else if (event.type === 'error') {
      throw new Error(event.value.error.message);
    } else if (event.type === 'tool_call_request') {
      // Tool call is being executed
    } else if (event.type === 'tool_call_response') {
      // Tool response received
      if (event.value.error) {
        console.error(`Error executing tool: ${event.value.error.message}`);
      }
    }
  }

  process.stdout.write('\n'); // Ensure a final newline
}

async function runGeminiNonInteractive(
  geminiClient: GeminiClient,
  toolRegistry: ToolRegistry,
  input: string,
  abortSignal: AbortSignal,
  config: Config,
): Promise<void> {
  const chat = await geminiClient.getChat();
  let currentMessages: Content[] = [{ role: 'user', parts: [{ text: input }] }];

  while (true) {
    const functionCalls: FunctionCall[] = [];

    const responseStream = await chat.sendMessageStream({
      message: currentMessages[0]?.parts || [], // Ensure parts are always provided
      config: {
        abortSignal,
        tools: [
          { functionDeclarations: toolRegistry.getFunctionDeclarations() },
        ],
      },
    });

    for await (const resp of responseStream) {
      if (abortSignal.aborted) {
        console.error('Operation cancelled.');
        return;
      }
      const textPart = getResponseText(resp);
      if (textPart) {
        process.stdout.write(textPart);
      }
      if (resp.functionCalls) {
        functionCalls.push(...resp.functionCalls);
      }
    }

    if (functionCalls.length > 0) {
      const toolResponseParts: Part[] = [];

      for (const fc of functionCalls) {
        const callId = fc.id ?? `${fc.name}-${Date.now()}`;
        const requestInfo: ToolCallRequestInfo = {
          callId,
          name: fc.name as string,
          args: (fc.args ?? {}) as Record<string, unknown>,
          isClientInitiated: false,
        };

        const toolResponse = await executeToolCall(
          config,
          requestInfo,
          toolRegistry,
          abortSignal,
        );

        if (toolResponse.error) {
          const isToolNotFound = toolResponse.error.message.includes(
            'not found in registry',
          );
          console.error(
            `Error executing tool ${fc.name}: ${toolResponse.resultDisplay || toolResponse.error.message}`,
          );
          if (!isToolNotFound) {
            process.exit(1);
          }
        }

        if (toolResponse.responseParts) {
          const parts = Array.isArray(toolResponse.responseParts)
            ? toolResponse.responseParts
            : [toolResponse.responseParts];
          for (const part of parts) {
            if (typeof part === 'string') {
              toolResponseParts.push({ text: part });
            } else if (part) {
              toolResponseParts.push(part);
            }
          }
        }
      }
      currentMessages = [{ role: 'user', parts: toolResponseParts }];
    } else {
      process.stdout.write('\n'); // Ensure a final newline
      return;
    }
  }
}
