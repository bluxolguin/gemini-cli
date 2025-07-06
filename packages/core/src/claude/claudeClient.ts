/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import Anthropic from '@anthropic-ai/sdk';
import { ContentGenerator } from '../core/contentGenerator.js';
import {
  CountTokensResponse,
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
  Content,
  Part,
  FinishReason,
} from '@google/genai';
import { apiLogger } from '../utils/apiLogger.js';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.js';

export class ClaudeContentGenerator implements ContentGenerator {
  private client: Anthropic;

  constructor(
    apiKey: string,
    httpOptions?: { headers?: Record<string, string> },
  ) {
    this.client = new Anthropic({
      apiKey,
      defaultHeaders: httpOptions?.headers,
    });
  }

  async generateContent(
    request: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    const claudeRequest = this.convertToClaudeRequest(request);

    // Log the full request being sent to Claude
    apiLogger.logClaudeRequest(claudeRequest);

    try {
      const response = await this.client.messages.create(claudeRequest);
      const messageResponse = response as Anthropic.Messages.Message;

      // Log the full response received from Claude
      apiLogger.logClaudeResponse(messageResponse);

      return this.convertToGeminiResponse(messageResponse);
    } catch (error) {
      apiLogger.logClaudeError(error);
      throw new Error(
        `Claude API error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const claudeRequest = this.convertToClaudeRequest(request);

    // Log the full streaming request being sent to Claude
    apiLogger.logClaudeStreamRequest({
      ...claudeRequest,
      stream: true,
    });

    try {
      const stream = await this.client.messages.stream(claudeRequest);

      return this.createAsyncGenerator(stream);
    } catch (error) {
      apiLogger.logClaudeError(error);
      throw new Error(
        `Claude streaming error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async *createAsyncGenerator(
    stream: MessageStream,
  ): AsyncGenerator<GenerateContentResponse> {
    let chunkCount = 0;

    try {
      for await (const chunk of stream) {
        if (
          chunk.type === 'content_block_delta' &&
          chunk.delta.type === 'text_delta'
        ) {
          chunkCount++;
          apiLogger.logClaudeStreamChunk(chunkCount, {
            type: chunk.type,
            delta: chunk.delta,
          });

          yield this.convertStreamChunkToGeminiResponse(chunk);
        } else if (
          chunk.type === 'content_block_start' &&
          chunk.content_block?.type === 'tool_use'
        ) {
          // Handle tool use - Claude wants to call a tool
          chunkCount++;
          apiLogger.logClaudeStreamChunk(chunkCount, {
            type: chunk.type,
            data: chunk.content_block,
          });

          yield this.convertToolUseToGeminiResponse(chunk.content_block);
        } else {
          // Log other chunk types but don't process them as content
          apiLogger.logClaudeStreamChunk(chunkCount, {
            type: chunk.type,
            data: chunk,
          });
        }
      }
    } catch (streamError) {
      console.error(`Error in Claude stream processing:`, streamError);
      throw streamError;
    }

    apiLogger.logClaudeStreamComplete(chunkCount);
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // Claude doesn't have a direct token counting API, so we'll estimate
    // This is a rough approximation - in practice you might want to use tiktoken or similar
    const contentArray = Array.isArray(request.contents)
      ? request.contents
      : [];
    const filteredContent = contentArray.filter(
      (item): item is Content =>
        typeof item === 'object' && item !== null && 'role' in item,
    );
    const content = this.extractTextFromContents(filteredContent);
    const estimatedTokens = Math.ceil(content.length / 4); // Rough approximation

    return {
      totalTokens: estimatedTokens,
    };
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    // Claude doesn't provide embeddings, you might want to use OpenAI's embedding API
    // or another service for this functionality
    throw new Error(
      'Claude does not support embeddings. Consider using OpenAI or Google embeddings instead.',
    );
  }

  private convertToClaudeRequest(
    request: GenerateContentParameters,
  ): Anthropic.Messages.MessageCreateParams {
    const messages: Anthropic.Messages.MessageParam[] = [];
    let systemMessage = '';

    // Keep track of tool call IDs to match tool_use with tool_result
    const toolCallIdMap = new Map<string, string>();

    // Extract system instruction if present
    if (request.config?.systemInstruction) {
      if (typeof request.config.systemInstruction === 'string') {
        systemMessage = request.config.systemInstruction;
      } else if (
        typeof request.config.systemInstruction === 'object' &&
        'text' in request.config.systemInstruction
      ) {
        systemMessage =
          (request.config.systemInstruction as { text: string }).text || '';
      }
    }

    // Convert contents to Claude messages format
    const contentArray = Array.isArray(request.contents)
      ? request.contents
      : [];
    for (const contentItem of contentArray) {
      // Type guard to ensure we're working with Content objects
      if (
        typeof contentItem === 'object' &&
        contentItem !== null &&
        'role' in contentItem
      ) {
        const content = contentItem as Content;
        if (content.role === 'user' || content.role === 'model') {
          const messageContent: Anthropic.Messages.MessageParam['content'] = [];

          for (const part of content.parts || []) {
            if ('text' in part && part.text) {
              messageContent.push({
                type: 'text',
                text: part.text,
              });
            } else if (
              'functionCall' in part &&
              part.functionCall &&
              part.functionCall.name
            ) {
              // Convert function calls to Claude's tool use format
              const toolUseId =
                part.functionCall.id ||
                `call_${Date.now()}_${Math.random().toString(16).slice(2)}`;
              toolCallIdMap.set(part.functionCall.name, toolUseId);

              messageContent.push({
                type: 'tool_use',
                id: toolUseId,
                name: part.functionCall.name,
                input:
                  (part.functionCall.args as Record<string, unknown>) || {},
              });
            } else if ('functionResponse' in part && part.functionResponse) {
              // Convert function responses to Claude's tool result format
              // Use the stored tool ID if available, otherwise generate one
              const toolUseId =
                (part.functionResponse as { toolUseId: string }).toolUseId ||
                `call_${Date.now()}_${Math.random().toString(16).slice(2)}`;

              messageContent.push({
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: JSON.stringify(part.functionResponse.response),
              });
            }
          }

          if (messageContent.length > 0) {
            messages.push({
              role: content.role === 'model' ? 'assistant' : 'user',
              content: messageContent,
            });
          }
        }
      }
    }

    // Convert tools if present
    const tools: Anthropic.Messages.Tool[] = [];
    if (request.config?.tools) {
      for (const tool of request.config.tools) {
        if ('functionDeclarations' in tool && tool.functionDeclarations) {
          for (const func of tool.functionDeclarations) {
            if (func.name) {
              tools.push({
                name: func.name,
                description: func.description || '',
                input_schema: func.parameters as unknown as Anthropic.Messages.Tool.InputSchema, // Convert JSON schema
              });
            }
          }
        }
      }
    }

    const claudeRequest: Anthropic.Messages.MessageCreateParams = {
      model: this.mapModelName(request.model || 'claude-3-sonnet-20240229'),
      max_tokens: request.config?.maxOutputTokens || 4096,
      temperature: request.config?.temperature || 0,
      messages,
    };

    if (systemMessage) {
      claudeRequest.system = systemMessage;
    }

    if (tools.length > 0) {
      claudeRequest.tools = tools;
    }

    return claudeRequest;
  }

  private convertToGeminiResponse(
    response: Anthropic.Messages.Message,
  ): GenerateContentResponse {
    const parts: Part[] = [];

    for (const content of response.content) {
      if (content.type === 'text') {
        parts.push({ text: content.text });
      } else if (content.type === 'tool_use') {
        parts.push({
          functionCall: {
            name: content.name,
            args: content.input as Record<string, unknown>,
          },
        });
      }
    }

    const geminiResponse: GenerateContentResponse = {
      candidates: [
        {
          content: {
            parts,
            role: 'model',
          },
          finishReason:
            response.stop_reason === 'end_turn'
              ? FinishReason.STOP
              : FinishReason.OTHER,
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: response.usage.input_tokens,
        candidatesTokenCount: response.usage.output_tokens,
        totalTokenCount:
          response.usage.input_tokens + response.usage.output_tokens,
      },
      text: parts.find((p) => p.text)?.text,
      data: undefined,
      functionCalls: parts
        .filter((p) => p.functionCall && p.functionCall.name)
        .map(
          (p) =>
            p.functionCall as { name: string; args: Record<string, unknown> },
        ),
      executableCode: undefined,
      codeExecutionResult: undefined,
    };

    return geminiResponse;
  }

  private convertStreamChunkToGeminiResponse(
    chunk: Anthropic.Messages.ContentBlockDeltaEvent,
  ): GenerateContentResponse {
    const geminiResponse: GenerateContentResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: (
                  chunk.delta as Anthropic.Messages.TextDelta
                ).text || '',
              },
            ],
            role: 'model',
          },
          finishReason: FinishReason.OTHER,
          index: 0,
        },
      ],
      text: (chunk.delta as Anthropic.Messages.TextDelta).text || '',
      data: undefined,
      functionCalls: undefined,
      executableCode: undefined,
      codeExecutionResult: undefined,
    };

    return geminiResponse;
  }

  private convertToolUseToGeminiResponse(
    toolUse: Anthropic.Messages.ToolUseBlock,
  ): GenerateContentResponse {
    return {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: toolUse.name,
                  args: toolUse.input as Record<string, unknown>,
                  id: toolUse.id, // Use Claude's actual tool ID
                },
              },
            ],
          },
        },
      ],
      functionCalls: [
        {
          name: toolUse.name,
          args: toolUse.input as Record<string, unknown>,
          id: toolUse.id, // Use Claude's actual tool ID
        },
      ],
      text: '',
      data: undefined,
      executableCode: undefined,
      codeExecutionResult: undefined,
    };
  }

  private extractTextFromContents(contents: Content[]): string {
    let text = '';
    for (const content of contents) {
      for (const part of content.parts || []) {
        if ('text' in part && part.text) {
          text += part.text + ' ';
        }
      }
    }
    return text.trim();
  }

  private mapModelName(geminiModel: string): string {
    // Map Gemini model names to Claude model names
    const modelMap: Record<string, string> = {
      'gemini-2.5-pro': 'claude-sonnet-4-20250514',
      'gemini-2.5-flash': 'claude-3-5-haiku-20241022',
      'gemini-pro': 'claude-sonnet-4-20250514',
      'gemini-flash': 'claude-3-5-haiku-20241022',
    };

    // If it's already a Claude model name, return it as-is
    if (geminiModel.startsWith('claude-')) {
      return geminiModel;
    }

    return modelMap[geminiModel] || 'claude-sonnet-4-20250514'; // Default to Claude Sonnet 4
  }
}