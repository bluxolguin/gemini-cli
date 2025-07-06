/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* globals console, process */

// Test script para verificar que la integración de Claude funciona
import { ClaudeContentGenerator } from './packages/core/dist/src/claude/claudeClient.js';

async function testClaude() {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.error('CLAUDE_API_KEY no está configurada');
    process.exit(1);
  }

  console.log('Probando Claude con API key:', apiKey.substring(0, 20) + '...');

  const claude = new ClaudeContentGenerator(apiKey);

  const request = {
    contents: [
      {
        role: 'user',
        parts: [{ text: '¿Cuál es la capital de España?' }],
      },
    ],
    config: {
      maxOutputTokens: 100,
      temperature: 0.7,
    },
  };

  try {
    console.log('Enviando solicitud a Claude...');
    const response = await claude.generateContent(request);
    console.log('\n🎉 ¡Respuesta de Claude!');
    console.log('Texto:', response.text);
    console.log('Uso de tokens:', response.usageMetadata);
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testClaude();
