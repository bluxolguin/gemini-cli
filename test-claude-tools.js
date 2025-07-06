/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* globals console, global, process, Response */

// Simple test to verify Claude tool configuration
// This checks if tools are being passed to Claude correctly

console.log('Testing Claude tool configuration...');

// Mock the API request to see what data would be sent to Claude
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (url.includes('anthropic') || url.includes('claude')) {
    console.log('\n=== CLAUDE API REQUEST INTERCEPTED ===');
    console.log('URL:', url);

    if (options && options.body) {
      const body = JSON.parse(options.body);
      console.log('Request body:', JSON.stringify(body, null, 2));

      if (body.tools) {
        console.log('\n=== TOOLS FOUND IN REQUEST ===');
        console.log('Number of tools:', body.tools.length);
        body.tools.forEach((tool, i) => {
          console.log(`Tool ${i + 1}:`, tool.name || 'unnamed');
          if (tool.input_schema) {
            console.log(
              `  Description: ${tool.description || 'no description'}`,
            );
            console.log(
              `  Parameters: ${Object.keys(tool.input_schema.properties || {}).join(', ')}`,
            );
          }
        });
      } else {
        console.log('No tools found in request body');
      }
    }

    // Return a mock response to avoid actual API call
    return new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Test intercepted - tools verified',
        },
      }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  // For non-Claude requests, use original fetch
  return originalFetch(url, options);
};

// Set a fake Claude API key and run the test
process.env.CLAUDE_API_KEY = 'sk-ant-api03-test-key';

// Import and run the CLI
import('./bundle/gemini.js');
