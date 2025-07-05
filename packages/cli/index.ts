#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import './src/gemini.js';
import { main } from './src/gemini.js';

// --- Global Entry Point ---
console.log('[DEBUG] CLI Entry point - Starting main()');
console.log('[DEBUG] CLI Entry point - Args:', process.argv);
console.log('[DEBUG] CLI Entry point - Claude API Key present:', !!process.env.CLAUDE_API_KEY);

main().catch((error) => {
  console.error('An unexpected critical error occurred:');
  if (error instanceof Error) {
    console.error(error.stack);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
