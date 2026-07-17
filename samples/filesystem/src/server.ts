import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'witshift-filesystem-boundary', version: '1.0.0' });

server.registerTool(
  'read_text',
  {
    description: 'Read a UTF-8 text file',
    inputSchema: { path: z.string() },
    outputSchema: { text: z.string() },
  },
  ({ path }) => ({
    content: [{ type: 'text', text: readFileSync(path, 'utf8') }],
    structuredContent: { text: readFileSync(path, 'utf8') },
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
