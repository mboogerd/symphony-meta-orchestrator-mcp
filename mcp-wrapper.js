#!/usr/bin/env node
// Wrapper that properly invokes the MCP server from anywhere
// This allows the MCP server to work correctly regardless of the calling directory
import { startMcpStdio } from './dist/mcp/stdio.js';

await startMcpStdio();
