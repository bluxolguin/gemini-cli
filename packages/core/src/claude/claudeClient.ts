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
  FunctionCall,
  FunctionResponse,
  FinishReason,
} from '@google/genai';

export class ClaudeContentGenerator implements ContentGenerator {
  private client: Anthropic;

  constructor(apiKey: string, httpOptions?: { headers?: Record<string, string> }) {
    this.client = new Anthropic({
      apiKey,
      defaultHeaders: httpOptions?.headers,
    });
  }

  async generateContent(
    request: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    const claudeRequest = this.convertToClaudeRequest(request);
    
    try {
      const response = await this.client.messages.create(claudeRequest);
      return this.convertToGeminiResponse(response as Anthropic.Messages.Message);
    } catch (error) {
      throw new Error(`Claude API error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const claudeRequest = this.convertToClaudeRequest(request);
    
    try {
      const stream = await this.client.messages.create({
        ...claudeRequest,
        stream: true,
      });

      return this.createAsyncGenerator(stream);
    } catch (error) {
      throw new Error(`Claude streaming error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async *createAsyncGenerator(stream: any): AsyncGenerator<GenerateContentResponse> {
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        yield this.convertStreamChunkToGeminiResponse(chunk);
      }
    }
  }

  async countTokens(request: CountTokensParameters): Promise<CountTokensResponse> {
    // Claude doesn't have a direct token counting API, so we'll estimate
    // This is a rough approximation - in practice you might want to use tiktoken or similar
    const contentArray = Array.isArray(request.contents) ? request.contents : [];
    const filteredContent = contentArray.filter((item: any): item is Content => 
      typeof item === 'object' && item !== null && 'role' in item
    );
    const content = this.extractTextFromContents(filteredContent);
    const estimatedTokens = Math.ceil(content.length / 4); // Rough approximation
    
    return {
      totalTokens: estimatedTokens,
    };
  }

  async embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
    // Claude doesn't provide embeddings, you might want to use OpenAI's embedding API
    // or another service for this functionality
    throw new Error('Claude does not support embeddings. Consider using OpenAI or Google embeddings instead.');
  }

  private convertToClaudeRequest(request: GenerateContentParameters): Anthropic.Messages.MessageCreateParams {
    const messages: Anthropic.Messages.MessageParam[] = [];
    let systemMessage = '';

    // Extract system instruction if present
    if (request.config?.systemInstruction) {
      if (typeof request.config.systemInstruction === 'string') {
        systemMessage = request.config.systemInstruction;
      } else if (typeof request.config.systemInstruction === 'object' && 'text' in request.config.systemInstruction) {
        systemMessage = (request.config.systemInstruction as { text: string }).text || '';
      }
    }

    // Convert contents to Claude messages format
    const contentArray = Array.isArray(request.contents) ? request.contents : [];
    for (const contentItem of contentArray) {
      // Type guard to ensure we're working with Content objects
      if (typeof contentItem === 'object' && contentItem !== null && 'role' in contentItem) {
        const content = contentItem as Content;
        if (content.role === 'user' || content.role === 'model') {
          const messageContent: Anthropic.Messages.MessageParam['content'] = [];
          
          for (const part of content.parts || []) {
            if ('text' in part && part.text) {
              messageContent.push({
                type: 'text',
                text: part.text,
              });
            } else if ('functionCall' in part && part.functionCall && part.functionCall.name) {
              // Convert function calls to Claude's tool use format
              messageContent.push({
                type: 'tool_use',
                id: `call_${Date.now()}`,
                name: part.functionCall.name,
                input: part.functionCall.args || {},
              });
            } else if ('functionResponse' in part && part.functionResponse) {
              // Convert function responses to Claude's tool result format
              messageContent.push({
                type: 'tool_result',
                tool_use_id: `call_${Date.now()}`, // In practice, you'd need to track IDs
                content: JSON.stringify(part.functionResponse.response),
              });
            }
          }

          messages.push({
            role: content.role === 'model' ? 'assistant' : 'user',
            content: messageContent,
          });
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
                input_schema: func.parameters as any, // Convert JSON schema
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

  private convertToGeminiResponse(response: Anthropic.Messages.Message): GenerateContentResponse {
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

    const baseResponse = {
      candidates: [
        {
          content: {
            parts,
            role: 'model',
          },
          finishReason: response.stop_reason === 'end_turn' ? FinishReason.STOP : FinishReason.OTHER,
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: response.usage.input_tokens,
        candidatesTokenCount: response.usage.output_tokens,
        totalTokenCount: response.usage.input_tokens + response.usage.output_tokens,
      },
    };

    // Add the expected properties that Gemini CLI expects
    const geminiResponse = baseResponse as any;
    geminiResponse.text = parts.find(p => p.text)?.text;
    geminiResponse.data = undefined;
    geminiResponse.functionCalls = parts.filter(p => p.functionCall && p.functionCall.name).map(p => p.functionCall!);
    geminiResponse.executableCode = undefined;
    geminiResponse.codeExecutionResult = undefined;

    return geminiResponse as GenerateContentResponse;
  }

  private convertStreamChunkToGeminiResponse(chunk: any): GenerateContentResponse {
    const baseResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: chunk.delta.text || '' }],
            role: 'model',
          },
          finishReason: FinishReason.OTHER,
          index: 0,
        },
      ],
    };

    // Add the expected properties that Gemini CLI expects
    const geminiResponse = baseResponse as any;
    geminiResponse.text = chunk.delta.text || '';
    geminiResponse.data = undefined;
    geminiResponse.functionCalls = [];
    geminiResponse.executableCode = undefined;
    geminiResponse.codeExecutionResult = undefined;

    return geminiResponse as GenerateContentResponse;
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
      'gemini-2.5-pro': 'claude-3-opus-20240229',
      'gemini-2.5-flash': 'claude-3-sonnet-20240229',
      'gemini-pro': 'claude-3-sonnet-20240229',
      'gemini-flash': 'claude-3-haiku-20240307',
    };

    return modelMap[geminiModel] || 'claude-3-sonnet-20240229';
  }
}
